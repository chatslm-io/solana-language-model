import { test } from "node:test";
import assert from "node:assert/strict";
import { address, lamports, generateKeyPairSigner } from "@solana/kit";
import { operatorFixture } from "./operator-fixture";
import { OperatorEngine } from "../lib/operator/engine";
import { account } from "../lib/chain/client";
import { sha256 } from "../lib/chain/protocol";

async function fixture() {
  const f = await operatorFixture({ stableBlockhash: true });
  f.config.program = null;
  f.config.maxDeposit = "2000000000";
  f.config.maxFees = "10000000";
  f.config.maxTransactions = 1000;
  f.config.rpcPolicy = { mode: "paid", rps: 50, sendRps: 5, scanRps: 25 };
  f.vm.svm.airdrop(f.signer.address, lamports(3000000000n));
  return f;
}
test("UI program deploy uses the real loader, verifies code and authority, pins durably and enables storage recovery", async () => {
  const f = await fixture();
  try {
    const before = f.vm.svm.getBalance(f.signer.address)!;
    const p = await f.engine.prepareProgram("devnet");
    assert.equal(f.sends(), 0);
    assert.equal(p.phase, "ready");
    assert.ok(f.deps.binary);
    assert.equal(p.binaryHash, await sha256(await f.deps.binary()));
    await f.engine.startProgram(p.id, "devnet");
    await f.engine.wait();
    const status = await f.engine.status("devnet", true);
    assert.equal(
      status.programDeployment?.phase,
      "complete",
      status.programDeployment?.message,
    );
    assert.equal(status.program, p.program);
    assert.equal(
      status.programDeployment?.completedTransactions,
      p.totalTransactions,
    );
    assert.equal(await account(f.rpc, address(p.buffer)), null);
    const code = await account(f.rpc, address(p.programData));
    assert.equal(await sha256(code!.bytes.subarray(45)), p.binaryHash);
    const saved = f.store.programJobs.at(-1)!;
    assert.equal(saved.transactions, f.sends());
    assert.ok(saved.journal.every((e) => e.status === "finalized"));
    assert.equal(
      before - f.vm.svm.getBalance(f.signer.address)!,
      BigInt(p.programRent) + BigInt(p.codeRent) + BigInt(saved.feesReserved),
    );
    const restarted = new OperatorEngine(f.deps);
    assert.equal((await restarted.status("devnet")).program, p.program);
    await assert.rejects(
      restarted.prepareProgram("devnet"),
      /already configured/,
    );
    // Loader visibility advances one slot before invoking newly deployed code.
    f.vm.svm.warpToSlot(f.vm.svm.getClock().slot + 1n);
    const tiny = await restarted.prepare("devnet", "test");
    await restarted.wait();
    assert.equal((await restarted.status("devnet")).job!.phase, "ready");
    await restarted.start(tiny.id, "devnet");
    await restarted.wait();
    const done = await restarted.status("devnet", true);
    assert.equal(done.job?.phase, "complete", done.job?.message);
    assert.equal(done.accounts, 0);
  } finally {
    await f.close();
  }
});
test("interrupted program upload can restart and reclaim all buffer rent without the binary", async () => {
  const f = await fixture();
  try {
    const before = f.vm.svm.getBalance(f.signer.address)!;
    const p = await f.engine.prepareProgram("devnet");
    f.afterSend(() => f.engine.pause(p.id));
    await f.engine.startProgram(p.id, "devnet");
    await f.engine.wait();
    const paused = (await f.engine.status("devnet")).programDeployment!;
    assert.equal(paused.phase, "paused");
    assert.equal(f.sends(), 1);
    assert.ok(await account(f.rpc, address(p.buffer)));
    await assert.rejects(f.engine.prepareProgram("devnet"), /unfinished/);
    f.afterSend(() => {});
    // Repeated expired attempts must not strand recovery behind its fee cap.
    const recovery = f.store.programJobs.at(-1)!;
    recovery.intent = "recover";
    recovery.recoveryFeeBudget = "0";
    f.store.save([]);
    const refreshed = await f.engine.prepareProgram("devnet");
    assert.equal(refreshed.id, p.id);
    assert.equal(refreshed.recoveryFeeBudget, "10000");
    assert.equal(f.sends(), 1);
    f.deps.binary = async () => {
      throw new Error("Binary removed");
    };
    const restarted = new OperatorEngine(f.deps);
    f.beforeRequest((method) => {
      if (method === "getTransaction" && f.sends() === 2)
        throw new Error("Receipt temporarily unavailable");
    });
    await restarted.startProgram(p.id, "devnet", true);
    await restarted.wait();
    assert.equal(
      (await restarted.status("devnet")).programDeployment!.phase,
      "failed",
    );
    assert.equal(await account(f.rpc, address(p.buffer)), null);
    f.beforeRequest(() => {});
    const again = new OperatorEngine(f.deps);
    await again.startProgram(p.id, "devnet", true);
    await again.wait();
    const done = (await again.status("devnet")).programDeployment!;
    assert.equal(done.phase, "recovered", done.message);
    assert.equal(await account(f.rpc, address(p.buffer)), null);
    assert.equal(await account(f.rpc, address(p.program)), null);
    assert.equal(before - f.vm.svm.getBalance(f.signer.address)!, 10000n);
  } finally {
    await f.close();
  }
});
test("program approvals bind owner, network, cost, binary and durable signatures before spending", async () => {
  const f = await fixture();
  try {
    f.config.maxDeposit = "1";
    await assert.rejects(f.engine.prepareProgram("devnet"), /cap/);
    f.config.maxDeposit = "2000000000";
    const p = await f.engine.prepareProgram("devnet");
    await assert.rejects(
      f.engine.startProgram(p.id, "mainnet-beta"),
      /network/,
    );
    const readSigner = f.deps.signer;
    f.deps.signer = async () => generateKeyPairSigner(false);
    await assert.rejects(
      f.engine.startProgram(p.id, "devnet"),
      /original local signer/,
    );
    f.deps.signer = readSigner;
    const saved = f.store.programJobs.at(-1)!;
    saved.quotedAt = 0;
    f.store.save([]);
    await assert.rejects(f.engine.startProgram(p.id, "devnet"), /expired/);
    const fresh = await f.engine.prepareProgram("devnet");
    f.deps.binary = async () => new Uint8Array([1, 2, 3]);
    await f.engine.startProgram(fresh.id, "devnet");
    await f.engine.wait();
    assert.equal(
      (await f.engine.status("devnet")).programDeployment!.phase,
      "failed",
    );
    assert.equal(f.sends(), 0);
  } finally {
    await f.close();
  }
});

