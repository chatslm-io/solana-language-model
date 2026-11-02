import { approvedTestSigner } from "../../tests/approved-test-signer";
/** Real SBF and actual orchestration; RPC finality/restart and journals are
 * explicitly simulated. Model-bearing transaction bytes never touch disk. */
import test from "node:test";
import assert from "node:assert/strict";
import { runUploadRestartText } from "../harness/upload-restart";
import type { startFrozenLocalValidator } from "../harness/fork";
import { simulatedRpc } from "./fork-rpc-fixture";
import {
  TransactionCoordinator,
  type Journal,
  type PendingTransaction,
  type LocalSubmissionTransport,
} from "../../private-inference/coordinator/transactions";
import type { PrivateDirectory } from "../../lib/operator/external";

/** Test double only: durable coordinator behavior has separate fault tests. */
class MemoryJournal extends TransactionCoordinator {
  private budget?: Omit<Journal, "version" | "transactions">;
  readonly entries: PendingTransaction[] = [];
  constructor(private readonly testTransport: LocalSubmissionTransport) {
    super("/memory-only/no-files", testTransport);
  }
  override async initialize(budget: Omit<Journal, "version" | "transactions">) {
    assert.equal(this.budget, undefined);
    this.budget = budget;
  }
  override async submit(tx: Omit<PendingTransaction, "state">) {
    assert.ok(this.budget);
    const existing = this.entries.find((e) => e.operation === tx.operation);
    if (existing) {
      assert.equal(existing.signature, tx.signature);
      assert.equal(existing.wireBase64, tx.wireBase64);
      return existing.state;
    }
    const fee = this.entries.reduce(
      (n, e) => n + BigInt(e.fee),
      BigInt(tx.fee),
    );
    const rent = this.entries.reduce(
      (n, e) => n + BigInt(e.rent),
      BigInt(tx.rent),
    );
    assert.ok(fee <= BigInt(this.budget.feeAllowance));
    assert.ok(rent <= BigInt(this.budget.rentAllowance));
    assert.ok(
      fee + rent + BigInt(this.budget.cleanupReserve) <=
        BigInt(this.budget.available),
    );
    const entry: PendingTransaction = { ...tx, state: "reserved" };
    this.entries.push(entry);
    assert.equal(
      await this.testTransport.sendExact(tx.wireBase64),
      tx.signature,
    );
    entry.state = "broadcast";
    return entry.state;
  }
  override async reconcile(operation: string) {
    const entry = this.entries.find((e) => e.operation === operation);
    assert.ok(entry);
    const state = await this.testTransport.status(entry.signature);
    if (state === "finalized" || state === "failed") entry.state = state;
    return entry.state;
  }
}

test(
  "transactional complete upload, simulated validator restart, raw-text SBF inference and all-rent recovery",
  { timeout: 240000 },
  async () => {
    let current = simulatedRpc(),
      starts = 0,
      stops = 0,
      replayReads = 0;
    const journals: MemoryJournal[] = [];
    const progress = {
      log(message: string) {
        process.stderr.write(`[combined SBF / simulated RPC] ${message}\n`);
      },
      async run<T>(stage: string, action: () => Promise<T>) {
        current.setOperation(stage);
        try {
          return await action();
        } catch (error) {
          process.stderr.write(
            `Failed test stage ${stage}: ${String(error)}\n`,
          );
          throw error;
        }
      },
    };
    const starter = (async (
      ...args: Parameters<typeof startFrozenLocalValidator>
    ) => {
      const [, , fixture, retained, options] = args;
      assert.equal(retained, undefined);
      assert.ok(options);
      assert.equal(options.phase, starts === 0 ? "create" : "resume");
      if (starts === 0) {
        assert.equal(
          current.svm.getProgramAccounts(fixture.program).length,
          0,
          "no model or tokenizer accounts may be injected at genesis",
        );
      } else {
        const previous = current;
        current = simulatedRpc();
        const stored = previous.svm.getProgramAccounts(fixture.program);
        assert.equal(
          stored.length,
          575,
          "all model and table accounts were actually uploaded",
        );
        // Explicit test-only ledger reload: copy actual executed state into a new VM.
        for (const a of stored) current.svm.setAccount(a);
        const owner = previous.svm.getAccount(fixture.signer.address);
        assert.ok(owner.exists);
        current.svm.setAccount({ ...owner, address: fixture.signer.address });
      }
      starts++;
      return {
        rpc: {
          ...current.rpc,
          async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
            if (method === "getSlot" && starts === 1) return 100 as T;
            if (method === "getSlot" && starts === 2 && replayReads < 2)
              return (++replayReads === 1 ? 99 : 100) as T;
            if (starts === 2 && method === "getMultipleAccounts")
              assert.equal(
                replayReads,
                2,
                "must wait for replay before verifying uploaded accounts",
              );
            return current.rpc.rpc<T>(method, params);
          },
        },
        state: "/memory-only",
        evidence: {},
        restartPin: {
          genesis: "11111111111111111111111111111111",
          clone: {},
          programAccounts: [],
          binarySha256: "0".repeat(64),
        },
        async close() {
          stops++;
        },
      };
    }) as unknown as typeof startFrozenLocalValidator;
    const result = await runUploadRestartText(
      "/memory-only",
      progress,
      starter,
      {
        signer: await approvedTestSigner(),
        inferenceSigner: await approvedTestSigner(1),
        privateDirectory: (p) => p as PrivateDirectory,
        createJournal: (_path, rpc) => {
          const journal = new MemoryJournal(rpc);
          journals.push(journal);
          return journal;
        },
      },
    );
    assert.equal(starts, 2);
    assert.equal(stops, 2);
    assert.equal(replayReads, 2);
    assert.equal(result.genesisModelAccounts, 0);
    assert.equal(result.modelUploadTested, true);
    assert.equal(result.refundVerified, true);
    assert.equal(result.inference.refundVerified, true);
    assert.equal(result.inference.benchmark?.forwardsExecuted, 5);
    assert.equal(result.outputs.length, 1);
    assert.equal(result.referenceParity, true);
    assert.equal(result.totalTransactions, 7139);
    assert.equal(current.svm.getProgramAccounts(current.program).length, 0);
    assert.ok(
      journals.flatMap((j) => j.entries).every((e) => e.state === "finalized"),
    );
    progress.log(
      JSON.stringify({
        scope: "real SBF; simulated restart/finality; memory journals",
        upload: { ...result.upload, receipts: undefined },
        recovery: { ...result.recovery, receipts: undefined },
        inferenceTransactions: result.inference.transactions.length,
        outputs: result.outputs,
      }),
    );
  },
);
