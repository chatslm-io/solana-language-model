import test from "node:test";
import assert from "node:assert/strict";
import { getBase58Decoder } from "@solana/kit";
import { reconcilePending } from "../lib/private-linear/devnet-pending";
import type { RpcCall } from "../runtime/publisher";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const pending = {
  signature: getBase58Decoder().decode(new Uint8Array(64).fill(37)),
  lastValidBlockHeight: "100",
};
function mock(options: {
  statuses: unknown[];
  height?: unknown;
  transaction?: unknown;
  genesis?: string;
}) {
  const calls: { method: string; params: unknown[] }[] = [];
  let read = 0;
  const rpc: RpcCall = async <T>(
    method: string,
    params: unknown[] = [],
  ): Promise<T> => {
    calls.push({ method, params });
    if (method === "getGenesisHash") return (options.genesis ?? GENESIS) as T;
    if (method === "getSignatureStatuses")
      return { value: [options.statuses[read++]] } as T;
    if (method === "getBlockHeight") return (options.height ?? 101) as T;
    if (method === "getTransaction") return (options.transaction ?? null) as T;
    throw Error("unexpected_method");
  };
  return { rpc, calls };
}
test("only finalized signature status is definitive, including finalized failure", async () => {
  for (const [err, result] of [
    [null, "finalized"],
    [{ InstructionError: [0, { Custom: 1 }] }, "failed"],
  ] as const) {
    const m = mock({ statuses: [{ confirmationStatus: "finalized", err }] });
    assert.equal(await reconcilePending(m.rpc, pending), result);
    assert.deepEqual(
      m.calls.map((c) => c.method),
      ["getGenesisHash", "getSignatureStatuses"],
    );
    assert.deepEqual(m.calls[1].params, [
      [pending.signature],
      { searchTransactionHistory: true },
    ]);
  }
});
test("absent or unfinalized status before expiry stays pending", async () => {
  for (const status of [
    null,
    { confirmationStatus: "processed", err: null },
    {
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, "InvalidArgument"] },
    },
  ]) {
    const m = mock({ statuses: [status], height: 100 });
    assert.equal(await reconcilePending(m.rpc, pending), "pending");
    assert.deepEqual(
      m.calls.map((c) => c.method),
      ["getGenesisHash", "getSignatureStatuses", "getBlockHeight"],
    );
    assert.deepEqual(m.calls[2].params, [{ commitment: "finalized" }]);
  }
});
test("definitive expiry requires expired finalized height, absent finalized transaction, and second absent history status", async () => {
  const m = mock({ statuses: [null, null], height: 101 });
  assert.equal(await reconcilePending(m.rpc, pending), "expired");
  assert.deepEqual(
    m.calls.map((c) => c.method),
    [
      "getGenesisHash",
      "getSignatureStatuses",
      "getBlockHeight",
      "getTransaction",
      "getSignatureStatuses",
    ],
  );
  assert.deepEqual(m.calls[3].params, [
    pending.signature,
    {
      encoding: "base64",
      commitment: "finalized",
      maxSupportedTransactionVersion: 1,
    },
  ]);
});
test("late transaction appearances and still-observed statuses preserve ambiguity", async () => {
  for (const status of ["processed", "confirmed"]) {
    const first = mock({
      statuses: [{ confirmationStatus: status, err: null }],
      height: 200,
    });
    assert.equal(await reconcilePending(first.rpc, pending), "pending");
    assert.equal(
      first.calls.filter((c) => c.method === "getSignatureStatuses").length,
      1,
    );
    const late = mock({
      statuses: [null, { confirmationStatus: status, err: null }],
      height: 200,
    });
    assert.equal(await reconcilePending(late.rpc, pending), "pending");
  }
  for (const [err, result] of [
    [null, "finalized"],
    ["AccountInUse", "failed"],
  ] as const) {
    const late = mock({
      statuses: [null, { confirmationStatus: "finalized", err }],
      height: 200,
    });
    assert.equal(await reconcilePending(late.rpc, pending), result);
  }
});
test("finalized transaction lookup resolves late success/failure after expiry", async () => {
  for (const [err, result] of [
    [null, "finalized"],
    [{ InstructionError: [0, "InvalidArgument"] }, "failed"],
  ] as const) {
    const m = mock({
      statuses: [null],
      transaction: { slot: 200, version: 1, meta: { err } },
    });
    assert.equal(await reconcilePending(m.rpc, pending), result);
    assert.equal(
      m.calls.filter((c) => c.method === "getSignatureStatuses").length,
      1,
    );
  }
});
test("wrong genesis, malformed evidence and unavailable RPC never become expired", async () => {
  const wrong = mock({
    statuses: [null, null],
    genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  });
  await assert.rejects(reconcilePending(wrong.rpc, pending), /wrong_network/);
  assert.equal(wrong.calls.length, 1);
  for (const statuses of [
    [undefined],
    [{}],
    [{ confirmationStatus: "confirmed" }],
    [{ confirmationStatus: "finalized", err: undefined }],
    [{ confirmationStatus: "unknown", err: null }],
    [null, undefined],
  ])
    await assert.rejects(
      reconcilePending(mock({ statuses }).rpc, pending),
      /reconciliation_unavailable/,
    );
  for (const transaction of [
    {},
    { slot: 200, version: 1, meta: null },
    { slot: -1, version: 1, meta: { err: null } },
    { slot: 200, version: 99, meta: { err: null } },
    { slot: 200, version: 1, meta: { err: undefined } },
  ])
    await assert.rejects(
      reconcilePending(mock({ statuses: [null], transaction }).rpc, pending),
      /reconciliation_unavailable/,
    );
  await assert.rejects(
    reconcilePending(mock({ statuses: [null], height: 1.5 }).rpc, pending),
    /reconciliation_unavailable/,
  );
  const unavailable: RpcCall = async <T>(): Promise<T> => {
    throw Error("provider_unavailable");
  };
  await assert.rejects(
    reconcilePending(unavailable, pending),
    /provider_unavailable/,
  );
  for (const expiry of ["-1", "1.5", "01", "18446744073709551616"])
    await assert.rejects(
      reconcilePending(unavailable, {
        ...pending,
        lastValidBlockHeight: expiry,
      }),
      /invalid_pending_transaction/,
    );
});
