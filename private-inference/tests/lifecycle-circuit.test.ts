import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { CircuitBuilder } from "../compiler/circuit";
import { prepareCircuit } from "../client/circuit";
import {
  encodeSession,
  sessionCommitment,
  pageCommitment,
  pagesCommitment,
  encodeStep,
  type SessionBinding,
} from "../protocol";
import { createLifecycleHarness } from "../harness/local-sbf";
import { verifyCompletedCircuitBytes } from "../protocol/circuit-state";
import { recoveryPlan } from "../coordinator/recovery";
const system = address("11111111111111111111111111111111"),
  encoder = getAddressEncoder();
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const encAddress = (a: Address) => Uint8Array.from(encoder.encode(a));
const hex = (a: Address) => Buffer.from(encoder.encode(a)).toString("hex");
const zero = "00".repeat(32);
type Harness = Awaited<ReturnType<typeof createLifecycleHarness>>;
function bytes(h: Harness, a: Address) {
  const value = h.svm.getAccount(a);
  assert.ok(value.exists);
  assert.equal(value.programAddress, h.program);
  return Buffer.from(value.data);
}
const bits = (n: number) =>
  Array.from({ length: 8 }, (_, i) => Boolean(((n & 255) >> i) & 1));
const unsigned = (b: readonly boolean[]) =>
  b.reduce((n, x, i) => n + (x ? 2 ** i : 0), 0);
