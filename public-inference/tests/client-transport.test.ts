import assert from "node:assert/strict";
import test from "node:test";
import { OwnedLocalRpc } from "../harness/transport";

test("public journal status never treats a speculative execution failure as terminal", async () => {
  const rpc = Object.create(OwnedLocalRpc.prototype) as OwnedLocalRpc;
  for (const confirmationStatus of ["processed", "confirmed", "finalized"]) {
    for (const err of [null, { InstructionError: [0, "InvalidArgument"] }]) {
      rpc.rpc = async <T>() => ({ value: [{ confirmationStatus, err }] }) as T;
      assert.equal(
        await rpc.status("signature"),
        confirmationStatus === "finalized"
          ? err
            ? "failed"
            : "finalized"
          : "pending",
      );
    }
  }
  rpc.rpc = async <T>() => ({ value: [null] }) as T;
  assert.equal(await rpc.status("signature"), "unknown");
});

test("public submission checks owned genesis before confirmed preflight, with no automatic resend", async () => {
  const calls: unknown[] = [];
  // Isolate the policy override; process/socket checks are tested by the shared
  // transport suite. No socket or network is used in this test.
  const rpc = Object.create(OwnedLocalRpc.prototype) as OwnedLocalRpc;
  rpc.beforeSigning = async () => {
    calls.push("ownership-and-genesis");
  };
  rpc.rpc = async <T>(method: string, params: unknown[] = []) => {
    calls.push({ method, params });
    return "signature" as T;
  };
  assert.equal(await rpc.sendExact("exact-wire"), "signature");
  assert.deepEqual(calls, [
    "ownership-and-genesis",
    {
      method: "sendTransaction",
      params: [
        "exact-wire",
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 0,
        },
      ],
    },
  ]);
  calls.length = 0;
  rpc.beforeSigning = async () => {
    throw Error("local_genesis_changed");
  };
  await assert.rejects(rpc.sendExact("exact-wire"), /local_genesis_changed/);
  assert.deepEqual(calls, []);
});
