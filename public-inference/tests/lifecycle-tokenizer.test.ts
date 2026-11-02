import { approvedTestSigner } from "../../tests/approved-test-signer";
import test from "node:test";
import assert from "node:assert/strict";
import { lamports, type Address, type Instruction } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { createLifecycleHarness } from "../harness/local-sbf";
import { prepareModelFixture } from "../harness/model-fixture";
import { prepareTokenizerFixture } from "../harness/tokenizer-fixture";
import { encodeRawMessages } from "../client/tokenizer-frame";
import { recoveryPlan } from "../coordinator/recovery";
import { publicTokenizer } from "../client/tokenizer";
import { tokenizerMetadata } from "../../private-inference/reference/tokenizer";
const progress = (s: string) =>
  process.stderr.write("[onchain tokenizer SBF] " + s + "\n");
let prepared: ReturnType<typeof prepareModelFixture> | undefined;
async function fixture(upload = false) {
  prepared ??= prepareModelFixture(
    undefined,
    progress,
    undefined,
    await approvedTestSigner(),
  );
  const f = await prepared,
    t = await prepareTokenizerFixture(f),
    h = await createLifecycleHarness();
  h.svm.airdrop(f.signer.address, lamports(100000000000n));
  for (const a of [...f.accounts, ...(upload ? [] : t.accounts)])
    h.svm.setAccount({
      address: a.address,
      data: a.data,
      programAddress: f.program,
      lamports: lamports(a.lamports),
      space: BigInt(a.data.length),
      executable: false,
    });
  let maxCu = 0,
    steps = 0;
  const send = async (ix: Instruction, fail = false) => {
    const r = await h.execute(ix, f.signer);
    if (fail) {
      assert.ok(r.result instanceof FailedTransactionMetadata);
      return;
    }
    if (r.result instanceof FailedTransactionMetadata)
      throw Error(
        "SBF " + r.result.err() + " " + r.result.meta().logs().join(" "),
      );
    maxCu = Math.max(maxCu, Number(r.result.computeUnitsConsumed()));
    steps++;
  };
  const get = (a: Address) => {
    const v = h.svm.getAccount(a);
    assert.ok(v.exists);
    return Buffer.from(v.data);
  };
  return { f, t, h, send, get, metrics: () => ({ maxCu, steps }) };
}
test(
  "actual SBF raw Unicode splitting, byte mapping, BPE and role template match independent tokenizer",
  { timeout: 120000 },
  async () => {
    for (const content of [
      "Hi",
      "I'm we've can't",
      "!?...",
      "naïve😀",
      "e\u0301",
      "a\u0085b",
      "a\u00a0b",
      "a\ufeffb",
      "Hi  \n",
      "aaaaaa",
      "<|assistant|>",
    ]) {
      const x = await fixture(),
        { f, t, h, send, get } = x,
        messages = [{ role: "user" as const, content }],
        frame = encodeRawMessages(messages),
        meta = tokenizerMetadata(f.compiled.modelBytes),
        oracle = publicTokenizer(
          f.compiled.plan,
          meta.vocabulary,
          meta.chatTemplate,
        ).encodeMessages(messages, 1).tokens;
      await send(
        t.client.createText(frame, 1, h.svm.getClock().slot + 100000n),
      );
      await send(f.client.start(), true);
      await send(t.client.writeRaw(0, frame));
      await send(t.client.sealRaw());
      await send(t.client.writeRaw(0, frame), true);
      let work = 0;
      while (get(t.client.scratch)[10] !== 2) {
        const ix = await t.client.step(get(t.client.scratch));
        await send(ix);
        if (work === 0) {
          const before = get(t.client.scratch);
          await send(ix, true);
          assert.ok(before.equals(get(t.client.scratch)));
          h.restart();
        }
        if (++work > 10000) throw Error("tokenizer_step_bound");
      }
      const session = get(f.client.session),
        ids = Array.from({ length: session.readUInt32LE(244) }, (_, i) =>
          session.readUInt32LE(256 + i * 4),
        );
      assert.deepEqual(ids, oracle);
      assert.ok(x.metrics().maxCu <= 200000);
      progress(
        `Differential case passed; ${work} tokenizer steps, ${ids.length} tokens, max ${x.metrics().maxCu} CU`,
      );
      await send(t.client.closeText());
      await send(f.client.closeSession());
      assert.equal(h.svm.getAccount(f.client.session).exists, false);
      assert.equal(h.svm.getAccount(t.client.scratch).exists, false);
    }
  },
);
test(
  "tokenizer table upload and refund; malformed UTF8 never admits caller token IDs",
  { timeout: 120000 },
  async () => {
    const x = await fixture(true),
      { f, t, h, send, get } = x;
    const before = h.svm.getBalance(f.signer.address)!;
    await send(t.client.createRegistry());
    for (const page of t.tables.pages) {
      await send(await t.client.allocatePage(page));
      for (let at = 0; at < page.payload.length; at += 700)
        await send(
          await t.client.writePage(
            page.index,
            at,
            page.payload.subarray(at, at + 700),
          ),
        );
      await send(await t.client.sealPage(page.index));
    }
    await send(t.client.sealRegistry());
    const bad = Buffer.alloc(14);
    bad.writeUInt32LE(1);
    bad.writeUInt32LE(1, 4);
    bad.writeUInt32LE(2, 8);
    bad[12] = 0xc0;
    bad[13] = 0xaf;
    await send(t.client.createText(bad, 1, h.svm.getClock().slot + 100000n));
    await send(t.client.writeRaw(0, bad));
    const beforeSeal = get(t.client.scratch);
    await send(t.client.sealRaw(), true);
    assert.ok(beforeSeal.equals(get(t.client.scratch)));
    assert.equal(get(f.client.session).readUInt32LE(244), 0);
    await send(f.client.closeSession(), true);
    h.restart();
    const inventory = [f.client.session, t.client.scratch].map((address) => {
      const a = h.svm.getAccount(address);
      assert.ok(a.exists);
      return {
        address,
        owner: a.programAddress,
        data: a.data,
        lamports: a.lamports,
      };
    });
    await assert.rejects(
      recoveryPlan(f.program, f.signer.address, inventory.slice(0, 1)),
      /incomplete/,
    );
    for (const ix of await recoveryPlan(f.program, f.signer.address, inventory))
      await send(ix);
    for (const page of t.tables.pages)
      await send(await t.client.closePage(page.index));
    await send(t.client.closeRegistry());
    assert.equal(
      h.svm.getBalance(f.signer.address),
      before - BigInt(x.metrics().steps + 2) * 5000n,
    );
    progress(
      `Actual33-table upload/recovery passed; ${x.metrics().steps} successful transactions, max ${x.metrics().maxCu} CU`,
    );
  },
);
test(
  "raw text flows directly from onchain tokenizer into complete SBF model inference",
  { timeout: 120000 },
  async () => {
    const x = await fixture(),
      { f, t, h, send, get } = x,
      frame = encodeRawMessages([{ role: "user", content: "Hi" }]);
    await send(t.client.createText(frame, 1, h.svm.getClock().slot + 100000n));
    await send(t.client.writeRaw(0, frame));
    await send(t.client.sealRaw());
    while (get(t.client.scratch)[10] !== 2)
      await send(await t.client.step(get(t.client.scratch)));
    const session = get(f.client.session),
      ids = Array.from({ length: session.readUInt32LE(244) }, (_, i) =>
        session.readUInt32LE(256 + i * 4),
      );
    const { loadPublicReference } = await import("../reference/deepseek2"),
      reference = await loadPublicReference(f.compiled.modelBytes);
    let expected = 0;
    for (const id of ids) expected = reference.step(id).token;
    for (let i = 0; i < 5; i++) await send(f.client.allocateState(i));
    await send(f.client.start());
    for (let position = 0; position < ids.length; position++) {
      for (let pc = 0; pc < f.compiled.commands.length; pc++)
        await send(
          await f.client.step(
            get(f.client.session),
            get(f.client.states[0]),
            f.compiled.commands[pc],
            f.compiled.weights.pages.length,
          ),
        );
      progress(
        `Raw-text SBF forward ${position + 1}/${ids.length} complete; max ${x.metrics().maxCu} CU`,
      );
      h.restart();
    }
    assert.equal(get(f.client.session).readUInt32LE(320), expected);
    assert.equal(get(f.client.session)[10], 3);
    for (let i = 0; i < 5; i++) await send(f.client.closeState(i));
    await send(t.client.closeText());
    await send(f.client.closeSession());
    progress(
      `Raw UTF8 -> onchain tokenizer -> ${ids.length} full transformer forwards -> generated token parity PASS`,
    );
  },
);
