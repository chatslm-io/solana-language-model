import { approvedTestSigner } from "./approved-test-signer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  generateKeyPairSigner,
  signTransaction,
  lamports,
  type Instruction,
} from "@solana/kit";
import { TEST_PROGRAM as program } from "./vm-rpc";
import { transaction } from "../lib/chain/client";
import {
  HEADER,
  hex,
  sha256,
  registryAddress,
  shardAddress,
  sessionAddress,
  instruction,
  openSessionInstruction,
  delegateInstruction,
  decodeHeader,
} from "../lib/chain/protocol";

async function fixture(length = 8192, maxOperations = 100) {
  const svm = new LiteSVM().withSigverify(false);
  svm.addProgramFromFile(
    program,
    process.env.SLM_PROGRAM_BINARY || "program/target/deploy/slm_storage.so",
  );
  const owner = await approvedTestSigner(),
    delegate = await approvedTestSigner(1),
    outsider = await generateKeyPairSigner();
  svm.airdrop(owner.address, lamports(1000000000n));
  svm.airdrop(outsider.address, lamports(100000000n));
  const id = hex(crypto.getRandomValues(new Uint8Array(32))),
    bytes = Uint8Array.from({ length }, (_, i) => i % 251),
    hash = await sha256(bytes);
  const registry = await registryAddress(program, owner.address, id),
    shard = await shardAddress(program, owner.address, id, 0),
    session = await sessionAddress(program, owner.address, id);
  const rent = svm.minimumBalanceForRentExemption(BigInt(HEADER + length)),
    base = svm.minimumBalanceForRentExemption(BigInt(HEADER)),
    fees = 2000000n;
  const args = {
    id,
    hash,
    count: 1,
    bytes: BigInt(length),
    budget: rent,
    fees,
    expires: svm.getClock().slot + 100n,
    maxOperations,
    cap: base * 2n + rent + fees,
  };
  const open = (patch: Partial<typeof args> = {}) =>
    openSessionInstruction(
      program,
      owner.address,
      registry,
      session,
      delegate.address,
      { ...args, ...patch },
    );
  const ix = (
    op: Parameters<typeof instruction>[3],
    patch: Parameters<typeof instruction>[4] = {},
  ) =>
    instruction(program, owner.address, registry, op, {
      id,
      hash,
      index: 0,
      length,
      shard,
      cap: rent,
      ...patch,
    });
  const wrapped = (
    op: Parameters<typeof instruction>[3],
    patch: Parameters<typeof instruction>[4] = {},
  ) => delegateInstruction(ix(op, patch), delegate.address, session);
  async function send(ix: Instruction, signer = owner, fail = false) {
    svm.expireBlockhash();
    const tx = transaction(signer.address, ix, svm.latestBlockhash(), 100000n);
    const result = svm.sendTransaction(
      await signTransaction([signer.keyPair], tx.tx),
    );
    if (fail)
      assert.ok(
        result instanceof FailedTransactionMetadata,
        "attack unexpectedly succeeded",
      );
    else if (result instanceof FailedTransactionMetadata)
      assert.fail(result.meta().logs().join("\n"));
  }
  const header = (key = session) => {
    const a = svm.getAccount(key);
    assert.ok(a.exists);
    return decodeHeader(Uint8Array.from(a.data));
  };
  const closeSession = () =>
    instruction(program, owner.address, session, "closeSession", { id });
  return {
    svm,
    owner,
    delegate,
    outsider,
    id,
    bytes,
    hash,
    registry,
    shard,
    session,
    rent,
    base,
    fees,
    args,
    open,
    ix,
    wrapped,
    send,
    header,
    closeSession,
  };
}

test("one owner setup funds delegated upload; owner retains storage and exact rent recovery", async () => {
  const f = await fixture();
  await f.send(f.open());
  const afterSetup = f.svm.getBalance(f.owner.address);
  assert.equal(f.header().session!.delegate, f.delegate.address);
  await f.send(f.wrapped("createShard"), f.delegate);
  for (let offset = 0; offset < f.bytes.length; offset += 768)
    await f.send(
      f.wrapped("write", {
        offset,
        chunk: f.bytes.slice(offset, offset + 768),
      }),
      f.delegate,
    );
  await f.send(f.wrapped("finalize"), f.delegate);
  await f.send(f.wrapped("seal"), f.delegate);
  assert.equal(
    f.svm.getBalance(f.owner.address),
    afterSetup,
    "owner signs/pays only setup during upload",
  );
  assert.equal(f.header(f.shard).authority, f.owner.address);
  assert.equal(f.header(f.registry).state, 1);
  assert.equal(f.header().session!.spent, f.rent);
  const a = f.svm.getAccount(f.shard);
  assert.ok(a.exists);
  assert.deepEqual(Uint8Array.from(a.data).slice(HEADER), f.bytes);
  await f.send(f.closeSession());
  await f.send(f.ix("closeShard"));
  await f.send(f.ix("closeRegistry"));
  for (const key of [f.registry, f.shard, f.session])
    assert.equal(f.svm.getAccount(key).exists, false);
  assert.equal(
    f.svm.getBalance(f.owner.address),
    1000000000n - f.fees - 4n * 5000n,
  );
});

