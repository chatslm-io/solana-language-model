import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner } from "@solana/kit";
import { operatorFixture } from "./operator-fixture";
import { OperatorEngine } from "../lib/operator/engine";
import { discover } from "../lib/chain/client";
import { TEST_PROGRAM } from "./vm-rpc";
import { operationProgress } from "../lib/operator/progress";

test("local operator performs a bounded test, verifies bytes, and refunds exact rent with no wallet prompts", async () => {
  const f = await operatorFixture();
  try {
    const p = await f.engine.prepare("devnet", "test");
    await f.engine.wait();
    const ready = (await f.engine.status("devnet")).job!;
    assert.equal(ready.phase, "ready");
    assert.deepEqual(ready.operationProgress, {
      percent: 0,
      shards: { completed: 0, total: 1, remaining: 1 },
      accounts: { completed: 0, total: 2, remaining: 2 },
      transactions: { completed: 0, total: 7, remaining: 7 },
    });
    assert.equal(f.sends(), 0);
    await assert.rejects(
      f.engine.start(p.id, "mainnet-beta"),
      /network changed/,
    );
    const other = await generateKeyPairSigner(false);
    f.deps.signer = async () => other;
    await assert.rejects(f.engine.start(p.id, "devnet"), /signer changed/);
    f.deps.signer = async () => f.signer;
    await f.engine.start(p.id, "devnet");
    await f.engine.wait();
    const done = await f.engine.status("devnet", true);
    assert.equal(done.job!.phase, "complete", done.job!.message);
    assert.equal(done.job!.verifiedBytes, 78);
    assert.deepEqual(done.job!.operationProgress, {
      percent: 100,
      shards: { completed: 1, total: 1, remaining: 0 },
      accounts: { completed: 2, total: 2, remaining: 0 },
      transactions: { completed: 7, total: 7, remaining: 0 },
    });
    assert.equal(done.job!.reclaimed, ready.deposit);
    assert.equal(done.accounts, 0);
    assert.equal(f.sends(), 7);
    assert.equal(done.balance, String(1000000000n - BigInt(f.sends()) * 5000n));
    assert.ok(
      f.store
        .load()[0]
        .journal.every((e) => ["verified", "finalized"].includes(e.status)),
    );
    assert.equal(JSON.stringify(done).includes("privateKey"), false);
    await assert.rejects(f.engine.start(p.id, "devnet"), /review/);
  } finally {
    await f.close();
  }
});

