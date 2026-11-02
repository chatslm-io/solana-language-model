import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_LEDGER_RETENTION_SHREDS,
  localValidatorArgs,
} from "../harness/validator-args";
test("local validator explicitly retains finalized history without overriding execution limits", () => {
  const args = localValidatorArgs({
    state: "/external/protected/run",
    port: 18899,
    cloneAddress: "public-clone",
    cloneFile: "/external/protected/run/clone.json",
    program: "pinned-program",
    binary: "/external/build/program.so",
  });
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(LOCAL_LEDGER_RETENTION_SHREDS, 1000000);
  assert.equal(value("--limit-ledger-size"), "1000000");
  assert.equal(value("--ledger"), "/external/protected/run/ledger");
  assert.equal(value("--bind-address"), "127.0.0.1");
  assert.equal(value("--rpc-port"), "18899");
  assert.equal(value("--faucet-port"), "18900");
  for (const forbidden of [
    "--compute-unit-limit",
    "--transaction-account-lock-limit",
    "--warp-slot",
    "--deactivate-feature",
    "--url",
  ])
    assert.equal(args.includes(forbidden), false);
  assert.equal(args.filter((a) => a === "--limit-ledger-size").length, 1);
  // At observed256data-shreds/slot, capacity exceeds64slots of submitted work,
  // 32slot finality lag and90s metadata timeout at400ms/slot by over10x.
  assert.ok(LOCAL_LEDGER_RETENTION_SHREDS / 256 > (64 + 32 + 90000 / 400) * 10);
});
test("retained validator resumes without reset, cloning or genesis program injection", () => {
  const args = localValidatorArgs({
    state: "/external/retained",
    port: 18899,
    cloneAddress: "unused",
    cloneFile: "unused",
    program: "unused",
    binary: "unused",
    resume: true,
  });
  assert.equal(args[args.indexOf("--ledger") + 1], "/external/retained/ledger");
  for (const flag of [
    "--account",
    "--bpf-program",
    "--reset",
    "--url",
    "--clone",
    "--warp-slot",
    "--compute-unit-limit",
  ])
    assert.equal(args.includes(flag), false);
  assert.equal(args[args.indexOf("--limit-ledger-size") + 1], "1000000");
});
