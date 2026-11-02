import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createSolanaRpc,
  generateKeyPairSigner,
  lamports,
  getTransactionDecoder,
  getTransactionEncoder,
  signTransaction,
} from "@solana/kit";
import { vmRpc, TEST_PROGRAM } from "./vm-rpc";
import {
  discover,
  transaction,
  verifyDeployment,
  type RPC,
} from "../lib/chain/client";
import {
  planUploadBatch,
  planWithdrawalBatch,
  previewBatch,
  submitBatch,
  assertSignedBatch,
  reconcileJournal,
  type BatchPreview,
  type JournalEntry,
} from "../lib/chain/batch";
import { canonical, type Manifest } from "../lib/model/manifest";
import { sha256 } from "../lib/chain/protocol";
import { reserveRun } from "../lib/chain/run";

async function fixture(sendConcurrency = 3) {
  const vm = vmRpc(),
    payer = await generateKeyPairSigner();
  vm.authorizeTestSigners([payer.address]);
  vm.svm.airdrop(payer.address, lamports(1000000000n));
  let height = 1,
    submissions = 0,
    loseReply = false;
  let onSend: () => void | Promise<void> = () => {};
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    const p = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    try {
      if (p.method === "sendTransaction") {
        submissions++;
        await onSend();
      }
      const result =
        p.method === "getBlockHeight"
          ? height
          : await vm.request(p.method, p.params);
      if (p.method === "sendTransaction" && loseReply) {
        loseReply = false;
        throw new Error("Injected lost submission response");
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: p.id, result }));
    } catch (e) {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: p.id,
          error: { code: -32002, message: (e as Error).message },
        }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const rpc = createSolanaRpc(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  ) as RPC;
  const config = {
    cluster: "devnet",
    program: TEST_PROGRAM,
    rpcDisplay: "VM",
    maxDeposit: "500000000",
    maxTransactions: 100,
  };
  const payload = Uint8Array.from(
    { length: 8192 * 3 + 123 },
    (_, i) => i % 251,
  );
  const manifest: Manifest = {
    version: 1,
    source: { repo: "synthetic/batch-proof", revision: "0".repeat(40) },
    tensors: [],
    artifacts: [
      {
        name: "bytes",
        payloadOffset: 0,
        length: payload.length,
        sha256: await sha256(payload),
      },
    ],
    payloadBytes: payload.length,
    shards: [],
  };
  for (let at = 0; at < payload.length; at += 8192) {
    const b = payload.slice(at, at + 8192);
    manifest.shards.push({
      index: manifest.shards.length,
      offset: at,
      length: b.length,
      sha256: await sha256(b),
    });
  }
  const hash = await sha256(new TextEncoder().encode(canonical(manifest))),
    id = "42".repeat(32);
  const found = () => discover(rpc, TEST_PROGRAM, payer.address);
  const plan = async () =>
    planUploadBatch(
      rpc,
      TEST_PROGRAM,
      payer.address,
      id,
      hash,
      manifest,
      async (i) => {
        const s = manifest.shards[i];
        return payload.slice(s.offset, s.offset + s.length);
      },
      await found(),
      16,
    );
  const sign = async (p: BatchPreview) =>
    Promise.all(
      p.transactions.map(async (t) =>
        Uint8Array.from(
          getTransactionEncoder().encode(
            await signTransaction(
              [payer.keyPair],
              getTransactionDecoder().decode(t.wire),
            ),
          ),
        ),
      ),
    );
  const send = async (p: BatchPreview) => {
    const signed = await sign(p);
    await submitBatch(
      rpc,
      p,
      signed,
      () => {},
      () => true,
      sendConcurrency,
    );
  };
  return {
    vm,
    payer,
    rpc,
    config,
    manifest,
    hash,
    id,
    plan,
    sign,
    send,
    found,
    submissions: () => submissions,
    onSend: (f: () => void | Promise<void>) => {
      onSend = f;
    },
    height: (n: number) => {
      height = n;
    },
    loseReply: () => {
      loseReply = true;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

for (const concurrency of [1, 8])
  test(`compiled program accepts independent signing batches and refunds all shards (${concurrency} preview workers)`, async () => {
    const f = await fixture(concurrency === 1 ? 3 : 5);
    try {
      let requests = 0,
        signedTransactions = 0,
        largestBatch = 0;
      for (;;) {
        const ops = await f.plan();
        if (!ops.length) break;
        assert.equal(new Set(ops.map((o) => o.account)).size, ops.length);
        const p = await previewBatch(
          f.rpc,
          f.config,
          f.payer.address,
          ops,
          0n,
          concurrency,
        );
        assert.ok(
          p.transactions.every(
            (t) => t.blockhash === p.transactions[0].blockhash,
          ),
        );
        await f.send(p);
        requests++;
        signedTransactions += ops.length;
        largestBatch = Math.max(largestBatch, ops.length);
      }
      assert.equal(largestBatch, 4);
      assert.ok(requests < signedTransactions / 2);
      await verifyDeployment(
        f.rpc,
        TEST_PROGRAM,
        f.payer.address,
        f.id,
        f.hash,
        f.manifest,
        (_i, ok) => assert.ok(ok),
      );
      let accounts = await f.found();
      const shards = await planWithdrawalBatch(
        TEST_PROGRAM,
        f.payer.address,
        accounts,
        new Set(accounts.map((a) => a.address)),
        16,
      );
      assert.equal(shards.length, 4);
      assert.ok(shards.every((o) => o.label.startsWith("Close shard")));
      await f.send(
        await previewBatch(
          f.rpc,
          f.config,
          f.payer.address,
          shards,
          0n,
          concurrency,
        ),
      );
      accounts = await f.found();
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].header.live, 0);
      const registry = await planWithdrawalBatch(
        TEST_PROGRAM,
        f.payer.address,
        accounts,
        new Set(accounts.map((a) => a.address)),
        16,
      );
      await f.send(
        await previewBatch(
          f.rpc,
          f.config,
          f.payer.address,
          registry,
          0n,
          concurrency,
        ),
      );
      assert.equal((await f.found()).length, 0);
      assert.equal(
        f.vm.svm.getBalance(f.payer.address),
        1000000000n - BigInt(f.submissions()) * 5000n,
      );
    } finally {
      await f.close();
    }
  });