test("a paused upload survives process replacement; one-click withdrawal works with model files unavailable", async () => {
  const f = await operatorFixture();
  try {
    const p = await f.engine.prepare("devnet", "upload", {
      repo: "test/model",
      revision: "a".repeat(40),
      file: "test.gguf",
    });
    const second = new OperatorEngine(f.deps);
    const paid = { mode: "paid", rps: 50, sendRps: 5, scanRps: 25 };
    await assert.rejects(
      f.engine.configureRpc("devnet", paid),
      /already active/,
    );
    await assert.rejects(
      second.prepare("devnet", "withdraw"),
      /Another local operator process/,
    );
    await f.engine.wait();
    f.afterSend(() => {
      if (f.sends() === 1) f.engine.pause(p.id);
    });
    await f.engine.start(p.id, "devnet");
    await f.engine.wait();
    const paused = (await f.engine.status("devnet")).job!;
    assert.equal(paused.phase, "paused");
    assert.equal(paused.operationProgress!.percent, 20);
    assert.equal(paused.operationProgress!.transactions.completed, 1);
    assert.equal(paused.operationProgress!.transactions.remaining, 4);
    assert.equal(f.sends(), 1);
    await f.engine.configureRpc("devnet", paid);
    const configured = (await f.engine.status("devnet")).job!;
    assert.equal(configured.id, paused.id);
    assert.equal(configured.deposit, paused.deposit);
    assert.equal(configured.feeBudget, paused.feeBudget);
    assert.equal(configured.signedTransactions, paused.signedTransactions);
    assert.equal(configured.rpcPolicy!.mode, "paid");
    // Journals created before progress counters were added still resume.
    const older = f.store.load();
    delete older[0].uploadTotals;
    f.store.save(older);
    f.afterSend(() => {});
    const restarted = new OperatorEngine(f.deps);
    assert.equal((await restarted.status("devnet")).rpc.mode, "paid");
    await restarted.start(p.id, "devnet");
    await restarted.wait();
    const complete = await restarted.status("devnet", true);
    assert.equal(complete.job!.phase, "complete", complete.job!.message);
    assert.equal(complete.accounts, 2);
    assert.equal(complete.job!.operationProgress!.percent, 100);
    assert.equal(f.sends(), 5);
    f.loseModels();
    const recovery = new OperatorEngine(f.deps);
    const plan = await recovery.prepare("devnet", "withdraw");
    await recovery.wait();
    await recovery.start(plan.id, "devnet");
    await recovery.wait();
    const result = await recovery.status("devnet", true);
    assert.equal(result.job!.phase, "complete", result.job!.message);
    assert.equal(result.accounts, 0);
    assert.deepEqual(result.job!.operationProgress, {
      percent: 100,
      accounts: { completed: 2, total: 2, remaining: 0 },
      transactions: { completed: 2, total: 2, remaining: 0 },
    });
    assert.equal((await f.engine.status("devnet")).job!.id, plan.id);
    assert.equal(
      result.balance,
      String(1000000000n - BigInt(f.sends()) * 5000n),
    );
    const empty = await recovery.prepare("devnet", "withdraw");
    await recovery.wait();
    await recovery.start(empty.id, "devnet");
    await recovery.wait();
    assert.equal(f.sends(), 7);
    assert.equal(
      (await recovery.status("devnet")).job!.operationProgress!.percent,
      100,
    );
  } finally {
    await f.close();
  }
});

test("upload progress excludes failed, pending and duplicate attempts and waits for final readback", async () => {
  const f = await operatorFixture();
  try {
    const plan = await f.engine.prepare("devnet", "upload", {
      repo: "test/model",
      revision: "a".repeat(40),
      file: "test.gguf",
    });
    await f.engine.wait();
    await f.engine.start(plan.id, "devnet");
    await f.engine.wait();
    const job = f.store.load()[0];
    const write = job.journal.find((entry) => entry.operation === "write")!;
    job.journal.push(
      { ...write },
      { ...write, status: "failed" },
      {
        ...write,
        status: "signed; not submitted",
        label: "Additional pending attempt",
      },
    );
    assert.equal(operationProgress(job)!.transactions.completed, 5);
    assert.equal(operationProgress(job)!.transactions.remaining, 0);
    job.verifiedBytes = 0;
    assert.equal(operationProgress(job)!.percent, 99);
    const finalize = job.journal.find(
      (entry) => entry.operation === "finalize",
    )!;
    finalize.status = "finalized; verification pending";
    assert.equal(operationProgress(job)!.shards!.completed, 0);
    assert.equal(operationProgress(job)!.transactions.remaining, 1);
  } finally {
    await f.close();
  }
});

