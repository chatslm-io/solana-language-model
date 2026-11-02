import { approvedTestSigner } from "../../tests/approved-test-signer";
/** Exact paired-VM conformance and resource profiling; immutable model pages are
 * explicit genesis fixtures. This is not model-upload or RPC-finality evidence. */
import test from "node:test";
import assert from "node:assert/strict";
import { lamports, type Address, type Instruction } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { prepareModelFixture } from "../harness/model-fixture";
import { createLifecycleHarness } from "../harness/local-sbf";
import { planBatches } from "../compiler/batches";
import { executionInstruction } from "../execution-mode";
import { decodeCommand } from "../protocol";
import { loadPublicReference } from "../reference/deepseek2";
const progress = (message: string) =>
  process.stderr.write(`[batch SBF] ${message}\n`);
let prepared: ReturnType<typeof prepareModelFixture> | undefined;
async function model() {
  prepared ??= prepareModelFixture(
    undefined,
    progress,
    undefined,
    await approvedTestSigner(),
  );
  return prepared;
}
async function vm(versioned = false) {
  const f = await model(),
    h = await createLifecycleHarness();
  h.svm.airdrop(f.signer.address, lamports(100000000000n));
  for (const a of f.accounts)
    h.svm.setAccount({
      address: a.address,
      data: a.data,
      programAddress: f.program,
      lamports: lamports(a.lamports),
      space: BigInt(a.data.length),
      executable: false,
    });
  const initialBalance = h.svm.getBalance(f.signer.address)!;
  let transactions = 0,
    maxCu = 0,
    maxWire = 0;
  const get = (a: Address) => {
    const value = h.svm.getAccount(a);
    assert.ok(value.exists);
    return Buffer.from(value.data);
  };
  const execute = async (ix: Instruction, batch = false) => {
    const r = await h.execute(
      versioned ? executionInstruction(ix, 0) : ix,
      f.signer,
      batch ? 1200000 : 200000,
    );
    transactions++;
    maxWire = Math.max(maxWire, r.wireBytes);
    return r;
  };
  const send = async (ix: Instruction, batch = false) => {
    const { result, wireBytes } = await execute(ix, batch);
    if (result instanceof FailedTransactionMetadata)
      assert.fail(`SBF ${result.err()} ${result.meta().logs().join(" ")}`);
    if (versioned) {
      const report = Buffer.from(result.returnData().data());
      assert.equal(report.length, 64);
      assert.equal(report[6], 0);
      const session = h.svm.getAccount(f.client.session);
      if (session.exists) {
        const data = Buffer.from(session.data);
        assert.deepEqual(report.subarray(24, 56), data.subarray(208, 240));
        assert.deepEqual(report.subarray(56, 60), data.subarray(184, 188));
        assert.deepEqual(report.subarray(60, 64), data.subarray(248, 252));
      } else assert.ok(report.subarray(24).every((v) => v === 0));
    }
    const cu = Number(result.computeUnitsConsumed());
    assert.ok(cu <= (batch ? 1200000 : 200000));
    assert.ok(wireBytes <= 1232);
    maxCu = Math.max(maxCu, cu);
    return cu;
  };
  const begin = async (prompt: readonly number[], outputs: number) => {
    await send(
      f.client.createSession(prompt, outputs, h.svm.getClock().slot + 1000000n),
    );
    for (let i = 0; i < 5; i++) await send(f.client.allocateState(i));
    await send(f.client.start());
  };
  const snapshots = () => [f.client.session, ...f.client.states].map(get);
  const recover = async () => {
    for (let i = 0; i < 5; i++) await send(f.client.closeState(i));
    await send(f.client.closeSession());
    for (const a of [f.client.session, ...f.client.states])
      assert.equal(h.svm.getAccount(a).exists, false);
    assert.equal(
      h.svm.getBalance(f.signer.address),
      initialBalance - BigInt(transactions) * 5000n,
    );
  };
  return {
    f,
    h,
    get,
    execute,
    send,
    begin,
    snapshots,
    recover,
    metrics: () => ({ transactions, maxCu, maxWire }),
  };
}
function floats(values: readonly number[]) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
  return bytes;
}
function equalStates(actual: Buffer[], expected: Buffer[], where: string) {
  assert.equal(actual.length, expected.length);
  actual.forEach((bytes, i) =>
    assert.ok(
      bytes.equals(expected[i]),
      `${where}: account${i} state/transcript mismatch`,
    ),
  );
}