test("every signed message and signature is checked before any member of a batch is broadcast", async () => {
  const f = await fixture();
  try {
    await f.send(
      await previewBatch(f.rpc, f.config, f.payer.address, await f.plan()),
    );
    const p = await previewBatch(
      f.rpc,
      f.config,
      f.payer.address,
      await f.plan(),
    );
    const good = await f.sign(p),
      before = f.submissions();
    await assert.rejects(
      submitBatch(f.rpc, p, good.slice(0, -1), () => {}),
      /incomplete/,
    );
    const last = p.transactions.at(-1)!;
    const changed = transaction(
      f.payer.address,
      { ...last.operation.instruction, data: new Uint8Array([7]) },
      last.blockhash,
      last.lastValidBlockHeight,
    );
    const badMessage = [
      ...good.slice(0, -1),
      Uint8Array.from(
        getTransactionEncoder().encode(
          await signTransaction([f.payer.keyPair], changed.tx),
        ),
      ),
    ];
    await assert.rejects(
      submitBatch(f.rpc, p, badMessage, () => {}),
      /changed/,
    );
    const badSignature = good.map((b) => Uint8Array.from(b));
    badSignature.at(-1)![1] ^= 1;
    await assert.rejects(
      submitBatch(f.rpc, p, badSignature, () => {}),
      /Invalid wallet signature/,
    );
    assert.equal(f.submissions(), before);
    assert.equal((await f.found()).length, 1);
  } finally {
    await f.close();
  }
});

test("whole-batch deposit and transaction caps include every approved member", async () => {
  const f = await fixture();
  try {
    await f.send(
      await previewBatch(f.rpc, f.config, f.payer.address, await f.plan()),
    );
    const ops = await f.plan(),
      sum = ops.reduce((n, o) => n + o.deposit, 0n);
    assert.ok(ops.every((o) => o.deposit < sum));
    assert.throws(
      () =>
        reserveRun(
          { deposit: "0", transactions: 0 },
          sum,
          sum - 1n,
          100,
          ops.length,
        ),
      /deposit/,
    );
    assert.throws(
      () =>
        reserveRun(
          { deposit: "0", transactions: 98 },
          sum,
          sum,
          100,
          ops.length,
        ),
      /Transaction cap/,
    );
    assert.equal(
      reserveRun({ deposit: "0", transactions: 0 }, sum, sum, 4, 4)
        .transactions,
      4,
    );
    const onlyOne = ops[0].deposit + 10000000n;
    const payerAccount = f.vm.svm.getAccount(f.payer.address);
    assert.ok(payerAccount.exists);
    f.vm.svm.setAccount({ ...payerAccount, lamports: lamports(onlyOne) });
    await assert.rejects(
      previewBatch(f.rpc, f.config, f.payer.address, ops),
      /entire batch/,
    );
  } finally {
    await f.close();
  }
});

test("expired presigned batches submit nothing and must reconcile before a fresh preview", async () => {
  const f = await fixture();
  try {
    await f.send(
      await previewBatch(f.rpc, f.config, f.payer.address, await f.plan()),
    );
    const p = await previewBatch(
        f.rpc,
        f.config,
        f.payer.address,
        await f.plan(),
      ),
      signed = await f.sign(p);
    const entries: JournalEntry[] = p.transactions.map((t) => ({
      label: t.operation.label,
      status: "prepared",
      account: t.operation.account,
      operation: t.operation.kind,
      reclaim: "0",
      lastValidBlockHeight: t.lastValidBlockHeight.toString(),
    }));
    const sigs = await assertSignedBatch(p, signed);
    entries.forEach((e, i) => {
      e.signature = sigs[i];
      e.status = "signed; not submitted";
    });
    await assert.rejects(
      reconcileJournal(f.rpc, f.payer.address, entries, () => {}),
      /still pending/,
    );
    f.height(100001);
    const before = f.submissions();
    await assert.rejects(
      submitBatch(f.rpc, p, signed, () => {}),
      /expired/,
    );
    assert.equal(f.submissions(), before);
    await reconcileJournal(f.rpc, f.payer.address, entries, () => {});
    assert.ok(
      entries.every((e) => e.status === "expired without confirmation"),
    );
  } finally {
    await f.close();
  }
});