test("operator caps, expired quotes and network mismatches stop before funding; withdrawal stays owner-bound", async () => {
  const f = await operatorFixture();
  try {
    f.config.maxDeposit = "1";
    const originalRpc = f.config.rpc;
    f.config.rpc = "https://api.devnet.solana.com";
    await assert.rejects(
      f.engine.configureRpc("devnet", {
        mode: "paid",
        rps: 50,
        sendRps: 5,
        scanRps: 25,
      }),
      /paid provider/,
    );
    f.config.rpc = originalRpc;
    const tiny = await f.engine.prepare("devnet", "test");
    await f.engine.wait();
    assert.equal((await f.engine.status("devnet")).job!.phase, "failed");
    await assert.rejects(f.engine.start(tiny.id, "devnet"), /review/);
    assert.equal(f.sends(), 0);
    f.config.maxDeposit = "100000000";
    await f.engine.prepare("mainnet-beta", "test");
    await f.engine.wait();
    assert.equal((await f.engine.status("devnet")).job!.phase, "failed");
    assert.equal(f.sends(), 0);
    const plan = await f.engine.prepare("devnet", "test");
    await f.engine.wait();
    const saved = f.store.load();
    saved.at(-1)!.quotedAt = Date.now() - 600001;
    f.store.save(saved);
    await assert.rejects(f.engine.start(plan.id, "devnet"), /expired/);
    assert.equal((await f.engine.status("devnet")).job!.phase, "failed");
    assert.equal(
      (await discover(f.rpc, TEST_PROGRAM, f.signer.address)).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("restart reconciles a missing final closure receipt without another signature or model access", async () => {
  const f = await operatorFixture();
  try {
    const plan = await f.engine.prepare("devnet", "test");
    await f.engine.wait();
    const deposit = (await f.engine.status("devnet")).job!.deposit;
    f.beforeRequest((method) => {
      if (method === "getTransaction" && f.sends() === 7)
        throw new Error("Receipt temporarily unavailable");
    });
    await f.engine.start(plan.id, "devnet");
    await f.engine.wait();
    const interrupted = await f.engine.status("devnet");
    assert.equal(interrupted.job!.phase, "failed");
    assert.equal(interrupted.job!.operationProgress!.transactions.remaining, 1);
    assert.equal(interrupted.job!.operationProgress!.accounts!.remaining, 1);
    assert.ok(interrupted.job!.operationProgress!.percent < 100);
    assert.equal(interrupted.accounts, 0);
    assert.notEqual(interrupted.job!.reclaimed, deposit);
    assert.equal(f.sends(), 7);
    f.beforeRequest(() => {});
    f.loseModels();
    const restarted = new OperatorEngine(f.deps);
    await restarted.start(plan.id, "devnet");
    await restarted.wait();
    const result = await restarted.status("devnet");
    assert.equal(result.job!.phase, "complete", result.job!.message);
    assert.equal(result.job!.reclaimed, deposit);
    assert.equal(result.accounts, 0);
    assert.equal(f.sends(), 7);
  } finally {
    await f.close();
  }
});

test("an expired dropped write is reconciled and retried automatically within the original budget", async () => {
  const f = await operatorFixture();
  try {
    const { getTransactionDecoder, getSignatureFromTransaction } =
      await import("@solana/kit");
    const { fromBase64 } = await import("../lib/chain/protocol");
    const original = f.vm.request;
    let dropped = false;
    f.vm.request = async (method, params) => {
      if (method === "sendTransaction" && f.sends() === 2 && !dropped) {
        dropped = true;
        return getSignatureFromTransaction(
          getTransactionDecoder().decode(fromBase64(params[0] as string)),
        );
      }
      if (method === "getBlockHeight" && dropped) return 200000;
      const value = await original(method, params);
      if (method === "getLatestBlockhash" && dropped)
        (
          value as { value: { lastValidBlockHeight: number } }
        ).value.lastValidBlockHeight = 300000;
      return value;
    };
    const p = await f.engine.prepare("devnet", "test");
    await f.engine.wait();
    const approved = (await f.engine.status("devnet")).job!;
    await f.engine.start(p.id, "devnet");
    await f.engine.wait();
    const done = await f.engine.status("devnet", true);
    assert.equal(done.job!.phase, "complete", done.job!.message);
    assert.equal(done.job!.deposit, approved.deposit);
    assert.equal(done.job!.feeBudget, approved.feeBudget);
    assert.equal(done.job!.signedTransactions, 8);
    assert.equal(done.job!.operationProgress!.transactions.completed, 7);
    assert.equal(done.accounts, 0);
    assert.equal(
      f.store
        .load()[0]
        .journal.filter((e) => e.status === "expired without confirmation")
        .length,
      1,
    );
    assert.equal(done.balance, String(1000000000n - 35000n));
  } finally {
    await f.close();
  }
});
