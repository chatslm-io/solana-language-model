import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  createRunLogs,
  writeProtectedResult,
  compactRunResult,
} from "../harness/logging";
import type { PrivateDirectory } from "../../lib/operator/external";
test("public run logs retain full evidence while terminal summary omits transaction arrays", async () => {
  const state = mkdtempSync("/tmp/slm-public-log-test-"),
    messages: string[] = [],
    paths = {
      privateDirectory(path: string) {
        assert.equal(path, state);
        mkdirSync(path, { recursive: true, mode: 0o700 });
        return path as PrivateDirectory;
      },
    },
    consoleProgress = {
      log(m: string) {
        messages.push(m);
      },
      async run<T>(_s: string, action: () => Promise<T>) {
        return action();
      },
    };
  try {
    const logs = createRunLogs(state, consoleProgress, paths);
    for (let i = 0; i < 3; i++)
      await logs.progress.run(
        `token-0-batch-${i}: reserve, submit locally, confirmed (90s timeout)`,
        async () => {},
      );
    logs.progress.log("Completed onchain forward 1/1");
    const result = {
      outputs: [1047],
      transactions: [{ signature: "public-test-signature", fee: 5000 }],
      onchainPrompt: [1],
      refundVerified: true,
      elapsedMs: 123,
    };
    const saved = logs.writeResult(result);
    logs.close();
    assert.deepEqual(
      JSON.parse(readFileSync(saved.resultPath, "utf8")),
      result,
    );
    assert.equal(
      (saved.summary as Record<string, unknown>).transactions,
      undefined,
    );
    assert.equal(
      (saved.summary as Record<string, unknown>).onchainPrompt,
      undefined,
    );
    assert.equal(saved.summary.transactionCount, 1);
    assert.ok(messages.length < 7);
    assert.ok(readFileSync(saved.progressPath, "utf8").includes("batch-2"));
    assert.ok(readFileSync(saved.progressPath, "utf8").includes(" — done"));
    assert.equal(statSync(saved.resultPath).mode & 0o777, 0o600);
    assert.equal(statSync(saved.progressPath).mode & 0o777, 0o600);
    assert.throws(() => logs.writeResult(result), /EEXIST/);
    assert.throws(() => logs.progress.log("late"), /closed/);
    const compare = writeProtectedResult(
      state,
      "comparison.json",
      { sameOutput: true },
      paths,
    );
    assert.equal(compare, join(state, "comparison.json"));
    assert.deepEqual(JSON.parse(readFileSync(compare, "utf8")), {
      sameOutput: true,
    });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
test("log path rejection precedes file creation and summaries use a fixed field list", () => {
  const consoleProgress = {
    log() {},
    async run<T>(_s: string, action: () => Promise<T>) {
      return action();
    },
  };
  assert.throws(
    () =>
      createRunLogs("/not-used", consoleProgress, {
        privateDirectory() {
          throw Error("protected path rejected");
        },
      }),
    /protected path rejected/,
  );
  const summary = compactRunResult({
    outputs: [1],
    transactions: [],
    unexpectedRawInput: "not forwarded",
  });
  assert.equal(summary.unexpectedRawInput, undefined);
  const combined = compactRunResult({
    totalTransactions: 7139,
    upload: { receipts: [1] },
    referenceParity: true,
  });
  assert.equal(combined.transactionCount, 7139);
  assert.equal(combined.referenceParity, true);
  assert.equal(combined.upload, undefined);
});