test("lost RPC reply is reconciled by signature and every signature is journaled before broadcasting", async () => {
  const f = await fixture();
  try {
    const p = await previewBatch(
        f.rpc,
        f.config,
        f.payer.address,
        await f.plan(),
      ),
      signed = await f.sign(p);
    const journal = new Map<number, string>();
    f.onSend(() => assert.equal(journal.size, p.transactions.length));
    f.loseReply();
    await submitBatch(f.rpc, p, signed, (i, status, sig) => {
      assert.ok(sig);
      journal.set(i, status);
    });
    assert.equal(journal.get(0), "finalized");
    assert.equal(f.submissions(), 1);
  } finally {
    await f.close();
  }
});

test("pausing a signed batch stops unsent work and chain discovery recovers partial allocations", async () => {
  const f = await fixture();
  try {
    await f.send(
      await previewBatch(f.rpc, f.config, f.payer.address, await f.plan()),
    );
    const p = await previewBatch(
        f.rpc,
        f.config,
        f.payer.address,
        await f.plan(),
      ),
      signed = await f.sign(p);
    let keepSending = true;
    const entries: JournalEntry[] = p.transactions.map((t) => ({
      label: t.operation.label,
      status: "prepared",
      account: t.operation.account,
      operation: t.operation.kind,
      reclaim: "0",
      lastValidBlockHeight: t.lastValidBlockHeight.toString(),
    }));
    await assert.rejects(
      submitBatch(
        f.rpc,
        p,
        signed,
        (i, status, sig) => {
          entries[i].status = status;
          entries[i].signature = sig;
          if (status === "submitting") keepSending = false;
        },
        () => keepSending,
      ),
      /stopped/,
    );
    assert.equal((await f.found()).length, 2);
    await assert.rejects(
      reconcileJournal(f.rpc, f.payer.address, entries, () => {}),
      /still pending/,
    );
    f.height(100001);
    await reconcileJournal(f.rpc, f.payer.address, entries, () => {});
    assert.equal(
      entries.filter((e) => e.status === "expired without confirmation").length,
      3,
    );
    f.height(1);
    // Recovery consumes only RPC-discovered headers, not the upload manifest.
    for (;;) {
      const accounts = await f.found();
      if (!accounts.length) break;
      const ops = await planWithdrawalBatch(
        TEST_PROGRAM,
        f.payer.address,
        accounts,
        new Set(accounts.map((a) => a.address)),
        16,
      );
      await f.send(await previewBatch(f.rpc, f.config, f.payer.address, ops));
    }
    assert.equal(
      f.vm.svm.getBalance(f.payer.address),
      1000000000n - BigInt(f.submissions()) * 5000n,
    );
  } finally {
    await f.close();
  }
});

test("journal failure stops unsent work and waits for in-flight submission before releasing the batch", async () => {
  const f = await fixture();
  let release = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  try {
    await f.send(
      await previewBatch(f.rpc, f.config, f.payer.address, await f.plan()),
    );
    const p = await previewBatch(
        f.rpc,
        f.config,
        f.payer.address,
        await f.plan(),
      ),
      signed = await f.sign(p),
      before = f.submissions();
    let arrived = () => {};
    const inFlight = new Promise<void>((r) => {
      arrived = r;
    });
    f.onSend(async () => {
      arrived();
      await gate;
    });
    const entries: JournalEntry[] = p.transactions.map((t) => ({
      label: t.operation.label,
      status: "prepared",
      account: t.operation.account,
      operation: t.operation.kind,
      lastValidBlockHeight: t.lastValidBlockHeight.toString(),
    }));
    let settled = false;
    const result = submitBatch(f.rpc, p, signed, (i, status, sig) => {
      if (i === 1 && status === "submitting")
        throw new Error("Storage quota exhausted");
      entries[i].status = status;
      entries[i].signature = sig;
    }).then(
      () => {
        settled = true;
        return null;
      },
      (error: Error) => {
        settled = true;
        return error;
      },
    );
    await inFlight;
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(settled, false);
    assert.ok(entries.every((e) => e.signature));
    release();
    assert.match((await result)!.message, /journal update failed/);
    assert.equal(f.submissions() - before, 1);
    assert.equal((await f.found()).length, 2);
    f.height(100001);
    await reconcileJournal(f.rpc, f.payer.address, entries, () => {});
    assert.equal(entries[0].status, "finalized");
    assert.equal(
      entries.filter((e) => e.status === "expired without confirmation").length,
      3,
    );
  } finally {
    release();
    await f.close();
  }
});
