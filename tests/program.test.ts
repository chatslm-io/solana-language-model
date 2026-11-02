import { approvedTestSigner } from "./approved-test-signer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  getAddressDecoder,
  signTransaction,
  lamports,
  type Instruction,
} from "@solana/kit";
import {
  HEADER,
  SYSTEM,
  instruction,
  registryAddress,
  shardAddress,
  sha256,
  decodeHeader,
  hex,
} from "../lib/chain/protocol";
import { transaction } from "../lib/chain/client";
import { existsSync } from "node:fs";
const program = getAddressDecoder().decode(new Uint8Array(32).fill(42));
const path =
  process.env.SLM_PROGRAM_BINARY ||
  (existsSync("program/target/deploy/slm_storage.so")
    ? "program/target/deploy/slm_storage.so"
    : "program/target/sbpf-solana-solana/release/slm_storage.so");
async function setup(bytes = new Uint8Array([1, 2, 3, 4]), count = 1) {
  const svm = new LiteSVM().withSigverify(false);
  svm.addProgramFromFile(program, path);
  const payer = await approvedTestSigner(),
    other = await approvedTestSigner(1);
  svm.airdrop(payer.address, lamports(10000000000n));
  svm.airdrop(other.address, lamports(1000000000n));
  const id = hex(crypto.getRandomValues(new Uint8Array(32))),
    digest = await sha256(bytes),
    registry = await registryAddress(program, payer.address, id),
    shard = await shardAddress(program, payer.address, id, 0);
  const rent = svm.minimumBalanceForRentExemption(
      BigInt(HEADER + bytes.length),
    ),
    regRent = svm.minimumBalanceForRentExemption(BigInt(HEADER));
  const ix = (
    op: Parameters<typeof instruction>[3],
    args: Parameters<typeof instruction>[4] = {},
  ) =>
    instruction(program, payer.address, registry, op, {
      id,
      hash: digest,
      count,
      bytes: BigInt(bytes.length * count),
      cap: rent,
      index: 0,
      length: bytes.length,
      shard,
      ...args,
    });
  async function send(i: Instruction, signer = payer, fail = false) {
    svm.expireBlockhash();
    const t = transaction(signer.address, i, svm.latestBlockhash(), 1000000n);
    const signed = await signTransaction([signer.keyPair], t.tx);
    const result = svm.sendTransaction(signed);
    if (fail) {
      assert.ok(
        result instanceof FailedTransactionMetadata,
        "attack unexpectedly succeeded",
      );
    } else if (result instanceof FailedTransactionMetadata) {
      assert.fail(result.meta().logs().join("\n"));
    }
    return result;
  }
  const create = () => send(ix("createRegistry", { cap: regRent }));
  const header = (a = shard) => {
    const account = svm.getAccount(a);
    assert.ok(account.exists);
    return decodeHeader(Uint8Array.from(account.data));
  };
  return {
    svm,
    payer,
    other,
    id,
    digest,
    registry,
    shard,
    rent,
    regRent,
    ix,
    send,
    create,
    header,
    bytes,
  };
}
test("real SBF lifecycle: exact bytes, duplicate safety, immutable finalization, full rent refund", async () => {
  const t = await setup();
  await t.create();
  await t.send(t.ix("createRegistry", { cap: t.regRent }));
  assert.equal(t.header(t.registry).live, 0);
  await t.send(t.ix("createShard"));
  await t.send(t.ix("createShard"));
  assert.equal(t.header(t.registry).live, 1);
  await t.send(t.ix("write", { offset: 0, chunk: t.bytes }));
  await t.send(t.ix("write", { offset: 0, chunk: t.bytes }));
  assert.equal(t.header().written, t.bytes.length);
  await t.send(t.ix("finalize"));
  await t.send(t.ix("finalize"));
  assert.equal(t.header(t.registry).finalized, 1);
  const a = t.svm.getAccount(t.shard);
  assert.ok(a.exists);
  assert.equal(a.programAddress, program);
  assert.deepEqual(Uint8Array.from(a.data).slice(HEADER), t.bytes);
  await t.send(t.ix("write", { offset: 0, chunk: t.bytes }), t.payer, true);
  await t.send(t.ix("seal"));
  assert.equal(t.header(t.registry).state, 1);
  await t.send(t.ix("closeRegistry"), t.payer, true);
  const before = t.svm.getBalance(t.payer.address)!;
  await t.send(t.ix("closeShard"));
  assert.equal(t.svm.getAccount(t.shard).exists, false);
  assert.equal(t.svm.getBalance(t.payer.address), before + t.rent - 5000n);
  assert.equal(t.header(t.registry).live, 0);
  await t.send(t.ix("closeShard"));
  const beforeReg = t.svm.getBalance(t.payer.address)!;
  await t.send(t.ix("closeRegistry"));
  assert.equal(t.svm.getAccount(t.registry).exists, false);
  assert.equal(
    t.svm.getBalance(t.payer.address),
    beforeReg + t.regRent - 5000n,
  );
  await t.send(t.ix("closeRegistry"));
});
test("wrong signer, wrong recipient, wrong PDA, wrong owner and mismatched duplicates cannot take funds", async () => {
  const t = await setup();
  await t.create();
  await t.send(t.ix("createShard"));
  const otherIx = instruction(
    program,
    t.other.address,
    t.registry,
    "closeShard",
    { shard: t.shard, index: 0 },
  );
  await t.send(otherIx, t.other, true);
  await t.send(
    t.ix("closeShard", { recipient: t.other.address }),
    t.payer,
    true,
  );
  await t.send(
    t.ix("closeRegistry", { recipient: t.other.address }),
    t.payer,
    true,
  );
  await t.send(t.ix("createShard", { shard: t.other.address }), t.payer, true);
  await t.send(t.ix("createShard", { hash: "ff".repeat(32) }), t.payer, true);
  const reg = t.svm.getAccount(t.registry);
  assert.ok(reg.exists);
  t.svm.setAccount({ ...reg, programAddress: SYSTEM });
  await t.send(t.ix("closeShard"), t.payer, true);
  t.svm.setAccount(reg);
  assert.equal(t.svm.getBalance(t.shard), t.rent);
  await t.send(t.ix("closeShard"));
  await t.send(t.ix("closeRegistry"));
});
test("bounds, sequence, data mutation, hash mismatch, incomplete finalize and deposit cap fail atomically", async () => {
  const t = await setup();
  await t.send(t.ix("createRegistry", { cap: 0n }), t.payer, true);
  assert.equal(t.svm.getAccount(t.registry).exists, false);
  await t.create();
  await t.send(t.ix("createShard", { cap: 1n }), t.payer, true);
  assert.equal(t.header(t.registry).live, 0);
  await t.send(t.ix("createShard"));
  await t.send(
    t.ix("write", { offset: 1, chunk: new Uint8Array([1]) }),
    t.payer,
    true,
  );
  await t.send(
    t.ix("write", { offset: 0, chunk: new Uint8Array(5) }),
    t.payer,
    true,
  );
  await t.send(
    t.ix("write", { offset: 0xffffffff, chunk: new Uint8Array([1]) }),
    t.payer,
    true,
  );
  await t.send(t.ix("finalize"), t.payer, true);
  await t.send(t.ix("seal"), t.payer, true);
  await t.send(
    t.ix("write", { offset: 0, chunk: new Uint8Array([9, 2, 3, 4]) }),
  );
  await t.send(t.ix("write", { offset: 0, chunk: t.bytes }), t.payer, true);
  await t.send(t.ix("finalize"), t.payer, true);
  await t.send(t.ix("closeShard"));
  await t.send(t.ix("closeRegistry"));
});
test("partial uploads survive VM restart and remain discoverable and closable without a manifest", async () => {
  const t = await setup(new Uint8Array([8, 9]), 2);
  await t.create();
  await t.send(t.ix("createShard"));
  await t.send(t.ix("write", { offset: 0, chunk: new Uint8Array([8]) }));
  const restarted = LiteSVM.fromBytes(t.svm.toBytes());
  const found = restarted
    .getProgramAccounts(program)
    .filter(
      (a) =>
        a.data.length >= HEADER &&
        decodeHeader(Uint8Array.from(a.data)).authority === t.payer.address,
    );
  assert.equal(found.length, 2);
  await t.send(t.ix("closeShard"));
  const second = await shardAddress(program, t.payer.address, t.id, 1);
  await t.send(t.ix("createShard", { index: 1, shard: second }), t.payer, true);
  await t.send(t.ix("closeRegistry"));
  assert.equal(
    t.svm.getProgramAccounts(program).filter((a) => a.data.length >= HEADER)
      .length,
    0,
  );
});
test("prefunded PDAs are initialized using only the deficit and donations are fully returned", async () => {
  const t = await setup();
  t.svm.airdrop(t.registry, lamports(1000000n));
  await t.send(t.ix("createRegistry", { cap: t.regRent - 1000000n }));
  t.svm.airdrop(t.shard, lamports(t.rent + 123n));
  await t.send(t.ix("createShard", { cap: 0n }));
  assert.equal(t.svm.getBalance(t.shard), t.rent + 123n);
  const before = t.svm.getBalance(t.payer.address)!;
  await t.send(t.ix("closeShard"));
  assert.equal(
    t.svm.getBalance(t.payer.address),
    before + t.rent + 123n - 5000n,
  );
  await t.send(t.ix("closeRegistry"));
});
test("maximum 8 KiB shard fits allocation and hash compute limits; changing wallet changes PDAs", async () => {
  const t = await setup(Uint8Array.from({ length: 8192 }, (_, i) => i % 251));
  assert.notEqual(
    await registryAddress(program, t.other.address, t.id),
    t.registry,
  );
  assert.notEqual(
    await shardAddress(program, t.other.address, t.id, 0),
    t.shard,
  );
  await t.create();
  await t.send(t.ix("createShard"));
  for (let offset = 0; offset < t.bytes.length; offset += 768)
    await t.send(
      t.ix("write", { offset, chunk: t.bytes.subarray(offset, offset + 768) }),
    );
  const result = await t.send(t.ix("finalize"));
  assert.ok(!(result instanceof FailedTransactionMetadata));
  assert.ok(result.computeUnitsConsumed() < 200000n);
  await t.send(t.ix("closeShard"));
  await t.send(t.ix("closeRegistry"));
});