test(
  "max8-command batches match every unbatched state/transcript boundary and independent full-model logits",
  { timeout: 180000 },
  async () => {
    const f = await model(),
      batches = planBatches(f.compiled.commands);
    let worst = { cu: 0, start: 0, count: 0, ops: [] as number[] };
    for (const [caseIndex, scenario] of [
      { prompt: [1], outputs: 2 },
      { prompt: [8193, 2048], outputs: 1 },
      { prompt: [1, 42, 8194], outputs: 1 },
    ].entries()) {
      const single = await vm(),
        batched = await vm(true);
      await single.begin(scenario.prompt, scenario.outputs);
      await batched.begin(scenario.prompt, scenario.outputs);
      equalStates(batched.snapshots(), single.snapshots(), "initial");
      const trace: {
        position: number;
        layer: number;
        phase: string;
        values: readonly number[];
      }[] = [];
      const reference = await loadPublicReference(
        f.compiled.modelBytes,
        "ggml-scalar-reference",
        (event) => trace.push(event),
      );
      let previous = 0,
        logitsCompared = 0,
        layersCompared = 0,
        kvCompared = 0;
      const forwards = scenario.prompt.length + scenario.outputs - 1;
      for (let position = 0; position < forwards; position++) {
        trace.length = 0;
        const input =
          position < scenario.prompt.length
            ? scenario.prompt[position]
            : previous;
        const expected = reference.step(input);
        previous = expected.token;
        let residuals = 0;
        for (const batch of batches) {
          const batchIx = await f.client.batch(
            batched.get(f.client.session),
            batched.get(f.client.states[0]),
            f.compiled.commands.slice(batch.start, batch.start + batch.count),
            f.compiled.weights.pages.length,
          );
          for (let pc = batch.start; pc < batch.start + batch.count; pc++) {
            const c = decodeCommand(f.compiled.commands[pc]);
            await single.send(
              await f.client.step(
                single.get(f.client.session),
                single.get(f.client.states[0]),
                f.compiled.commands[pc],
                f.compiled.weights.pages.length,
              ),
            );
            const global = single.get(f.client.states[0]);
            if (c.op === 10) {
              const expectedKv = trace.find(
                (e) => e.layer === c.aux0 && e.phase === "kv",
              )!.values;
              assert.ok(
                single
                  .get(f.client.states[c.aux0 + 1])
                  .subarray(
                    192 + position * 48 * 4,
                    192 + (position + 1) * 48 * 4,
                  )
                  .equals(floats(expectedKv)),
                "KV independent reference parity",
              );
              kvCompared++;
            }
            if (c.op === 7 && c.src === 0 && c.aux0 === 128 && c.dst === 0) {
              residuals++;
              if (residuals % 2 === 0) {
                assert.ok(
                  global
                    .subarray(192, 192 + 128 * 4)
                    .equals(
                      floats(
                        trace.find(
                          (e) =>
                            e.layer === residuals / 2 - 1 &&
                            e.phase === "layer-output",
                        )!.values,
                      ),
                    ),
                  "layer independent reference parity",
                );
                layersCompared++;
              }
            }
            if (c.op === 19) {
              assert.ok(
                global
                  .subarray(192 + c.dst * 4, 192 + (c.dst + c.rows) * 4)
                  .equals(
                    floats(
                      expected.logits.slice(c.rowStart, c.rowStart + c.rows),
                    ),
                  ),
                "all-logit independent reference parity",
              );
              logitsCompared += c.rows;
            }
          }
          const cu = await batched.send(batchIx, true);
          if (cu > worst.cu)
            worst = {
              cu,
              start: batch.start,
              count: batch.count,
              ops: f.compiled.commands
                .slice(batch.start, batch.start + batch.count)
                .map((bytes) => decodeCommand(bytes).op),
            };
          equalStates(
            batched.snapshots(),
            single.snapshots(),
            `case${caseIndex} position${position} batch${batch.start}`,
          );
        }
        if (position >= scenario.prompt.length - 1) {
          const output = position - scenario.prompt.length + 1;
          assert.equal(
            batched.get(f.client.session).readUInt32LE(320 + output * 4),
            expected.token,
          );
        }
        single.h.restart();
        batched.h.restart();
        progress(
          `Paired case${caseIndex + 1}, forward${position + 1}/${forwards}: every batch state/hash matches`,
        );
      }
      assert.equal(logitsCompared, forwards * 8196);
      assert.equal(layersCompared, forwards * 4);
      assert.equal(kvCompared, forwards * 4);
      await single.recover();
      await batched.recover();
      progress(
        JSON.stringify({
          scope: "paired exact transcript/full logits",
          caseIndex,
          forwards,
          commandsPerForward: f.compiled.commands.length,
          batchesPerForward: batches.length,
          unbatched: single.metrics(),
          batched: batched.metrics(),
          refundVerified: true,
        }),
      );
    }
    progress(
      JSON.stringify({
        scope: "paired max batch",
        ...worst,
        limit: 1200000,
        heapBytes: 32768,
      }),
    );
  },
);

