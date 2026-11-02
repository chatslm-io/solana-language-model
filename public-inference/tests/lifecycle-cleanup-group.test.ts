import { approvedTestSigner } from "../../tests/approved-test-signer";
/** Grouped recovery uses ordinary close instructions and the existing 200k CU
 * transaction budget. Model/table accounts are explicit genesis fixtures. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  address,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  lamports,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
  type Instruction,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { createLifecycleHarness } from "../harness/local-sbf";
import { prepareModelFixture } from "../harness/model-fixture";
import { prepareTokenizerFixture } from "../harness/tokenizer-fixture";
import {
  discoverCleanupInstructions,
  instructionWireBytes,
} from "../harness/fork-model";
import { encodeRawMessages } from "../client/tokenizer-frame";
import { executionInstruction } from "../execution-mode";
import { u32 } from "../harness/client";
let prepared:
  | Promise<{
      f: Awaited<ReturnType<typeof prepareModelFixture>>;
      t: Awaited<ReturnType<typeof prepareTokenizerFixture>>;
    }>
  | undefined;
async function fixture() {
  prepared ??= (async () => {
    const f = await prepareModelFixture(
      undefined,
      undefined,
      undefined,
      await approvedTestSigner(),
    );
    return { f, t: await prepareTokenizerFixture(f) };
  })();
  const { f, t } = await prepared,
    h = await createLifecycleHarness();
  h.svm.airdrop(f.signer.address, lamports(100000000000n));
  for (const a of [...f.accounts, ...t.accounts])
    h.svm.setAccount({
      address: a.address,
      data: a.data,
      programAddress: f.program,
      lamports: lamports(a.lamports),
      space: BigInt(a.data.length),
      executable: false,
    });
  const account = async (a: Address) => {
    const value = h.svm.getAccount(a);
    if (!value.exists) return null;
    assert.equal(value.programAddress, f.program);
    return { data: Buffer.from(value.data), lamports: value.lamports };
  };
  const single = async (ix: Instruction) => {
    const result = await h.execute(ix, f.signer);
    if (result.result instanceof FailedTransactionMetadata)
      assert.fail(String(result.result.err()));
  };
  const group = async (legacy: readonly Instruction[]) => {
    const instructions = legacy.map((ix) => executionInstruction(ix, 0));
    h.svm.expireBlockhash();
    const base = setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: h.svm.latestBlockhash(), lastValidBlockHeight: 1000000n },
        setTransactionMessageFeePayer(
          f.signer.address,
          createTransactionMessage({ version: 0 }),
        ),
      ),
      budget = {
        programAddress: address("ComputeBudget111111111111111111111111111111"),
        data: Buffer.concat([Buffer.of(2), u32(200000)]),
      };
    const signed = await signTransaction(
      [f.signer.keyPair],
      compileTransaction(
        appendTransactionMessageInstructions(
          instructions,
          appendTransactionMessageInstruction(budget, base),
        ),
      ),
    );
    const wireBytes = getTransactionEncoder().encode(signed).length;
    assert.equal(
      wireBytes,
      instructionWireBytes(instructions, f.signer.address, 200000),
    );
    assert.ok(wireBytes <= 1232);
    return { result: h.svm.sendTransaction(signed), wireBytes };
  };
  return { f, t, h, account, single, group };
}
test(
  "seven ordinary closes fit one200k transaction; late failure restores all accounts and successful group refunds every lamport",
  { timeout: 120000 },
  async () => {
    const { f, t, h, account, single, group } = await fixture();
    await single(
      t.client.createText(
        encodeRawMessages([{ role: "user", content: "Hi" }]),
        1,
        h.svm.getClock().slot + 100000n,
      ),
    );
    for (let i = 0; i < 5; i++) await single(f.client.allocateState(i));
    h.svm.airdrop(t.client.scratch, lamports(77n));
    const addresses = [...f.client.states, t.client.scratch, f.client.session],
      before = await Promise.all(addresses.map(account));
    const planned = await discoverCleanupInstructions(
      f.client,
      account,
      t.client,
    );
    assert.deepEqual(
      planned.instructions.map((ix) => ix.data![0]),
      [12, 12, 12, 12, 12, 25, 13],
    );
    assert.equal(
      planned.expectedRefund,
      before.reduce((n, a) => n + a!.lamports, 0n),
    );
    const invalid = planned.instructions.map((ix, i) =>
        i === 6 ? { ...ix, data: Buffer.of(13, 0) } : ix,
      ),
      failure = await group(invalid);
    assert.ok(failure.result instanceof FailedTransactionMetadata);
    const after = await Promise.all(addresses.map(account));
    before.forEach((value, i) => {
      assert.ok(after[i]);
      assert.equal(after[i]!.lamports, value!.lamports);
      assert.ok(
        after[i]!.data.equals(value!.data),
        `late cleanup failure mutated account${i}`,
      );
    });
    const balance = h.svm.getBalance(f.signer.address)!,
      success = await group(planned.instructions);
    if (success.result instanceof FailedTransactionMetadata)
      assert.fail(String(success.result.err()));
    assert.ok(success.result.computeUnitsConsumed() <= 200000n);
    assert.equal(
      h.svm.getBalance(f.signer.address),
      balance + planned.expectedRefund - 5000n,
    );
    for (const a of addresses) assert.equal(await account(a), null);
    assert.equal(
      (await discoverCleanupInstructions(f.client, account, t.client))
        .instructions.length,
      0,
    );
    process.stderr.write(
      `[cleanup SBF] ${JSON.stringify({ closes: 7, cu: Number(success.result.computeUnitsConsumed()), wireBytes: success.wireBytes, fee: 5000, lateFailureAtomic: true, refundVerified: true })}\n`,
    );
  },
);
test(
  "finalized discovery excludes an already closed state and retains session-last order",
  { timeout: 120000 },
  async () => {
    const { f, h, account, single, group } = await fixture();
    await single(
      f.client.createSession([1], 1, h.svm.getClock().slot + 100000n),
    );
    for (let i = 0; i < 5; i++) await single(f.client.allocateState(i));
    await single(f.client.closeState(0));
    assert.equal(await account(f.client.states[0]), null);
    const planned = await discoverCleanupInstructions(f.client, account);
    assert.equal(planned.instructions.length, 5);
    assert.deepEqual(
      planned.instructions
        .slice(0, 4)
        .map((ix) => Buffer.from(ix.data!).readUInt32LE(1)),
      [1, 2, 3, 4],
    );
    assert.equal(planned.instructions[4].data![0], 13);
    const balance = h.svm.getBalance(f.signer.address)!,
      success = await group(planned.instructions);
    if (success.result instanceof FailedTransactionMetadata)
      assert.fail(String(success.result.err()));
    assert.ok(success.result.computeUnitsConsumed() <= 200000n);
    assert.equal(
      h.svm.getBalance(f.signer.address),
      balance + planned.expectedRefund - 5000n,
    );
    assert.equal(
      (await discoverCleanupInstructions(f.client, account)).instructions
        .length,
      0,
    );
  },
);
