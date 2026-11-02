import { test } from "node:test";
import assert from "node:assert/strict";
import { getWallets } from "@wallet-standard/app";
import type { Wallet } from "@wallet-standard/base";
import {
  generateKeyPairSigner,
  getAddressEncoder,
  blockhash,
  getTransactionEncoder,
  getTransactionDecoder,
  signTransaction,
} from "@solana/kit";
import { connectPhantom } from "../lib/chain/wallet";
import { transaction, assertSignedMessage } from "../lib/chain/client";
import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { applyPhantomPriorityFees } from "./phantom-fees";
import { instruction } from "../lib/chain/protocol";
import { TEST_PROGRAM } from "./vm-rpc";

test("Wallet Standard sends the whole array in one request and rejects partial responses or wallet changes", async () => {
  const payer = await generateKeyPairSigner();
  const account = {
    address: payer.address,
    publicKey: Uint8Array.from(getAddressEncoder().encode(payer.address)),
    chains: ["solana:devnet"],
    features: ["solana:signTransaction"],
  };
  let calls = 0,
    inputs = 0,
    incomplete = false;
  const wallet = {
    version: "1.0.0",
    name: "Phantom",
    icon: "data:image/svg+xml,<svg/>",
    chains: ["solana:devnet"],
    accounts: [account],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => ({ accounts: [account] }),
      },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: [0],
        signTransaction: async (...args: { transaction: Uint8Array }[]) => {
          calls++;
          inputs = args.length;
          return args
            .slice(0, incomplete ? 1 : args.length)
            .map((a) => ({ signedTransaction: a.transaction }));
        },
      },
    },
  };
  const unregister = getWallets().register(wallet as unknown as Wallet);
  try {
    const c = await connectPhantom(() => {}),
      wires = [new Uint8Array([1]), new Uint8Array([2])];
    assert.deepEqual(await c.signAll(wires, "devnet"), wires);
    assert.equal(calls, 1);
    assert.equal(inputs, 2);
    incomplete = true;
    await assert.rejects(c.signAll(wires, "devnet"), /incomplete/);
    wallet.accounts = [];
    await assert.rejects(c.signAll(wires, "devnet"), /changed/);
    assert.equal(calls, 2);
    await c.disconnect();
  } finally {
    unregister();
  }
});

