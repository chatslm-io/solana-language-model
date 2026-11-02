import { approvedTestSigner } from "../../tests/approved-test-signer";
/** Receipt availability diagnostics with real SBF and controlled local RPC metadata. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lamports } from "@solana/kit";
import { runForkModel } from "../harness/fork-model";
import { prepareModelFixture } from "../harness/model-fixture";
import { prepareTokenizerFixture } from "../harness/tokenizer-fixture";
import { TransactionCoordinator } from "../coordinator/transactions";
import type { PrivateDirectory } from "../../lib/operator/external";
import { simulatedRpc } from "./fork-rpc-fixture";
let prepared:
  | Promise<{
      fixture: Awaited<ReturnType<typeof prepareModelFixture>>;
      tokenizer: Awaited<ReturnType<typeof prepareTokenizerFixture>>;
    }>
  | undefined;
function fixtures() {
  return (prepared ??= (async () => {
    const fixture = await prepareModelFixture(
      undefined,
      undefined,
      undefined,
      await approvedTestSigner(),
    );
    return { fixture, tokenizer: await prepareTokenizerFixture(fixture) };
  })());
}
async function exercise(pruned: boolean) {
  const { fixture, tokenizer } = await fixtures(),
    sim = simulatedRpc(),
    directory = mkdtempSync("/tmp/slm-receipt-prune-test-");
  for (const a of [...fixture.accounts, ...tokenizer.accounts])
    sim.svm.setAccount({
      address: a.address,
      data: a.data,
      programAddress: fixture.program,
      lamports: lamports(a.lamports),
      space: BigInt(a.data.length),
      executable: false,
    });
  let missingReads = 0,
    firstAvailableQueries = 0,
    observedSlot = 0;
  const logs: string[] = [];
  const transport = {
    ...sim.rpc,
    async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
      if (method === "getTransaction") {
        const receipt = sim.receipts.get(params[0] as string),
          config = params[1] as { commitment?: string };
        if (
          receipt?.operation === "create-text" &&
          config.commitment === "finalized" &&
          (pruned || missingReads < 2)
        ) {
          observedSlot = receipt.slot;
          missingReads++;
          return null as T;
        }
      }
      if (method === "getFirstAvailableBlock") {
        firstAvailableQueries++;
        return (observedSlot + (pruned ? 1 : 0)) as T;
      }
      return sim.rpc.rpc<T>(method, params);
    },
  };
  try {
    let result: Awaited<ReturnType<typeof runForkModel>> | undefined,
      error: unknown;
    const started = performance.now();
    try {
      result = await runForkModel(
        transport,
        directory,
        {
          log(message) {
            logs.push(message);
          },
          async run<T>(_stage: string, action: () => Promise<T>) {
            return action();
          },
        },
        fixture,
        {
          messages: [{ role: "user", content: "Hi" }],
          outputs: 1,
          tokenizer,
          tokenizeOnly: true,
        },
        (path, rpc) => {
          const journal = new TransactionCoordinator(path, rpc, {
              outsideGit(path) {
                assert.ok(path.startsWith(directory + "/"));
              },
              privateDirectory(path) {
                assert.ok(path.startsWith(directory + "/"));
                mkdirSync(path, { recursive: true, mode: 0o700 });
                return path as PrivateDirectory;
              },
            }),
            submit = journal.submit.bind(journal);
          journal.submit = async (request) => {
            sim.setOperation(request.operation);
            return submit(request);
          };
          return journal;
        },
        {
          confirmation: "confirmed",
          pendingWindow: 2,
          timeoutMs: 1000,
          pollMs: 1,
        },
      );
    } catch (caught) {
      error = caught;
    }
    const elapsedMs = performance.now() - started;
    const journal = JSON.parse(
      readFileSync(join(directory, "setup", "transactions.json"), "utf8"),
    );
    return {
      result,
      error,
      sim,
      missingReads,
      firstAvailableQueries,
      logs,
      journal,
      elapsedMs,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test(
  "proven pruned finalized receipt fails immediately and does not repeat checkpoint polling or close accounts",
  { timeout: 120000 },
  async () => {
    const x = await exercise(true);
    assert.equal(x.result, undefined);
    assert.match(String(x.error), /public_execution_receipt_pruned/);
    assert.equal(x.missingReads, 1);
    assert.equal(x.firstAvailableQueries, 1);
    assert.ok(
      x.elapsedMs < 1000,
      "must not spend one or two full receipt timeouts",
    );
    assert.ok(
      x.logs.some(
        (line) =>
          line.includes("first available block") &&
          line.includes("stopping cleanup"),
      ),
    );
    assert.equal(
      x.sim.events.some(
        (event) =>
          event.kind === "send" && event.operation?.startsWith("close-"),
      ),
      false,
    );
    assert.equal(x.journal.transactions[0].state, "broadcast");
  },
);
test(
  "null receipt whose block remains available is retried and still requires finalized metadata",
  { timeout: 120000 },
  async () => {
    const x = await exercise(false);
    assert.equal(x.error, undefined);
    assert.equal(x.result?.refundVerified, true);
    assert.equal(x.missingReads, 2);
    assert.equal(x.firstAvailableQueries, 2);
    assert.ok(
      x.sim.events.some(
        (event) =>
          event.kind === "receipt" &&
          event.operation === "create-text" &&
          event.commitment === "finalized",
      ),
    );
    assert.ok(
      x.journal.transactions.every(
        (entry: { state: string }) => entry.state === "finalized",
      ),
    );
  },
);