async function setup(left = -128, right = 127, maximum = false) {
  const h = await createLifecycleHarness("circuit"),
    nonce = randomBytes(32),
    builder = new CircuitBuilder(maximum ? 64 : 16);
  const a = Array.from({ length: 8 }, (_, i) => i),
    b = Array.from({ length: 8 }, (_, i) => i + 8);
  let graph;
  if (maximum) {
    let wire = 0;
    for (let i = 0; i < 192; i++) wire = builder.and(wire, 1);
    graph = builder.finish(Array.from({ length: 32 }, (_, i) => 224 + i));
  } else {
    const less = builder.signedLess(a, b),
      sum = builder.add(a, b),
      select = builder.muxWord(less, a, b);
    graph = builder.finish([less, ...sum, ...select]);
  }
  const key = await prepareCircuit(graph, nonce),
    artifact = Buffer.from(
      key.encode(
        maximum ? Array(64).fill(false) : [...bits(left), ...bits(right)],
      ),
    );
  const chunks: Buffer[] = [];
  for (let i = 0; i < artifact.length; i += 8192)
    chunks.push(artifact.subarray(i, i + 8192));
  const binding: SessionBinding = {
    genesis: zero,
    program: hex(h.program),
    codeHash: zero,
    owner: hex(h.owner.address),
    executor: hex(h.other.address),
    sessionNonce: nonce.toString("hex"),
    deployment: zero,
    storageManifest: zero,
    modelPlanRoot: zero,
    paramsRoot: zero,
    evalKeyRoot: zero,
    inputRoot: pagesCommitment(chunks.map((c, i) => pageCommitment(i, 1, c))),
    inputBound: graph.inputCount,
    outputBound: graph.outputs.length,
    maxSteps: Math.ceil(graph.gates.length / 32),
    expirySlot: h.svm.getClock().slot + 100000n,
  };
  const [session] = await getProgramDerivedAddress({
    programAddress: h.program,
    seeds: [
      Buffer.from("slm-pi-session"),
      encoder.encode(h.owner.address),
      nonce,
    ],
  });
  const pages = await Promise.all(
    chunks.map(
      async (_, i) =>
        (
          await getProgramDerivedAddress({
            programAddress: h.program,
            seeds: [
              Buffer.from("slm-pi-page"),
              encoder.encode(session),
              u32(i),
            ],
          })
        )[0],
    ),
  );
  const [scratch, scratchBump] = await getProgramDerivedAddress({
    programAddress: h.program,
    seeds: [Buffer.from("slm-pi-wires"), encoder.encode(session)],
  });
  const ix = (
    data: Uint8Array,
    extras: Address[] = [],
    who = h.owner.address,
  ): Instruction => ({
    programAddress: h.program,
    accounts: [
      { address: who, role: AccountRole.WRITABLE_SIGNER },
      { address: session, role: AccountRole.WRITABLE },
      ...extras.map((a) => ({
        address: a,
        role: a === system ? AccountRole.READONLY : AccountRole.WRITABLE,
      })),
    ],
    data,
  });
  const run = async (instruction: Instruction, signer = h.owner) => {
    const { result, wireBytes } = await h.execute(instruction, signer);
    if (result instanceof FailedTransactionMetadata)
      assert.fail(
        result.err().toString() + " " + result.meta().logs().join("\n"),
      );
    assert.ok(result.computeUnitsConsumed() <= 200000n);
    assert.ok(wireBytes <= 1232);
    return result;
  };
  await run(
    ix(
      Buffer.concat([
        Buffer.from([0]),
        encodeSession(binding),
        u32(pages.length),
        u64(100_000_000n),
      ]),
      [system],
    ),
  );
  for (let i = 0; i < pages.length; i++) {
    await run(
      ix(
        Buffer.concat([
          Buffer.from([1]),
          u32(i),
          u32(1),
          u32(chunks[i].length),
          Buffer.from(pageCommitment(i, 1, chunks[i]), "hex"),
          u64(100_000_000n),
        ]),
        [pages[i], system],
      ),
    );
    for (let offset = 0; offset < chunks[i].length; offset += 700)
      await run(
        ix(
          Buffer.concat([
            Buffer.from([2]),
            u32(offset),
            chunks[i].subarray(offset, offset + 700),
          ]),
          [pages[i]],
        ),
      );
    await run(ix(Buffer.from([3]), [pages[i]]));
  }
  await run(ix(Buffer.from([4]), pages));
  const init = () =>
    ix(Buffer.concat([Buffer.from([9]), u64(100_000_000n)]), [
      scratch,
      system,
      ...pages,
    ]);
  const step = (
    seq: number,
    work = Math.min(32, graph.gates.length - seq * 32),
  ) =>
    ix(
      Buffer.concat([
        Buffer.from([5]),
        encodeStep({
          bindingHash: sessionCommitment(binding),
          expectedStateRoot: bytes(h, session)
            .subarray(176, 208)
            .toString("hex"),
          sequence: seq,
          workUnits: work,
        }),
      ]),
      [scratch, ...pages],
    );
  return {
    h,
    key,
    artifact,
    graph,
    binding,
    session,
    pages,
    scratch,
    scratchBump,
    ix,
    init,
    step,
    run,
  };
}
async function failed(h: Harness, ix: Instruction) {
  assert.ok((await h.execute(ix)).result instanceof FailedTransactionMetadata);
}
async function recover(f: Awaited<ReturnType<typeof setup>>) {
  const accounts = [...f.pages, f.scratch, f.session].flatMap((a) => {
    const v = f.h.svm.getAccount(a);
    return v.exists
      ? [{ address: a, owner: f.h.program, data: v.data, lamports: v.lamports }]
      : [];
  });
  const plan = await recoveryPlan(f.h.program, f.h.owner.address, accounts);
  const balance = f.h.svm.getBalance(f.h.owner.address)!;
  for (const ix of plan.instructions) await f.run(ix);
  assert.equal(
    f.h.svm.getBalance(f.h.owner.address)! - balance,
    plan.refundableLamports - BigInt(plan.instructions.length) * 5000n,
  );
  for (const a of [...f.pages, f.scratch, f.session])
    assert.equal(f.h.svm.getAccount(a).exists, false);
}
test("compiled SBF evaluates compiler-produced signed comparator/add/mux over persisted wires with resume and full refund", async () => {
  for (const [a, b] of [
    [-128, 127],
    [127, -128],
    [-1, -1],
    [0, 1],
  ]) {
    const f = await setup(a, b);
    try {
      const init = await f.run(f.init());
      let worst = 0n;
      for (let i = 0; i < f.binding.maxSteps; i++) {
        const ix = f.step(i);
        const result = await f.run(ix);
        worst =
          result.computeUnitsConsumed() > worst
            ? result.computeUnitsConsumed()
            : worst;
        f.h.restart();
        await failed(f.h, ix);
      }
      const sd = bytes(f.h, f.session),
        wd = bytes(f.h, f.scratch);
      assert.equal(sd[10], 3);
      assert.equal(wd[10], 3);
      assert.equal(wd.readUInt32LE(156), f.graph.gates.length);
      assert.equal(
        sd.subarray(176, 208).toString("hex"),
        wd.subarray(160, 192).toString("hex"),
      );
      assert.equal(
        sd.subarray(112, 144).toString("hex"),
        sessionCommitment(f.binding),
      );
      assert.equal(sd.subarray(144, 176).toString("hex"), f.binding.inputRoot);
      const verifiedArgs = {
        scratch: wd,
        session: sd,
        sessionAddress: encAddress(f.session),
        scratchBump: f.scratchBump,
        artifact: f.artifact,
      };
      const labels = await verifyCompletedCircuitBytes(verifiedArgs);
      for (const offset of [
        0, 10, 11, 48, 80, 112, 144, 148, 152, 156, 160, 192, 256,
      ]) {
        const altered = Uint8Array.from(wd);
        altered[offset] ^= 1;
        await assert.rejects(
          verifyCompletedCircuitBytes({ ...verifiedArgs, scratch: altered }),
          /invalid_circuit_result/,
        );
      }
      const out = f.key.decode(labels);
      assert.equal(out[0], a < b);
      assert.equal(unsigned(out.slice(1, 9)), (a + b) & 255);
      assert.equal(unsigned(out.slice(9, 17)), Math.min(a, b) & 255);
      await recover(f);
      console.log(
        JSON.stringify({
          scope: "real encrypted compiled comparator/add/mux",
          artifactBytes: f.artifact.length,
          pages: f.pages.length,
          gates: f.graph.gates.length,
          steps: f.binding.maxSteps,
          initCu: Number(init.computeUnitsConsumed()),
          worstStepCu: Number(worst),
          refundVerified: true,
        }),
      );
    } finally {
      f.key.destroy();
    }
  }
});
test("circuit SBF rejects work/root/page substitutions and duplicate init; owner recovers scratch after cancellation without pages", async () => {
  const f = await setup(0,0,true);
  try {
    await f.run(f.init());
    await failed(f.h, f.init());
    await failed(f.h, f.step(0, 1));
    const wrong = f.step(0);
    const d = Buffer.from(wrong.data!);
    d[41] ^= 1;
    await failed(f.h, { ...wrong, data: d });
    const reordered = {
      ...f.step(0),
      accounts: [
        ...f.step(0).accounts!.slice(0, 3),
        ...f.step(0).accounts!.slice(3).reverse(),
      ],
    };
    await failed(f.h, reordered);
    await f.run(f.step(0));
    await f.run(f.ix(Buffer.from([6])));
    for (const page of f.pages) await f.run(f.ix(Buffer.from([7]), [page]));
    await failed(f.h, f.ix(Buffer.from([8])));
    await f.run(f.ix(Buffer.from([10]), [f.scratch]));
    await f.run(f.ix(Buffer.from([8])));
  } finally {
    f.key.destroy();
  }
});

test("maximum 17600-byte artifact and256wire scratch execute192real AND gates under unchanged budgets", async () => {
  const f = await setup(0, 0, true);
  try {
    assert.equal(f.artifact.length, 17600);
    assert.equal(f.pages.length, 3);
    const init = await f.run(f.init());
    let worst = 0n;
    for (let i = 0; i < 6; i++) {
      const r = await f.run(f.step(i));
      if (r.computeUnitsConsumed() > worst) worst = r.computeUnitsConsumed();
    }
    const labels = await verifyCompletedCircuitBytes({
      scratch: bytes(f.h, f.scratch),
      session: bytes(f.h, f.session),
      sessionAddress: encAddress(f.session),
      scratchBump: f.scratchBump,
      artifact: f.artifact,
    });
    assert.deepEqual(f.key.decode(labels), Array(32).fill(false));
    await recover(f);
    console.log(
      JSON.stringify({
        scope: "maximum bounded real circuit",
        artifactBytes: 17600,
        scratchBytes: 8448,
        gates: 192,
        steps: 6,
        initCu: Number(init.computeUnitsConsumed()),
        worstStepCu: Number(worst),
        refundVerified: true,
      }),
    );
  } finally {
    f.key.destroy();
  }
});