test("lost deployment reply is reconciled and pinned without another deployment or fee", async () => {
  const f = await fixture();
  try {
    const p = await f.engine.prepareProgram("devnet");
    f.afterSend(() => {
      if (f.vm.svm.getAccount(address(p.program)).exists)
        throw new Error("Lost deployment response");
    });
    await f.engine.startProgram(p.id, "devnet");
    await f.engine.wait();
    assert.equal(
      (await f.engine.status("devnet")).programDeployment!.phase,
      "failed",
    );
    assert.equal(f.store.programs.devnet, undefined);
    const deployed = f.vm.svm.getAccount(address(p.program));
    assert.ok(deployed.exists && deployed.executable);
    const sends = f.sends(),
      balance = f.vm.svm.getBalance(f.signer.address);
    f.afterSend(() => {});
    const restarted = new OperatorEngine(f.deps);
    await restarted.startProgram(p.id, "devnet", true);
    await restarted.wait();
    assert.equal((await restarted.status("devnet")).program, p.program);
    assert.equal(f.sends(), sends);
    assert.equal(f.vm.svm.getBalance(f.signer.address), balance);
  } finally {
    await f.close();
  }
});

test("failure to persist a program signature prevents its broadcast", async () => {
  const f = await fixture();
  try {
    const p = await f.engine.prepareProgram("devnet");
    const original = f.store.save.bind(f.store);
    f.store.save = (jobs) => {
      if (f.store.programJobs.at(-1)!.journal.length)
        throw new Error("Journal disk full");
      original(jobs);
    };
    await f.engine.startProgram(p.id, "devnet");
    await assert.rejects(f.engine.wait(), /disk full/);
    assert.equal(f.sends(), 0);
    assert.equal(await account(f.rpc, address(p.buffer)), null);
    f.store.save = original;
  } finally {
    await f.close();
  }
});