test("delegate cannot close, change recipient, impersonate owner or upload to another deployment", async () => {
  const f = await fixture(78);
  await f.send(f.open());
  await f.send(f.wrapped("createShard"), f.delegate);
  for (const tag of [0, 4, 5, 7, 8, 9]) {
    const wrapped = f.wrapped("finalize");
    await f.send(
      { ...wrapped, data: new Uint8Array([9, tag]) },
      f.delegate,
      true,
    );
  }
  const close = f.closeSession();
  await f.send(
    {
      ...close,
      accounts: close.accounts!.map((a, i) =>
        i === 0 ? { address: f.delegate.address, role: a.role } : a,
      ),
    },
    f.delegate,
    true,
  );
  await f.send(
    instruction(program, f.owner.address, f.session, "closeSession", {
      id: f.id,
      recipient: f.outsider.address,
    }),
    f.owner,
    true,
  );
  await f.send(
    delegateInstruction(
      f.ix("write", { offset: 0, chunk: f.bytes }),
      f.outsider.address,
      f.session,
    ),
    f.outsider,
    true,
  );
  const otherId = "ff".repeat(32),
    otherReg = await registryAddress(program, f.owner.address, otherId);
  await f.send(
    instruction(program, f.owner.address, otherReg, "createRegistry", {
      id: otherId,
      hash: f.hash,
      count: 1,
      bytes: 78n,
      cap: f.base,
    }),
  );
  const otherShard = await shardAddress(program, f.owner.address, otherId, 0);
  await f.send(
    delegateInstruction(
      instruction(program, f.owner.address, otherReg, "createShard", {
        index: 0,
        length: 78,
        hash: f.hash,
        cap: f.rent,
        shard: otherShard,
      }),
      f.delegate.address,
      f.session,
    ),
    f.delegate,
    true,
  );
  assert.equal(f.header().session!.operations, 1);
  assert.equal(f.svm.getAccount(otherShard).exists, false);
});

test("onchain setup and rent budget caps are atomic; donations do not expand delegated spending", async () => {
  const f = await fixture(78);
  await f.send(f.open({ cap: f.args.cap - 1n }), f.owner, true);
  assert.equal(f.svm.getAccount(f.session).exists, false);
  assert.equal(f.svm.getAccount(f.registry).exists, false);
  await f.send(f.open({ budget: f.rent - 1n }));
  f.svm.airdrop(f.session, lamports(10000000n));
  await f.send(f.wrapped("createShard"), f.delegate, true);
  assert.equal(f.svm.getAccount(f.shard).exists, false);
  assert.equal(f.header().session!.spent, 0n);
  assert.equal(f.header().session!.operations, 0);
  const before = f.svm.getBalance(f.owner.address)!,
    refund = f.svm.getBalance(f.session)!;
  await f.send(f.closeSession());
  assert.equal(f.svm.getBalance(f.owner.address), before + refund - 5000n);
});

test("revocation after a partial write stops the delegate; owner recovers without its key or manifest", async () => {
  const f = await fixture(78);
  await f.send(f.open());
  await f.send(f.wrapped("createShard"), f.delegate);
  await f.send(
    f.wrapped("write", { offset: 0, chunk: f.bytes.slice(0, 3) }),
    f.delegate,
  );
  await f.send(f.closeSession());
  await f.send(
    f.wrapped("write", { offset: 3, chunk: f.bytes.slice(3) }),
    f.delegate,
    true,
  );
  await f.send(f.ix("closeShard"));
  await f.send(f.ix("closeRegistry"));
  await f.send(f.closeSession());
  assert.equal(
    f.svm.getBalance(f.owner.address),
    1000000000n - f.fees - 5n * 5000n,
  );
});

test("expiry and operation limits stop uploads but never stop owner recovery", async () => {
  const f = await fixture(78, 1);
  await f.send(f.open());
  await f.send(f.wrapped("createShard"), f.delegate);
  await f.send(
    f.wrapped("write", { offset: 0, chunk: f.bytes }),
    f.delegate,
    true,
  );
  assert.equal(f.header().session!.operations, 1);
  const g = await fixture(78);
  await g.send(g.open());
  const clock = g.svm.getClock();
  clock.slot = g.args.expires;
  g.svm.setClock(clock);
  await g.send(g.wrapped("createShard"), g.delegate, true);
  assert.equal(g.header().session!.operations, 0);
  await g.send(g.ix("closeRegistry"));
  await g.send(g.closeSession());
  assert.equal(g.svm.getAccount(g.session).exists, false);
});

test("a session cannot authorize a changed manifest if its registry address is reused", async () => {
  const f = await fixture(78);
  await f.send(f.open());
  await f.send(f.ix("closeRegistry"));
  await f.send(
    f.ix("createRegistry", {
      hash: "ff".repeat(32),
      count: 1,
      bytes: 78n,
      cap: f.base,
    }),
  );
  await f.send(f.wrapped("createShard"), f.delegate, true);
  assert.equal(f.svm.getAccount(f.shard).exists, false);
  await f.send(f.closeSession());
  await f.send(f.ix("closeRegistry"));
});
