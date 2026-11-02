/** Real SBF through batched local sender; RPC timing/finality explicitly simulated. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { lamports } from "@solana/kit";
import { prepareModelFixture } from "../harness/model-fixture";
import { runForkModel } from "../harness/fork-model";
import { simulatedRpc } from "./fork-rpc-fixture";
import { TransactionCoordinator } from "../coordinator/transactions";
import { planBatches } from "../compiler/batches";
import type { PrivateDirectory } from "../../lib/operator/external";
test(
  "batched sender runs every compiled command in SBF and refunds owner deposits",
  { timeout: 180000 },
  async () => {
    const f = await prepareModelFixture(),
      sim = simulatedRpc(),
      root = mkdtempSync("/tmp/slm-public-batch-runner-");
    for (const a of f.accounts)
      sim.svm.setAccount({
        address: a.address,
        data: a.data,
        programAddress: f.program,
        lamports: lamports(a.lamports),
        space: BigInt(a.data.length),
        executable: false,
      });
    try {
      const result = await runForkModel(
        sim.rpc,
        root,
        {
          log() {},
          async run<T>(_stage: string, action: () => Promise<T>) {
            return action();
          },
        },
        f,
        { prompt: [1], outputs: 1 },
        (path, transport) =>
          new TransactionCoordinator(path, transport, {
            outsideGit(p) {
              assert.ok(p.startsWith(root + "/"));
            },
            privateDirectory(p) {
              assert.ok(p.startsWith(root + "/"));
              mkdirSync(p, { recursive: true, mode: 0o700 });
              return p as PrivateDirectory;
            },
          }),
      );
      assert.deepEqual(result.outputs, [1047]);
      assert.equal(result.refundVerified, true);
      assert.equal(result.inferenceExecuted, true);
      assert.ok("benchmark" in result);
      const b = result.benchmark!;
      assert.equal(b.sourceSha, f.binding.sourceSha);
      assert.equal(b.commandsExecuted, f.compiled.commands.length);
      assert.equal(b.forwardsExecuted, 1);
      assert.equal(
        b.inferenceTransactions,
        planBatches(f.compiled.commands).length,
      );
      assert.equal(b.totalTransactions, b.inferenceTransactions + 8);
      assert.ok(b.maxComputeUnits <= 1200000);
      assert.ok(b.maxWireBytes <= 1232);
      assert.equal(b.batchSizeLimit, 8);
      assert.equal(sim.svm.getAccount(f.client.session).exists, false);
      for (const state of f.client.states)
        assert.equal(sim.svm.getAccount(state).exists, false);
      process.stderr.write(
        "[batched sender simulated RPC benchmark] " + JSON.stringify(b) + "\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
