import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSigner,
  getTransactionEncoder,
  signTransaction,
  blockhash,
  address,
} from "@solana/kit";
import { instruction, parseSol, sol } from "../lib/chain/protocol";
import {
  assertSignedMessage,
  transaction,
  preview,
  submit,
  type Preview,
  type RPC,
} from "../lib/chain/client";
test("wallet may add signatures but cannot change previewed instructions", async () => {
  const payer = await generateKeyPairSigner(),
    other = await generateKeyPairSigner();
  const key = address("3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh");
  const ix = instruction(key, payer.address, other.address, "seal");
  const tx = transaction(
    payer.address,
    ix,
    blockhash("11111111111111111111111111111111"),
    100n,
  );
  const p = { message: tx.message, authority: payer.address } as Preview;
  const signed = await signTransaction([payer.keyPair], tx.tx);
  assert.doesNotThrow(() =>
    assertSignedMessage(
      p,
      Uint8Array.from(getTransactionEncoder().encode(signed)),
    ),
  );
  const changed = transaction(
    payer.address,
    { ...ix, data: new Uint8Array([7]) },
    blockhash("11111111111111111111111111111111"),
    100n,
  );
  const bad = await signTransaction([payer.keyPair], changed.tx);
  assert.throws(
    () =>
      assertSignedMessage(
        p,
        Uint8Array.from(getTransactionEncoder().encode(bad)),
      ),
    /changed/,
  );
});
test("lamport amounts round-trip without floating point loss", () => {
  for (const n of [0n, 1n, 999999999n, 1234567890123456789n])
    assert.equal(parseSol(sol(n)), n);
  for (const s of ["-1", "1e9", "NaN", "0.0000000001"])
    assert.throws(() => parseSol(s));
});

test("RPC instruction errors stay readable when Kit decodes numeric fields as bigint", async () => {
  const payer = await generateKeyPairSigner();
  const registry = (await generateKeyPairSigner()).address;
  const program = address("3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh");
  const life = {
    blockhash: blockhash("11111111111111111111111111111111"),
    lastValidBlockHeight: 100n,
  };
  const operation = {
    kind: "seal" as const,
    label: "Seal deployment",
    account: registry,
    instruction: instruction(program, payer.address, registry, "seal"),
    deposit: 0n,
    reclaim: 0n,
  };
  const error = { InstructionError: [0n, { Custom: 4n }] };
  const result = <T>(value: T) => ({ send: async () => value });
  let failSimulation = true;
  const rpc = {
    getGenesisHash: () =>
      result("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
    getAccountInfo: () => result({ value: { executable: true } }),
    getLatestBlockhash: () => result({ value: life }),
    getFeeForMessage: () => result({ value: 5000n }),
    getBalance: () => result({ value: 1000000n }),
    simulateTransaction: () =>
      result({ value: { err: failSimulation ? error : null } }),
    getBlockHeight: () => result(1n),
    sendTransaction: () => result(null),
    getSignatureStatuses: () => result({ value: [{ err: error }] }),
  } as unknown as RPC;
  const config = {
    cluster: "devnet",
    program,
    rpcDisplay: "fixture",
    maxDeposit: "0",
    maxTransactions: 1,
  };
  await assert.rejects(
    preview(rpc, config, payer.address, operation),
    /Simulation failed:.*"Custom":"4"/,
  );
  failSimulation = false;
  const p = await preview(rpc, config, payer.address, operation);
  const tx = transaction(
    payer.address,
    operation.instruction,
    life.blockhash,
    life.lastValidBlockHeight,
  );
  const signed = await signTransaction([payer.keyPair], tx.tx);
  await assert.rejects(
    submit(
      rpc,
      p,
      Uint8Array.from(getTransactionEncoder().encode(signed)),
      () => {},
    ),
    /Transaction failed:.*"Custom":"4"/,
  );
});

test("persisted run caps reject invalid counters, reserve uncertain submissions, and never prevent zero-deposit recovery", async () => {
  const { readRun, reserveRun } = await import("../lib/chain/run");
  assert.throws(() => readRun('{"deposit":"-1","transactions":0}'));
  const first = reserveRun(readRun(null), 9n, 10n, 2);
  assert.equal(first.deposit, "9");
  assert.throws(() => reserveRun(first, 2n, 10n, 2));
  const closure = reserveRun(first, 0n, 0n, 2);
  assert.equal(closure.transactions, 2);
  assert.throws(() => reserveRun(closure, 0n, 10n, 2));
});

test("cluster validation uses complete RPC genesis hashes and rejects cross-cluster endpoints", async () => {
  const { chainCheck } = await import("../lib/chain/client");
  const { vmRpc, TEST_PROGRAM } = await import("./vm-rpc");
  const vm = vmRpc();
  const { createSolanaRpc } = await import("@solana/kit");
  const { createServer } = await import("node:http");
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const b of req) data += b;
    const p = JSON.parse(data);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: p.id,
        result: await vm.request(p.method, p.params),
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    const rpc = createSolanaRpc(`http://127.0.0.1:${port}`);
    const config = {
      cluster: "devnet",
      program: TEST_PROGRAM,
      rpcDisplay: "test",
      maxDeposit: "0",
      maxTransactions: 1,
    };
    await chainCheck(rpc, config);
    await assert.rejects(
      chainCheck(rpc, { ...config, cluster: "mainnet-beta" }),
      /genesis/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
