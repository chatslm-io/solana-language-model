import { approvedTestSigner } from "../../tests/approved-test-signer";
/** Real SBF with deliberately separate simulated confirmed/finalized observations. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
async function exercise(
  mode: "confirmed" | "finalized",
  fault?: "lost" | "failed" | "unknown" | "broadcast" | "fork",
  receiptLagReads = 0,
) {
  const { fixture, tokenizer } = await fixtures(),
    sim = simulatedRpc({
      fault,
      faultOperation: "tokenizer-step-0",
      receiptLagReads,
    }),
    directory = mkdtempSync("/tmp/slm-public-confirmation-test-");
  for (const account of [...fixture.accounts, ...tokenizer.accounts])
    sim.svm.setAccount({
      address: account.address,
      data: account.data,
      programAddress: fixture.program,
      lamports: lamports(account.lamports),
      space: BigInt(account.data.length),
      executable: false,
    });
  const progress = {
    log() {},
    async run<T>(_stage: string, action: () => Promise<T>) {
      return action();
    },
  };
  const execute = () =>
    runForkModel(
      sim.rpc,
      directory,
      progress,
      fixture,
      {
        messages: [{ role: "user", content: "Hi" }],
        outputs: 1,
        tokenizer,
        tokenizeOnly: true,
      },
      (path, transport) => {
        const journal = new TransactionCoordinator(path, transport, {
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
      { confirmation: mode, pendingWindow: 2, timeoutMs: 100, pollMs: 1 },
    );
  try {
    return {
      sim,
      result: await execute(),
      error: undefined,
      fixture,
      tokenizer,
    };
  } catch (error) {
    return { sim, result: undefined, error, fixture, tokenizer };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test(
  "confirmed runner advances before finality but finalizes results before closing rent",
  { timeout: 120000 },
  async () => {
    const { sim, result, error, fixture, tokenizer } =
      await exercise("confirmed");
    assert.ifError(error);
    assert.ok(result);
    assert.equal(result.refundVerified, true);
    assert.equal(result.inferenceExecuted, false);
    assert.equal(result.onchainPrompt.length, 5);
    assert.equal(sim.metrics().laterBeforeFinality, true);
    assert.equal(sim.metrics().maxPending, 2);
    const firstClose = sim.events.findIndex(
      (e) => e.kind === "send" && e.operation?.startsWith("close-"),
    );
    assert.ok(firstClose > 0);
    for (const [index, event] of sim.events.entries())
      if (event.kind === "send" && !event.operation?.startsWith("close-")) {
        const finalized = sim.events.findIndex(
          (e) => e.kind === "finalized" && e.operation === event.operation,
        );
        assert.ok(
          finalized > index && finalized < firstClose,
          "all result transactions must finalize before cleanup begins",
        );
      }
    assert.ok(
      sim.events.some(
        (e) =>
          e.kind === "account" &&
          e.commitment === "confirmed" &&
          (e.minContextSlot ?? 0) > 0,
      ),
    );
    assert.ok([...sim.receipts.values()].every((receipt) => receipt.finalized));
    assert.equal(sim.svm.getAccount(fixture.client.session).exists, false);
    assert.equal(sim.svm.getAccount(tokenizer.client.scratch).exists, false);
  },
);
test(
  "strict-finalized runner never submits the next transaction before prior finality",
  { timeout: 120000 },
  async () => {
    const { sim, result, error } = await exercise("finalized");
    assert.ifError(error);
    assert.ok(result?.refundVerified);
    assert.equal(sim.metrics().laterBeforeFinality, false);
    assert.equal(sim.metrics().maxPending, 1);
  },
);
for (const fault of ["lost", "failed", "unknown"] as const)
  test(
    `confirmed ${fault} signature stops execution without racing cleanup`,
    { timeout: 120000 },
    async () => {
      const { sim, result, error } = await exercise("confirmed", fault);
      assert.equal(result, undefined);
      assert.ok(error instanceof Error);
      assert.equal(sim.metrics().faultObserved, true);
      const problematic = sim.events.findIndex(
        (e) => e.kind === "send" && e.operation === "tokenizer-step-0",
      );
      assert.ok(problematic >= 0);
      if (fault !== "failed")
        assert.equal(
          sim.events.some(
            (e) => e.kind === "send" && e.operation?.startsWith("close-"),
          ),
          false,
          "uncertain pending window must not race account closure",
        );
      else {
        const failed = sim.events.findIndex((e) => e.kind === "failed");
        assert.ok(failed > problematic);
        for (let i = failed + 1; i < sim.events.length; i++) {
          const event = sim.events[i];
          if (event.kind === "send")
            assert.ok(
              event.operation?.startsWith("close-"),
              "failed execution permits recovery only",
            );
        }
      }
      if (fault === "unknown")
        assert.equal(
          sim.events.some(
            (e) => e.kind === "send" && e.operation === "tokenizer-step-1",
          ),
          false,
        );
    },
  );

test(
  "lost submission reply reconciles the exact broadcast before recovering rent",
  { timeout: 120000 },
  async () => {
    const { sim, result, error, fixture, tokenizer } = await exercise(
      "confirmed",
      "broadcast",
    );
    assert.equal(result, undefined);
    assert.ok(error instanceof Error);
    assert.match(error.message, /test_lost_submission_reply/);
    assert.equal(sim.metrics().faultObserved, true);
    const sends = sim.events.filter((e) => e.kind === "send");
    assert.equal(
      sends.filter((e) => e.operation === "tokenizer-step-0").length,
      1,
    );
    assert.equal(
      sends.some((e) => e.operation === "tokenizer-step-1"),
      false,
    );
    const finalized = sim.events.findIndex(
        (e) => e.kind === "finalized" && e.operation === "tokenizer-step-0",
      ),
      closed = sim.events.findIndex(
        (e) => e.kind === "send" && e.operation?.startsWith("close-"),
      );
    assert.ok(finalized >= 0 && closed > finalized);
    assert.equal(sim.svm.getAccount(fixture.client.session).exists, false);
    assert.equal(sim.svm.getAccount(tokenizer.client.scratch).exists, false);
  },
);
test(
  "a changed observed transaction slot blocks progression and cleanup",
  { timeout: 120000 },
  async () => {
    const { sim, result, error } = await exercise("confirmed", "fork");
    assert.equal(result, undefined);
    assert.ok(error instanceof Error);
    assert.match(error.message, /fork_changed/);
    assert.equal(sim.metrics().faultObserved, true);
    assert.equal(
      sim.events.some(
        (e) => e.kind === "send" && e.operation?.startsWith("close-"),
      ),
      false,
    );
  },
);

test(
  "confirmed receipt index lag retries reads without signing replacement transactions",
  { timeout: 120000 },
  async () => {
    const { sim, result, error } = await exercise("confirmed", undefined, 1);
    assert.ifError(error);
    assert.ok(result?.refundVerified);
    assert.ok(sim.metrics().receiptLagReturns > 0);
    const sends = sim.events.filter((e) => e.kind === "send");
    assert.equal(sends.length, 10);
    assert.equal(new Set(sends.map((e) => e.operation)).size, sends.length);
    assert.equal(result.transactions.length, sends.length);
  },
);
