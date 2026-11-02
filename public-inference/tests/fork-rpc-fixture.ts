/** Test-only real SBF execution with controlled RPC confirmation/finality. */
import assert from "node:assert/strict";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getTransactionDecoder,
  getSignatureFromTransaction,
  lamports,
  type Address,
} from "@solana/kit";
import { verifiedBinary } from "../harness/build.mjs";
export function simulatedRpc(
  options: {
    fault?: "lost" | "failed" | "unknown" | "broadcast" | "fork";
    faultOperation?: string;
    receiptLagReads?: number;
  } = {},
) {
  const svm = new LiteSVM().withSigverify(false),
    program = getAddressDecoder().decode(new Uint8Array(32).fill(183));
  svm.addProgram(program, verifiedBinary());
  const receipts = new Map<
    string,
    {
      slot: number;
      operation: string;
      reads: number;
      finalized: boolean;
      meta: { err: unknown; fee: number; computeUnitsConsumed: number };
    }
  >();
  let slot = 100,
    operation = "",
    lastConfirmedSlot = 0,
    maxPending = 0,
    laterBeforeFinality = false,
    faultObserved = false;
  const events: {
    kind: string;
    operation?: string;
    commitment?: string;
    slot?: number;
    minContextSlot?: number;
  }[] = [];
  const receiptReads = new Map<string, number>();
  let receiptLagReturns = 0;
  const account = (key: Address) => {
    const a = svm.getAccount(key);
    return a.exists
      ? {
          owner: a.programAddress,
          executable: a.executable,
          data: [Buffer.from(a.data).toString("base64"), "base64"],
          lamports: Number(a.lamports),
        }
      : null;
  };
  const rpc = {
    localOnly: true as const,
    async beforeSigning() {},
    async status(signature: string) {
      if (receipts.get(signature)?.meta.err) return "failed" as const;
      return receipts.get(signature)?.finalized
        ? ("finalized" as const)
        : receipts.has(signature)
          ? ("pending" as const)
          : ("unknown" as const);
    },
    async sendExact(wire: string) {
      const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64")),
        result = svm.sendTransaction(tx);
      // LiteSVM has already executed this transaction; retain its failed receipt
      // as a landed execution failure instead of turning it into an unknown send.
      const failed = result instanceof FailedTransactionMetadata;
      const metadata = failed ? result.meta() : result;
      const executionError = failed ? result.err().toString() : null;
      if (failed)
        process.stderr.write(
          "[simulated RPC landed SBF failure] " +
            JSON.stringify({
              operation,
              error: executionError,
              computeUnits: Number(metadata.computeUnitsConsumed()),
              logs: metadata.logs(),
            }) +
            "\n",
        );
      const signature = getSignatureFromTransaction(tx),
        pending = [...receipts.values()].filter((r) => !r.finalized).length;
      if (pending) laterBeforeFinality = true;
      receipts.set(signature, {
        slot: ++slot,
        operation,
        reads: 0,
        finalized: false,
        meta: {
          err: executionError,
          fee: 5000,
          computeUnitsConsumed: Number(metadata.computeUnitsConsumed()),
        },
      });
      maxPending = Math.max(maxPending, pending + 1);
      events.push({ kind: "send", operation, slot });
      if (
        options.fault === "broadcast" &&
        options.faultOperation &&
        operation.startsWith(options.faultOperation)
      ) {
        faultObserved = true;
        throw Error("test_lost_submission_reply");
      }
      return signature;
    },
    async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
      const key = () => address(params[0] as string),
        config = (params[1] ?? {}) as {
          commitment?: string;
          minContextSlot?: number;
          filters?: { memcmp: { offset: number; bytes: string } }[];
        };
      let result: unknown;
      switch (method) {
        case "requestAirdrop":
          svm.airdrop(key(), lamports(BigInt(params[1] as number)));
          receipts.set("local-airdrop-fixture", {
            slot,
            operation: "airdrop",
            reads: 0,
            finalized: true,
            meta: { err: null, fee: 0, computeUnitsConsumed: 0 },
          });
          result = "local-airdrop-fixture";
          break;
        case "getBalance":
          events.push({ kind: "balance", commitment: config.commitment });
          result = {
            context: { slot },
            value: Number(svm.getBalance(key()) ?? 0n),
          };
          break;
        case "getFirstAvailableBlock":
          result = 0;
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
            context: { slot },
            value: {
              blockhash: svm.latestBlockhash(),
              lastValidBlockHeight: 100000,
            },
          };
          break;
        case "getSignatureStatuses":
          result = {
            context: { slot: slot + 100 },
            value: (params[0] as string[]).map((signature) => {
              const r = receipts.get(signature);
              if (!r) return null;
              r.reads++;
              const target =
                options.faultOperation &&
                r.operation.startsWith(options.faultOperation);
              if (target && options.fault === "unknown") {
                faultObserved = true;
                return null;
              }
              if (target && r.reads > 1 && options.fault === "fork") {
                faultObserved = true;
                events.push({ kind: "fork-changed", operation: r.operation });
                return {
                  slot: r.slot + 1,
                  confirmationStatus: "confirmed",
                  err: null,
                };
              }
              if (target && r.reads > 1 && options.fault === "lost") {
                faultObserved = true;
                events.push({ kind: "lost", operation: r.operation });
                return null;
              }
              if (target && r.reads > 1 && options.fault === "failed") {
                faultObserved = true;
                r.finalized = true;
                r.meta.err = { InstructionError: [1, "Custom"] };
                events.push({ kind: "failed", operation: r.operation });
                return {
                  slot: r.slot,
                  confirmationStatus: "finalized",
                  err: r.meta.err,
                };
              }
              if (r.reads > 1) {
                r.finalized = true;
                events.push({
                  kind: "finalized",
                  operation: r.operation,
                  slot: r.slot,
                });
              } else {
                lastConfirmedSlot = Math.max(lastConfirmedSlot, r.slot);
                events.push({
                  kind: "confirmed",
                  operation: r.operation,
                  slot: r.slot,
                });
              }
              return {
                slot: r.slot,
                confirmationStatus: r.finalized ? "finalized" : "confirmed",
                err: r.meta.err,
              };
            }),
          };
          break;
        case "getTransaction": {
          const signature = params[0] as string;
          const r = receipts.get(signature);
          const reads = receiptReads.get(signature) ?? 0;
          receiptReads.set(signature, reads + 1);
          if (
            config.commitment === "confirmed" &&
            reads < (options.receiptLagReads ?? 0)
          ) {
            receiptLagReturns++;
            events.push({
              kind: "receipt-lag",
              operation: r?.operation,
              commitment: config.commitment,
            });
            result = null;
            break;
          }
          result =
            r && (!(config.commitment === "finalized") || r.finalized)
              ? { slot: r.slot, meta: r.meta }
              : null;
          events.push({
            kind: "receipt",
            operation: r?.operation,
            commitment: config.commitment,
          });
          break;
        }
        case "getAccountInfo":
          if (config.commitment === "confirmed" && lastConfirmedSlot) {
            assert.ok(
              config.minContextSlot !== undefined &&
                config.minContextSlot >= lastConfirmedSlot,
              "confirmed reads must pin the latest observed slot",
            );
          }
          events.push({
            kind: "account",
            commitment: config.commitment,
            slot,
            minContextSlot: config.minContextSlot,
          });
          result = { context: { slot }, value: account(key()) };
          break;
        case "getMultipleAccounts":
          result = {
            context: { slot },
            value: (params[0] as Address[]).map(account),
          };
          break;
        case "getProgramAccounts":
          result = svm
            .getProgramAccounts(key())
            .filter((a) =>
              (config.filters ?? []).every(({ memcmp }) => {
                const expected = getAddressEncoder().encode(
                  address(memcmp.bytes),
                );
                return Buffer.from(a.data)
                  .subarray(memcmp.offset, memcmp.offset + expected.length)
                  .equals(Buffer.from(expected));
              }),
            )
            .map((a) => ({ pubkey: a.address, account: account(a.address) }));
          break;
        default:
          throw Error(`unexpected test RPC: ${method}`);
      }
      return result as T;
    },
  };
  return {
    rpc,
    svm,
    program,
    events,
    receipts,
    setOperation(stage: string) {
      operation = stage.split(":")[0];
    },
    metrics() {
      return {
        maxPending,
        laterBeforeFinality,
        faultObserved,
        receiptLagReturns,
      };
    },
  };
}
