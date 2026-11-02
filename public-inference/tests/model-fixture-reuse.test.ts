/** Model bytes remain in memory. Only public immutable identity is reused. */
import test from "node:test";
import assert from "node:assert/strict";
import { lamports } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { prepareModelFixture } from "../harness/model-fixture";
import { prepareTokenizerFixture } from "../harness/tokenizer-fixture";
import { createLifecycleHarness } from "../harness/local-sbf";
import { encodeRawMessages } from "../client/tokenizer-frame";
test(
  "public fixture identity preserves model/tokenizer accounts while fresh owners open independent SBF sessions",
  { timeout: 120000 },
  async () => {
    const first = await prepareModelFixture(),
      second = await prepareModelFixture(
        first.compiled.modelBytes,
        () => {},
        first.identity,
      );
    assert.notEqual(first.signer.address, second.signer.address);
    assert.notEqual(first.client.session, second.client.session);
    assert.notDeepEqual(first.client.sessionNonce, second.client.sessionNonce);
    assert.equal(first.client.model, second.client.model);
    assert.deepEqual(first.binding, second.binding);
    assert.deepEqual(first.identity, second.identity);
    assert.deepEqual(first.accounts, second.accounts);
    const t1 = await prepareTokenizerFixture(first),
      t2 = await prepareTokenizerFixture(second);
    assert.deepEqual(t1.accounts, t2.accounts);
    assert.equal(t1.client.registry, t2.client.registry);
    assert.notEqual(t1.client.scratch, t2.client.scratch);
    const h = await createLifecycleHarness();
    h.svm.airdrop(second.signer.address, lamports(2000000000n));
    for (const a of [...first.accounts, ...t1.accounts])
      h.svm.setAccount({
        address: a.address,
        data: a.data,
        programAddress: first.program,
        lamports: lamports(a.lamports),
        space: BigInt(a.data.length),
        executable: false,
      });
    const send = async (ix: Parameters<typeof h.execute>[0]) => {
      const result = await h.execute(ix, second.signer);
      assert.ok(
        !(result.result instanceof FailedTransactionMetadata),
        result.result instanceof FailedTransactionMetadata
          ? result.result.err().toString()
          : "",
      );
    };
    await send(
      second.client.createSession([1], 1, h.svm.getClock().slot + 100000n),
    );
    for (let i = 0; i < 5; i++) await send(second.client.allocateState(i));
    await send(second.client.start());
    const session = h.svm.getAccount(second.client.session),
      global = h.svm.getAccount(second.client.states[0]);
    assert.ok(session.exists && global.exists);
    await send(
      await second.client.step(
        session.data,
        global.data,
        second.compiled.commands[0],
        second.compiled.weights.pages.length,
      ),
    );
    for (let i = 0; i < 5; i++) await send(second.client.closeState(i));
    await send(second.client.closeSession());
    assert.equal(h.svm.getAccount(second.client.session).exists, false);
    // Tokenizer authority remains the original public model owner. Only the
    // independent new session owner signs raw-text initialization and recovery.
    const frame = encodeRawMessages([{ role: "user", content: "Hi" }]);
    await send(t2.client.createText(frame, 1, h.svm.getClock().slot + 100000n));
    await send(t2.client.writeRaw(0, frame));
    await send(t2.client.sealRaw());
    for (let i = 0; i < 100; i++) {
      const scratch = h.svm.getAccount(t2.client.scratch);
      assert.ok(scratch.exists);
      if (scratch.data[10] === 2) break;
      await send(await t2.client.step(scratch.data));
    }
    const scratch = h.svm.getAccount(t2.client.scratch),
      textSession = h.svm.getAccount(second.client.session);
    assert.ok(scratch.exists && textSession.exists);
    assert.equal(scratch.data[10], 2);
    assert.equal(Buffer.from(textSession.data).readUInt32LE(244), 5);
    await send(t2.client.closeText());
    await send(second.client.closeSession());
    assert.equal(h.svm.getAccount(t2.client.scratch).exists, false);
    assert.equal(h.svm.getAccount(second.client.session).exists, false);
    assert.ok(
      h.svm.getAccount(first.client.model).exists,
      "immutable model stays available without its original owner signer",
    );
  },
);
