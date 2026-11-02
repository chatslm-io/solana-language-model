import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { ReadOnlyCloneRpc, OwnedLocalRpc } from "../harness/transport";
import { outsideGit } from "../../lib/operator/external";
import { resolve } from "node:path";
test("remote clone transport rejects every mutation before network access", async () => {
  const rpc = new ReadOnlyCloneRpc("https://api.mainnet-beta.solana.com");
  for (const method of [
    "sendTransaction",
    "requestAirdrop",
    "simulateTransaction",
    "sendBundle",
    "setAccount",
    "surfnet_setAccount",
  ])
    await assert.rejects(
      rpc.read(method, ["never-broadcast-test-bytes"]),
      /upstream_mutation_forbidden/,
    );
  assert.throws(
    () => new ReadOnlyCloneRpc("http://127.0.0.1:8899"),
    /invalid_clone/,
  );
});
test("validator state guard rejects checkout paths", () =>
  assert.throws(
    () => outsideGit(resolve("private-inference/tests/ledger")),
    /outside every Git/,
  ));

test("owned local RPC rejects a port served by another process", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = server.address();
  assert.ok(endpoint && typeof endpoint !== "string");
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    const rpc = new OwnedLocalRpc(child, endpoint.port);
    await assert.rejects(rpc.pin(), /not_owned_by_validator/);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("clone read methods reject wire payloads and arbitrary parameters before fetch", async () => {
  const rpc = new ReadOnlyCloneRpc("https://api.mainnet-beta.solana.com");
  for (const params of [
    ["signed bytes"],
    [
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
      { encoding: "base64", commitment: "finalized", wire: "never-send" },
    ],
  ])
    await assert.rejects(
      rpc.read("getAccountInfo", params),
      /invalid_clone_read_parameters/,
    );
});

test("validator preflight distinguishes missing PATH, wrong version and failed execution", async () => {
  const { checkValidatorVersion } =
    await import("../harness/validator-version");
  const result = {
    status: 0,
    stdout: "solana-test-validator 3.1.10 (src:test)\n",
    stderr: "",
  };
  assert.equal(checkValidatorVersion(result), "solana-test-validator 3.1.10");
  assert.equal(
    checkValidatorVersion({ ...result, stdout: "", stderr: result.stdout }),
    "solana-test-validator 3.1.10",
  );
  assert.throws(
    () =>
      checkValidatorVersion({
        ...result,
        status: null,
        error: { code: "ENOENT" },
      }),
    /not found.*PATH/,
  );
  for (const version of ["3.1.100", "3.1.10-beta", "4.0.0"])
    assert.throws(
      () =>
        checkValidatorVersion({
          ...result,
          stdout: `solana-test-validator ${version}\n`,
        }),
      /requires exactly 3.1.10/,
    );
  assert.throws(
    () => checkValidatorVersion({ ...result, status: 1 }),
    /could not run/,
  );
  assert.throws(
    () => checkValidatorVersion({ ...result, stdout: "unexpected output" }),
    /unrecognized/,
  );
});

test("clone transport and validator JSON preserve maximum u64 rent epoch exactly", async (t) => {
  const { stringifyJsonWithBigInts } = await import("@solana/rpc-spec-types");
  const pubkey = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  const response =
    '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":123},"value":{"data":["AA==","base64"],"owner":"BPFLoader2111111111111111111111111111111111","lamports":9007199254740993,"executable":true,"rentEpoch":18446744073709551615}}}';
  t.mock.method(globalThis, "fetch", async () => new Response(response));
  const rpc = new ReadOnlyCloneRpc("https://rpc.example.invalid");
  const cloned = (await rpc.read("getAccountInfo", [
    pubkey,
    { encoding: "base64", commitment: "finalized" },
  ])) as {
    context: { slot: bigint };
    value: { lamports: bigint; rentEpoch: bigint };
  };
  assert.equal(cloned.context.slot, 123n);
  assert.equal(cloned.value.lamports, 9007199254740993n);
  assert.equal(cloned.value.rentEpoch, 18446744073709551615n);
  const file = stringifyJsonWithBigInts({ pubkey, account: cloned.value });
  assert.ok(file.includes('"rentEpoch":18446744073709551615'));
  assert.ok(file.includes('"lamports":9007199254740993'));
  assert.ok(!file.includes("1.8446744073709552e"));
});