test(
  "batched full model reaches15-token attention context with exact independent token and retained layer state",
  { timeout: 180000 },
  async () => {
    const x = await vm(),
      { f, get, send, begin, recover } = x,
      prompt = Array.from({ length: 15 }, (_, i) =>
        i % 3 === 0 ? 8193 : 1 + i,
      );
    await begin(prompt, 1);
    const trace: { layer: number; phase: string; values: readonly number[] }[] =
      [];
    const reference = await loadPublicReference(
        f.compiled.modelBytes,
        "ggml-scalar-reference",
        (event) => trace.push(event),
      ),
      batches = planBatches(f.compiled.commands);
    let worst = { cu: 0, start: 0, position: 0, count: 0, ops: [] as number[] },
      expected = 0;
    for (let position = 0; position < 15; position++) {
      trace.length = 0;
      expected = reference.step(prompt[position]).token;
      for (const batch of batches) {
        const cu = await send(
          await f.client.batch(
            get(f.client.session),
            get(f.client.states[0]),
            f.compiled.commands.slice(batch.start, batch.start + batch.count),
            f.compiled.weights.pages.length,
          ),
          true,
        );
        if (cu > worst.cu)
          worst = {
            cu,
            start: batch.start,
            position,
            count: batch.count,
            ops: f.compiled.commands
              .slice(batch.start, batch.start + batch.count)
              .map((bytes) => decodeCommand(bytes).op),
          };
      }
      assert.equal(get(f.client.session).readUInt32LE(188), position + 1);
      for (let layer = 0; layer < 4; layer++)
        assert.ok(
          get(f.client.states[layer + 1])
            .subarray(192 + position * 48 * 4, 192 + (position + 1) * 48 * 4)
            .equals(
              floats(
                trace.find(
                  (event) => event.layer === layer && event.phase === "kv",
                )!.values,
              ),
            ),
          "context-bound KV exact reference parity",
        );
      assert.ok(
        get(f.client.states[0])
          .subarray(192, 192 + 128 * 4)
          .equals(
            floats(
              trace.find(
                (event) => event.layer === 3 && event.phase === "layer-output",
              )!.values,
            ),
          ),
        "context-bound final hidden exact reference parity",
      );
      progress(
        `Context-bound forward${position + 1}/15 complete; worst${worst.cu} CU`,
      );
    }
    assert.equal(get(f.client.session)[10], 3);
    assert.equal(get(f.client.session).readUInt32LE(320), expected);
    await recover();
    progress(
      JSON.stringify({
        scope: "15-forward attention bound",
        ...worst,
        ...x.metrics(),
        refundVerified: true,
        heapBytes: 32768,
        cuLimit: 1200000,
      }),
    );
  },
);

