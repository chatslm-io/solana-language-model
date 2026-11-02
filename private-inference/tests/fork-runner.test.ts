/** Real SBF through the actual fork runner; RPC finality is explicitly simulated.
 * No validator or network. Only public ciphertext journals use test path injection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  address,
  getAddressDecoder,
  getTransactionDecoder,
  getSignatureFromTransaction,
  lamports,
  type Address,
} from "@solana/kit";
import { runForkStream } from "../harness/fork-stream";
import { runForkCircuit } from "../harness/fork-circuit";
import { runForkPrimitive } from "../harness/fork-primitive";
import { verifiedBinary } from "../harness/build.mjs";
import { TransactionCoordinator } from "../coordinator/transactions";
import type { PrivateDirectory } from "../../lib/operator/external";

function simulatedRpc(
  flavor: "experimental" | "circuit" | "stream" = "experimental",
) {
  const svm = new LiteSVM();
  const program = getAddressDecoder().decode(new Uint8Array(32).fill(182));
  svm.addProgram(program, verifiedBinary(flavor));
  const receipts = new Map<
    string,
    { meta: { err: null; fee: number; computeUnitsConsumed: number } }
  >();
  const account = (key: Address) => {
    const a = svm.getAccount(key);
    return a.exists
      ? {
          owner: a.programAddress,
          data: [Buffer.from(a.data).toString("base64"), "base64"],
          lamports: Number(a.lamports),
        }
      : null;
  };
  const rpc = {
    localOnly: true as const,
    async beforeSigning() {},
    async status(signature: string) {
      return receipts.has(signature)
        ? ("finalized" as const)
        : ("unknown" as const);
    },
    async sendExact(wire: string) {
      const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
      const result = svm.sendTransaction(tx);
      if (result instanceof FailedTransactionMetadata)
        throw Error(result.err().toString());
      const signature = getSignatureFromTransaction(tx);
      receipts.set(signature, {
        meta: {
          err: null,
          fee: 5000,
          computeUnitsConsumed: Number(result.computeUnitsConsumed()),
        },
      });
      return signature;
    },
    async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
      const key = () => address(params[0] as string);
      let result: unknown;
      switch (method) {
        case "requestAirdrop": {
          svm.airdrop(key(), lamports(BigInt(params[1] as number)));
          receipts.set("local-airdrop-fixture", {
            meta: { err: null, fee: 0, computeUnitsConsumed: 0 },
          });
          result = "local-airdrop-fixture";
          break;
        }
        case "getBalance":
          result = { value: Number(svm.getBalance(key()) ?? 0n) };
          break;
        case "getGenesisHash":
          result = "11111111111111111111111111111111";
          break;
        case "getSlot":
          result = Number(svm.getClock().slot);
          break;
        case "getMinimumBalanceForRentExemption":
          result = Number(
            svm.minimumBalanceForRentExemption(BigInt(params[0] as number)),
          );
          break;
        case "getLatestBlockhash":
          svm.expireBlockhash();
          result = {
            value: {
              blockhash: svm.latestBlockhash(),
              lastValidBlockHeight: 100000,
            },
          };
          break;
        case "getTransaction":
          result = receipts.get(params[0] as string);
          break;
        case "getAccountInfo":
          result = { value: account(key()) };
          break;
        case "getProgramAccounts":
          result = svm
            .getProgramAccounts(key())
            .map((a) => ({ pubkey: a.address, account: account(a.address) }));
          break;
        default:
          throw Error(`unexpected test RPC: ${method}`);
      }
      return result as T;
    },
  };
  return { rpc, svm, program };
}

test("fork runner: every AND input and interrupted-upload/key-loss recovery execute real SBF", async () => {
  const root = mkdtempSync("/tmp/slm-fork-runner-public-test-");
  const messages: string[] = [];
  const progress = {
    log(message: string) {
      messages.push(message);
    },
    async run<T>(stage: string, action: () => Promise<T>) {
      messages.push(stage);
      return action();
    },
  };
  try {
    for (const scenario of [
      { a: false, b: false },
      { a: false, b: true },
      { a: true, b: false },
      { a: true, b: true },
      { a: true, b: false, interruptUpload: true },
    ]) {
      const state = mkdtempSync(join(root, "case-"));
      const { rpc, svm, program } = simulatedRpc();
      const result = await runForkPrimitive(
        rpc,
        state,
        progress,
        scenario,
        (path, transport) =>
          new TransactionCoordinator(path, transport, {
            outsideGit(path) {
              assert.ok(path.startsWith(root + "/"));
            },
            privateDirectory(path) {
              assert.ok(path.startsWith(root + "/"));
              mkdirSync(path, { recursive: true, mode: 0o700 });
              return path as PrivateDirectory;
            },
          }),
      );
      assert.equal(result.refundVerified, true);
      assert.equal(result.totalFees, scenario.interruptUpload ? 25000 : 40000);
      assert.equal(
        result.transactions.length,
        scenario.interruptUpload ? 5 : 8,
      );
      assert.equal(svm.getProgramAccounts(program).length, 0);
      if (scenario.interruptUpload) {
        assert.ok(
          "clientDecodingKeyDestroyed" in result &&
            result.clientDecodingKeyDestroyed,
        );
        assert.ok(!result.transactions.some((t) => t.operation === "evaluate"));
      } else assert.ok("parity" in result && result.parity);
    }
    assert.ok(messages.some((m) => m.includes("waiting for finalization")));
    assert.ok(
      messages.some((m) => m.includes("destroying client decoding key")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork circuit runner uses real compiled SBF and recovers complete/interrupted circuits", async () => {
  const root = mkdtempSync("/tmp/slm-circuit-runner-public-test-");
  const progress = {
    log() {},
    async run<T>(_stage: string, action: () => Promise<T>) {
      return action();
    },
  };
  try {
    for (const interruptAfterStep of [false, true]) {
      const state = mkdtempSync(join(root, "case-")),
        { rpc, svm, program } = simulatedRpc("circuit");
      const result = await runForkCircuit(
        rpc,
        state,
        progress,
        { left: -128, right: 127, interruptAfterStep },
        (path, transport) =>
          new TransactionCoordinator(path, transport, {
            outsideGit(p) {
              assert.ok(p.startsWith(root + "/"));
            },
            privateDirectory(p) {
              assert.ok(p.startsWith(root + "/"));
              mkdirSync(p, { recursive: true, mode: 0o700 });
              return p as PrivateDirectory;
            },
          }),
      );
      assert.equal(result.refundVerified, true);
      assert.equal(result.transactions.length, interruptAfterStep ? 21 : 23);
      assert.equal(result.totalFees, (interruptAfterStep ? 21 : 23) * 5000);
      assert.equal(svm.getProgramAccounts(program).length, 0);
      assert.equal(
        result.transactions.filter((t) => t.operation.startsWith("step-"))
          .length,
        interruptAfterStep ? 1 : 3,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stream fork runner executes Merkle windows with real SBF and key-independent interrupted recovery", async () => {
  const root = mkdtempSync("/tmp/slm-stream-runner-public-test-");
  const progress = {
    log() {},
    async run<T>(_stage: string, action: () => Promise<T>) {
      return action();
    },
  };
  try {
    for (const interruptAfterWindow of [false, true]) {
      const state = mkdtempSync(join(root, "case-")),
        { rpc, svm, program } = simulatedRpc("stream");
      const result = await runForkStream(
        rpc,
        state,
        progress,
        {
          operation: "compare",
          aBits: 0xbf800000,
          bBits: 0x3f800000,
          interruptAfterWindow,
        },
        (path, transport) =>
          new TransactionCoordinator(path, transport, {
            outsideGit(p) {
              assert.ok(p.startsWith(root + "/"));
            },
            privateDirectory(p) {
              assert.ok(p.startsWith(root + "/"));
              mkdirSync(p, { recursive: true, mode: 0o700 });
              return p as PrivateDirectory;
            },
          }),
      );
      assert.equal(result.refundVerified, true);
      assert.equal(svm.getProgramAccounts(program).length, 0);
      assert.equal(result.transactions.length, interruptAfterWindow ? 24 : 111);
      assert.equal(result.totalFees, (interruptAfterWindow ? 24 : 111) * 5000);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