test("injected Phantom uses typed signing and returns complete, unchanged signed transactions", async () => {
  const payer = await generateKeyPairSigner(),
    registry = await generateKeyPairSigner();
  const txs = [0, 1].map((i) =>
    transaction(
      payer.address,
      instruction(TEST_PROGRAM, payer.address, registry.address, "closeShard", {
        shard: registry.address,
        index: i,
      }),
      blockhash("11111111111111111111111111111111"),
      100n,
    ),
  );
  let calls = 0;
  const sign = async (tx: VersionedTransaction) => {
    assert.equal(tx.version, 0);
    const signed = await signTransaction(
      [payer.keyPair],
      getTransactionDecoder().decode(applyPhantomPriorityFees(tx.serialize())),
    );
    return VersionedTransaction.deserialize(
      Uint8Array.from(getTransactionEncoder().encode(signed)),
    );
  };
  const provider = {
    isPhantom: true,
    publicKey: { toString: () => payer.address },
    connect: async () => ({ publicKey: { toString: () => payer.address } }),
    disconnect: async () => {},
    on: () => {},
    removeListener: () => {},
    request: async () => {
      assert.fail("Raw request API must not be used");
    },
    signTransaction: async (tx: VersionedTransaction) => {
      calls++;
      return sign(tx);
    },
    signAllTransactions: async (transactions: VersionedTransaction[]) => {
      calls++;
      assert.deepEqual(
        transactions.map((t) => Uint8Array.from(t.message.serialize())),
        txs.map((t) => t.message),
      );
      return Promise.all(transactions.map(sign));
    },
  };
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { phantom: { solana: provider } },
  });
  try {
    const c = await connectPhantom(() => {});
    const signed = await c.signAll(
      txs.map((t) => t.wire),
      "devnet",
    );
    assert.equal(calls, 1);
    for (let i = 0; i < signed.length; i++) {
      assertSignedMessage(
        { message: txs[i].message, authority: payer.address },
        signed[i],
      );
      assert.ok(
        getTransactionDecoder()
          .decode(signed[i])
          .signatures[payer.address]?.some(Boolean),
      );
    }
    const single = await c.sign(txs[0].wire, "devnet");
    assertSignedMessage(
      { message: txs[0].message, authority: payer.address },
      single,
    );
    assert.equal(calls, 2);
    await c.disconnect();
  } finally {
    if (prior) Object.defineProperty(globalThis, "window", prior);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("explicit preview fees prevent Phantom fee injection; changed fees still cannot be broadcast", async () => {
  const payer = await generateKeyPairSigner();
  const prepared = transaction(
    payer.address,
    instruction(TEST_PROGRAM, payer.address, payer.address, "seal"),
    blockhash("11111111111111111111111111111111"),
    100n,
  );
  const message = TransactionMessage.decompile(
    VersionedTransaction.deserialize(prepared.wire).message,
  );
  const budget = message.instructions.filter((ix) =>
    ix.programId.equals(ComputeBudgetProgram.programId),
  );
  assert.equal(budget.length, 2);
  assert.equal(budget[0].data[0], 2);
  assert.equal(
    new DataView(budget[0].data.buffer, budget[0].data.byteOffset).getUint32(
      1,
      true,
    ),
    200_000,
  );
  assert.equal(budget[1].data[0], 3);
  assert.equal(
    new DataView(budget[1].data.buffer, budget[1].data.byteOffset).getBigUint64(
      1,
      true,
    ),
    0n,
  );

  const sign = async (wire: Uint8Array) =>
    Uint8Array.from(
      getTransactionEncoder().encode(
        await signTransaction(
          [payer.keyPair],
          getTransactionDecoder().decode(applyPhantomPriorityFees(wire)),
        ),
      ),
    );
  // Reproduce the original failure with the old, implicit-fee preview.
  message.instructions = message.instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  );
  const old = new VersionedTransaction(message.compileToV0Message());
  const oldSigned = await sign(old.serialize());
  assert.throws(
    () =>
      assertSignedMessage(
        { authority: payer.address, message: old.message.serialize() },
        oldSigned,
      ),
    /Wallet changed/,
  );

  assertSignedMessage(
    { authority: payer.address, message: prepared.message },
    await sign(prepared.wire),
  );
  // Explicit fee instructions are not an exception to the exact-message guard.
  message.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1n }),
  );
  const changed = await sign(
    new VersionedTransaction(message.compileToV0Message()).serialize(),
  );
  assert.throws(
    () =>
      assertSignedMessage(
        { authority: payer.address, message: prepared.message },
        changed,
      ),
    /Wallet changed/,
  );
});

test("injected signing rejects incomplete replies and times out without accepting a late signature", async (t) => {
  const payer = await generateKeyPairSigner();
  const tx = transaction(
    payer.address,
    instruction(TEST_PROGRAM, payer.address, payer.address, "seal"),
    blockhash("11111111111111111111111111111111"),
    100n,
  );
  let release: (value: unknown) => void = () => {};
  const pending = new Promise<unknown>((r) => {
    release = r;
  });
  let hang = false;
  const provider = {
    isPhantom: true,
    publicKey: { toString: () => payer.address },
    connect: async () => ({ publicKey: { toString: () => payer.address } }),
    disconnect: async () => {},
    on: () => {},
    removeListener: () => {},
    signTransaction: async () =>
      hang
        ? pending
        : { publicKey: payer.address, signature: "incomplete response" },
  };
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { phantom: { solana: provider } },
  });
  try {
    const c = await connectPhantom(() => {});
    await assert.rejects(
      c.sign(tx.wire, "devnet"),
      /did not return a signed transaction/,
    );
    hang = true;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let accepted = false;
    const request = c.sign(tx.wire, "devnet").then(() => {
      accepted = true;
    });
    const rejection = assert.rejects(request, /within two minutes/);
    t.mock.timers.tick(120000);
    await rejection;
    release(VersionedTransaction.deserialize(tx.wire));
    await Promise.resolve();
    assert.equal(accepted, false);
    await c.disconnect();
  } finally {
    if (prior) Object.defineProperty(globalThis, "window", prior);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
