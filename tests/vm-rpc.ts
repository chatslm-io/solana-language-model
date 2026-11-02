import { approvedSigners } from "../lib/config/environment.mjs";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  address,
  getAddressEncoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  type Address,
} from "@solana/kit";
import { existsSync, readFileSync } from "node:fs";
import { base64, fromBase64 } from "../lib/chain/protocol";
export const TEST_PROGRAM = address(
  "3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh",
);
// RPC-shaped browser integration harness. Execution and signature verification use
// the compiled SBF program in LiteSVM; finality/fee RPC responses are test fixtures.
export function vmRpc(
  options: { stableBlockhash?: boolean; genesis?: string } = {},
) {
  const svm = new LiteSVM();
  const binaryPath =
    process.env.SLM_PROGRAM_BINARY ||
    (existsSync("program/target/deploy/slm_storage.so")
      ? "program/target/deploy/slm_storage.so"
      : "program/target/sbpf-solana-solana/release/slm_storage.so");
  svm.addProgramFromFile(TEST_PROGRAM, binaryPath);
  function authorizeTestSigners(signers: readonly Address[]) {
    svm.addProgram(
      TEST_PROGRAM,
      withTestAllowlist(readFileSync(binaryPath), signers),
    );
  }
  const receipts = new Map<string, unknown>();
  const acc = (key: Address) => {
    const a = svm.getAccount(key);
    return a.exists
      ? {
          data: [base64(Uint8Array.from(a.data)), "base64"],
          owner: a.programAddress,
          lamports: Number(a.lamports),
          executable: a.executable,
          rentEpoch: 0,
          space: a.data.length,
        }
      : null;
  };
  // The JSON-RPC boundary is deliberately untyped, as an actual RPC wire is.
  async function request(method: string, params: unknown[]): Promise<unknown> {
    const key = () => address(params[0] as string);
    const context = { slot: 100 };
    switch (method) {
      case "getGenesisHash":
        return (
          options.genesis || "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
        );
      case "getBalance":
        return { context, value: Number(svm.getBalance(key()) || 0n) };
      case "getAccountInfo":
        return { context, value: acc(key()) };
      case "getMultipleAccounts":
        return {
          context,
          value: (params[0] as string[]).map((a) => acc(address(a))),
        };
      case "getProgramAccounts":
        return svm
          .getProgramAccounts(key())
          .filter((a) => a.data.length >= 192)
          .map((a) => ({ pubkey: a.address, account: acc(a.address) }));
      case "getMinimumBalanceForRentExemption":
        return Number(
          svm.minimumBalanceForRentExemption(BigInt(params[0] as number)),
        );
      case "getLatestBlockhash":
        if (!options.stableBlockhash) svm.expireBlockhash();
        return {
          context,
          value: {
            blockhash: svm.latestBlockhash(),
            lastValidBlockHeight: 100000,
          },
        };
      case "getBlockHeight":
        return 1;
      case "getSlot":
        return Number(svm.getClock().slot);
      case "getFeeForMessage":
        return { context, value: 5000 };
      case "simulateTransaction": {
        svm.withSigverify(false);
        try {
          const result = svm.simulateTransaction(
            getTransactionDecoder().decode(fromBase64(params[0] as string)),
          );
          return {
            context,
            value: {
              err:
                result instanceof FailedTransactionMetadata
                  ? { InstructionError: [0, "SimulationFailed"] }
                  : null,
              logs:
                result instanceof FailedTransactionMetadata
                  ? result.meta().logs()
                  : [],
              unitsConsumed: 1000,
            },
          };
        } finally {
          svm.withSigverify(true);
        }
      }
      case "sendTransaction": {
        const tx = getTransactionDecoder().decode(
          fromBase64(params[0] as string),
        );
        const sig = getSignatureFromTransaction(tx);
        const m = getCompiledTransactionMessageDecoder().decode(
          tx.messageBytes,
        );
        if (m.version === "legacy" || m.version === 0) {
          const keys = m.staticAccounts;
          const pre = keys.map((a) => Number(svm.getBalance(a) || 0n));
          const result = svm.sendTransaction(tx);
          if (result instanceof FailedTransactionMetadata)
            throw new Error(result.meta().logs().join("\n"));
          receipts.set(sig, {
            slot: 100,
            blockTime: 0,
            version: 0,
            transaction: {
              signatures: [sig],
              message: {
                accountKeys: keys,
                header: {
                  numRequiredSignatures: 1,
                  numReadonlySignedAccounts: 0,
                  numReadonlyUnsignedAccounts: 1,
                },
                recentBlockhash: svm.latestBlockhash(),
                instructions: [],
              },
            },
            meta: {
              err: null,
              fee: 5000,
              preBalances: pre,
              postBalances: keys.map((a) => Number(svm.getBalance(a) || 0n)),
              innerInstructions: [],
              logMessages: result.logs(),
              preTokenBalances: [],
              postTokenBalances: [],
              rewards: [],
              loadedAddresses: { writable: [], readonly: [] },
            },
          });
          return sig;
        }
        throw new Error("Unsupported test transaction version");
      }
      case "getSignatureStatuses":
        return {
          context,
          value: (params[0] as string[]).map((s) =>
            receipts.has(s)
              ? {
                  slot: 100,
                  confirmations: null,
                  err: null,
                  status: { Ok: null },
                  confirmationStatus: "finalized",
                }
              : null,
          ),
        };
      case "getTransaction":
        return receipts.get(params[0] as string) || null;
      default:
        throw new Error(`Unhandled test RPC method ${method}`);
    }
  }
  return { svm, request, authorizeTestSigners };
}

export function withTestAllowlist(
  bytes: Uint8Array,
  signers: readonly Address[],
) {
  const binary = Buffer.from(bytes);
  const encoder = getAddressEncoder();
  const production = approvedSigners();
  // Client signature tests use ephemeral keys and a VM-only patched allowlist.
  // Dedicated program allowlist tests execute the unmodified release binary.
  signers.forEach((signer, i) => {
    const before = Buffer.from(encoder.encode(address(production[i])));
    const after = Buffer.from(encoder.encode(signer));
    let matches = 0;
    for (
      let offset = binary.indexOf(before);
      offset >= 0;
      offset = binary.indexOf(before, offset + 32)
    ) {
      after.copy(binary, offset);
      matches++;
    }
    if (matches === 0) throw Error("test_allowlist_constant_not_found");
  });
  return binary;
}
