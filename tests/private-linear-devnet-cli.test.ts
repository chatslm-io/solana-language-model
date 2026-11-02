import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDevnetArguments,
  cappedDevnetConfig,
  validateDevnetJournal,
} from "../scripts/private-linear-devnet";
import type { OperatorConfig } from "../lib/operator/config";
const OWNER = "11111111111111111111111111111111";
const HASH = "a".repeat(64);
function config(overrides: Partial<OperatorConfig> = {}): OperatorConfig {
  return {
    cluster: "devnet",
    program: null,
    rpc: "https://rpc.example.invalid",
    rpcDisplay: "https://rpc.example.invalid/…",
    rpcPolicy: { mode: "free", rps: 50, sendRps: 5, scanRps: 25 },
    maxDeposit: "8000000000",
    maxFees: "50000000",
    maxTransactions: 10000,
    ...overrides,
  };
}
type Journal = Parameters<typeof validateDevnetJournal>[0];
// Deliberately only the identity/cap fields inspected by this validator; no
// disk journal, signing key, transaction bytes, or network operation is created.
function journal(): Journal {
  return {
    version: 1,
    job: {
      owner: OWNER,
      cluster: "devnet",
      purpose: "private-linear-devnet-v1",
    },
    inferenceFeesReserved: "0",
    retirementFeesReserved: "0",
    history: [],
  } as unknown as Journal;
}
test("devnet CLI defaults to read-only quote and requires the exact approval syntax for mutations", () => {
  assert.deepEqual(parseDevnetArguments([]), {
    action: "--quote",
    approvedBinary: undefined,
  });
  for (const action of ["--quote", "--prepare"])
    assert.deepEqual(parseDevnetArguments([action]), {
      action,
      approvedBinary: undefined,
    });
  for (const action of ["--execute", "--recover"])
    assert.deepEqual(parseDevnetArguments([action, "--approve-binary", HASH]), {
      action,
      approvedBinary: HASH,
    });
  for (const args of [
    ["--execute"],
    ["--recover"],
    ["--execute", HASH],
    ["--execute", "--approve-binary"],
    ["--execute", "--approve-binary", "A".repeat(64)],
    ["--execute", "--approve-binary", HASH + "0"],
    ["--execute", "--approve-binary", HASH, "--mainnet"],
    ["--execute", "--approve", HASH],
    ["--quote", "--execute"],
    ["--prepare", "--approve-binary", HASH],
    ["--mainnet"],
    ["--execute", "--approve-binary", ""],
    ["--recover", "--approve-binary", "../binary"],
  ])
    assert.throws(() => parseDevnetArguments(args), /usage/);
});
test("hard caps reserve inference/recovery overhead and never raise stricter operator budgets", () => {
  const broad = Object.freeze(config());
  const hard = cappedDevnetConfig(broad);
  assert.equal(hard.config.maxDeposit, "300000000");
  assert.equal(hard.totalFees, 1000000n);
  assert.equal(hard.config.maxFees, "980000");
  assert.equal(hard.totalTransactions, 100);
  assert.equal(hard.config.maxTransactions, 94);
  for (const limits of [
    { maxDeposit: "123456", maxFees: "100000", maxTransactions: 20 },
    { maxDeposit: "0", maxFees: "20001", maxTransactions: 7 },
    { maxDeposit: "299999999", maxFees: "999999", maxTransactions: 99 },
  ]) {
    const source = Object.freeze(config(limits));
    const before = JSON.stringify(source),
      result = cappedDevnetConfig(source);
    assert.ok(BigInt(result.config.maxDeposit) <= BigInt(source.maxDeposit));
    assert.ok(result.totalFees <= BigInt(source.maxFees));
    assert.equal(BigInt(result.config.maxFees) + 20000n, result.totalFees);
    assert.ok(result.totalTransactions <= source.maxTransactions);
    assert.equal(result.config.maxTransactions + 6, result.totalTransactions);
    assert.equal(result.config.rpc, source.rpc);
    assert.deepEqual(result.config.rpcPolicy, source.rpcPolicy);
    assert.equal(JSON.stringify(source), before);
  }
});
test("operator budgets too small for reserved overhead fail instead of increasing caps", () => {
  for (const maxFees of ["0", "1", "19999", "20000"])
    assert.throws(
      () => cappedDevnetConfig(config({ maxFees })),
      /operator_caps_too_small/,
    );
  for (const maxTransactions of [1, 5, 6])
    assert.throws(
      () => cappedDevnetConfig(config({ maxTransactions })),
      /operator_caps_too_small/,
    );
});
test("saved journal identity stays bound to the exact owner, devnet and isolated purpose", () => {
  const original = journal();
  assert.doesNotThrow(() => validateDevnetJournal(original, OWNER));
  assert.throws(
    () =>
      validateDevnetJournal(
        original,
        "BPFLoaderUpgradeab1e11111111111111111111111",
      ),
    /journal_identity_mismatch/,
  );
  for (const mutate of [
    (value: Journal) => {
      value.version = 2 as never;
    },
    (value: Journal) => {
      value.job.cluster = "mainnet-beta";
    },
    (value: Journal) => {
      value.job.purpose = "storage-program" as never;
    },
    (value: Journal) => {
      value.job = undefined as never;
    },
    (value: Journal) => {
      value.history = undefined as never;
    },
    (value: Journal) => {
      value.history = new Array(5).fill({});
    },
  ]) {
    const value = journal();
    mutate(value);
    assert.throws(
      () => validateDevnetJournal(value, OWNER),
      /journal_identity_mismatch/,
    );
  }
});
test("saved extra-fee reservations cannot exceed either approved allowance", () => {
  for (const field of [
    "inferenceFeesReserved",
    "retirementFeesReserved",
  ] as const) {
    for (const value of [
      "10001",
      "999999999999999999999999999999999",
      "-1",
      "01",
      "1.0",
      "",
    ]) {
      const state = journal();
      state[field] = value;
      assert.throws(
        () => validateDevnetJournal(state, OWNER),
        /journal_identity_mismatch/,
      );
    }
    const maximum = journal();
    maximum[field] = "10000";
    assert.doesNotThrow(() => validateDevnetJournal(maximum, OWNER));
  }
});
