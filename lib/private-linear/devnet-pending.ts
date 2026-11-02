import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import type { RpcCall } from "../../runtime/publisher";

export type PendingPrivateLinearTransaction = {
  signature: string;
  lastValidBlockHeight: string;
};
export type PendingDisposition = "pending" | "finalized" | "failed" | "expired";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
type SignatureStatus = {
  confirmationStatus: "processed" | "confirmed" | "finalized";
  err: unknown;
};
function unavailable(): never {
  throw Error("private_linear_reconciliation_unavailable");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    unavailable();
  return value as Record<string, unknown>;
}
function validError(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  );
}
function statusResult(value: unknown): SignatureStatus | null {
  const result = record(value);
  if (!Array.isArray(result.value) || result.value.length !== 1) unavailable();
  if (result.value[0] === null) return null;
  const status = record(result.value[0]);
  if (
    !Object.hasOwn(status, "err") ||
    !validError(status.err) ||
    !["processed", "confirmed", "finalized"].includes(
      String(status.confirmationStatus),
    )
  )
    unavailable();
  return {
    confirmationStatus:
      status.confirmationStatus as SignatureStatus["confirmationStatus"],
    err: status.err,
  };
}
function finalizedStatus(
  status: SignatureStatus | null,
): "finalized" | "failed" | undefined {
  if (status?.confirmationStatus === "finalized")
    return status.err === null ? "finalized" : "failed";
  return undefined;
}
/**
 * Read-only reconciliation. Never re-signs or broadcasts. "finalized" is only
 * a scheduling result: authenticate the actual transaction and output with
 * verifyFinalizedPrivateLinear before accepting/decrypting a result.
 * Provider errors and malformed replies preserve uncertainty by throwing.
 */
export async function reconcilePending(
  rpc: RpcCall,
  pending: PendingPrivateLinearTransaction,
  genesis = DEVNET_GENESIS,
): Promise<PendingDisposition> {
  try {
    const signatureBytes = getBase58Encoder().encode(pending.signature);
    if (
      signatureBytes.length !== 64 ||
      getBase58Decoder().decode(signatureBytes) !== pending.signature ||
      !/^(0|[1-9][0-9]{0,19})$/.test(pending.lastValidBlockHeight) ||
      BigInt(pending.lastValidBlockHeight) > 0xffffffffffffffffn
    )
      throw Error("invalid");
  } catch {
    throw Error("private_linear_invalid_pending_transaction");
  }
  if ((await rpc<string>("getGenesisHash")) !== genesis)
    throw Error("private_linear_wrong_network");
  const statuses = async () =>
    statusResult(
      await rpc<unknown>("getSignatureStatuses", [
        [pending.signature],
        { searchTransactionHistory: true },
      ]),
    );
  const status = await statuses();
  const definitive = finalizedStatus(status);
  if (definitive) return definitive;
  const height = await rpc<unknown>("getBlockHeight", [
    { commitment: "finalized" },
  ]);
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height < 0)
    unavailable();
  if (BigInt(height) <= BigInt(pending.lastValidBlockHeight)) return "pending";
  const value = await rpc<unknown>("getTransaction", [
    pending.signature,
    {
      encoding: "base64",
      commitment: "finalized",
      maxSupportedTransactionVersion: 1,
    },
  ]);
  if (value !== null) {
    const tx = record(value),
      meta = record(tx.meta);
    if (
      !Number.isSafeInteger(tx.slot) ||
      (tx.slot as number) < 0 ||
      !Object.hasOwn(meta, "err") ||
      !validError(meta.err) ||
      (tx.version !== "legacy" && tx.version !== 0 && tx.version !== 1)
    )
      unavailable();
    return meta.err === null ? "finalized" : "failed";
  }
  // An observed nonfinalized transaction is not safe to replace, even after its
  // blockhash lifetime ends. A later call can observe finalization or removal.
  if (status !== null) return "pending";
  const second = await statuses();
  return finalizedStatus(second) ?? (second === null ? "expired" : "pending");
}