test(
  "malformed batches and compute exhaustion roll back every mutable account and permit exact replay rejection and recovery",
  { timeout: 120000 },
  async () => {
    const x = await vm(),
      { f, get, send, execute, begin, snapshots, recover } = x;
    await begin([1], 1);
    const first = planBatches(f.compiled.commands)[0],
      good = await f.client.batch(
        get(f.client.session),
        get(f.client.states[0]),
        f.compiled.commands.slice(0, first.count),
        f.compiled.weights.pages.length,
      );
    const fail = async (ix: Instruction, high = true) => {
      const before = snapshots(),
        { result } = await execute(ix, high);
      assert.ok(result instanceof FailedTransactionMetadata);
      equalStates(snapshots(), before, "failed batch atomic rollback");
      return result;
    };
    const changed = (edit: (bytes: Buffer) => void) => {
      const data = Buffer.from(good.data!);
      edit(data);
      return { ...good, data };
    };
    await fail(changed((data) => data.writeUInt32LE(1, 1)));
    await fail(changed((data) => data.writeUInt32LE(1, 5)));
    await fail(changed((data) => (data[9] ^= 1)));
    await fail(changed((data) => (data[41] = 9)));
    await fail(changed((data) => (data[42] = 254)));
    const reordered = [...good.accounts!];
    [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
    await fail({ ...good, accounts: reordered });
    const wrong = [...good.accounts!],
      data = Buffer.from(good.data!);
    let weightIndex = -1;
    for (let i = 1; i < first.count; i++)
      if (data[42 + i * 3 + 1] !== 255) {
        weightIndex = data[42 + i * 3 + 1];
        break;
      }
    assert.ok(weightIndex >= 4);
    wrong[weightIndex] = {
      ...wrong[weightIndex],
      address: await f.client.artifact(f.compiled.weights.pages.length - 1),
    };
    assert.equal(new Set(wrong.map((a) => a.address)).size, wrong.length);
    await fail({ ...good, accounts: wrong });
    const exhausted = await fail(good, false);
    assert.match(
      String(exhausted.err()) + exhausted.meta().logs().join(" "),
      /ComputationalBudgetExceeded|exceeded CUs|compute budget|computational budget|ProgramFailedToComplete/i,
    );
    const cu = await send(good, true);
    assert.ok(cu > 200000);
    await fail(good);
    await recover();
    progress(
      JSON.stringify({
        scope: "batch rollback",
        validFirstBatchCu: cu,
        malformedAndBudgetFailures: 9,
        refundVerified: true,
        ...x.metrics(),
      }),
    );
  },
);

test(
  "a ROUTE command cannot be followed by commands using newly selected experts in the same batch",
  { timeout: 120000 },
  async () => {
    const x = await vm(),
      { f, get, send, execute, begin, snapshots, recover } = x;
    await begin([1], 1);
    const route = f.compiled.commands.findIndex(
      (bytes) => decodeCommand(bytes).op === 14,
    );
    assert.ok(route > 0);
    for (let pc = 0; pc < route; pc++)
      await send(
        await f.client.step(
          get(f.client.session),
          get(f.client.states[0]),
          f.compiled.commands[pc],
          f.compiled.weights.pages.length,
        ),
      );
    const good = await f.client.batch(
      get(f.client.session),
      get(f.client.states[0]),
      [f.compiled.commands[route]],
      f.compiled.weights.pages.length,
    );
    // The next immutable command is ZERO. Its map needs only the same plan page,
    // so this mutation isolates the ROUTE-last rule rather than bad account indices.
    assert.equal(decodeCommand(f.compiled.commands[route + 1]).op, 18);
    assert.equal(Math.floor(route / 128), Math.floor((route + 1) / 128));
    const data = Buffer.concat([
      Buffer.from(good.data!),
      Buffer.of(good.data![42], 255, 255),
    ]);
    data[41] = 2;
    const before = snapshots(),
      { result } = await execute({ ...good, data }, true);
    assert.ok(result instanceof FailedTransactionMetadata);
    equalStates(snapshots(), before, "ROUTE boundary rejected atomically");
    await send(good, true);
    await recover();
    progress(
      `ROUTE boundary rejection/recovery passed at immutable PC${route}`,
    );
  },
);
