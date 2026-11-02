/** Preserve process ownership/genesis checks and read-only cloning policy. */
export * from "../../private-inference/harness/transport";
import { OwnedLocalRpc as FinalizedLocalRpc } from "../../private-inference/harness/transport";

/** Public execution may consume confirmed predecessor state. Its preflight must
 * use that same commitment; finalized preflight would see an older session. */
export class OwnedLocalRpc extends FinalizedLocalRpc {
  /** Journal terminal states require finality even when a speculative fork
   * reports an execution error. Confirmation polling uses the raw RPC status. */
  override async status(
    signature: string,
  ): Promise<"unknown" | "pending" | "finalized" | "failed"> {
    const result = await this.rpc<{
      value: ({ err: unknown; confirmationStatus: string } | null)[];
    }>("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const status = result.value[0];
    if (!status) return "unknown";
    if (status.confirmationStatus !== "finalized") return "pending";
    return status.err ? "failed" : "finalized";
  }

  override async sendExact(wireBase64: string) {
    await this.beforeSigning();
    return this.rpc<string>("sendTransaction", [
      wireBase64,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0,
      },
    ]);
  }
}
