import type { Address } from "@solana/kit";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const methods = new Set([
  "getGenesisHash",
  "getSlot",
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getMinimumBalanceForRentExemption",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getTransaction",
  "getFirstAvailableBlock",
  "simulateTransaction",
  "sendTransaction",
]);

/** Explicit mainnet transport. It cannot fund wallets or mutate validator state. */
export class MainnetInferenceRpc {
  readonly localOnly = false;
  private sequence = 0;
  constructor(
    private readonly endpoint: string,
    private readonly program: Address,
  ) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error("mainnet_https_rpc_required");
  }
  async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!methods.has(method)) throw Error("mainnet_rpc_method_not_allowed");
    const id = ++this.sequence;
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
    } catch {
      throw Error("mainnet_rpc_transport_failed");
    }
    if (!response.ok) throw Error(`mainnet_rpc_http_${response.status}`);
    const body = await response.json();
    if (
      body.id !== id ||
      body.jsonrpc !== "2.0" ||
      body.error ||
      !("result" in body)
    )
      throw Error("mainnet_rpc_response_failed");
    return body.result as T;
  }
  async beforeSigning() {
    if ((await this.rpc<string>("getGenesisHash")) !== MAINNET_GENESIS)
      throw Error("mainnet_genesis_mismatch");
    const account = await this.rpc<{ value: { executable: boolean } | null }>(
      "getAccountInfo",
      [this.program, { encoding: "base64", commitment: "finalized" }],
    );
    if (account.value?.executable !== true)
      throw Error("mainnet_program_not_executable");
  }
  async status(
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
  async sendExact(wireBase64: string) {
    await this.beforeSigning();
    const simulation = await this.rpc<{ value: { err: unknown } }>(
      "simulateTransaction",
      [
        wireBase64,
        { encoding: "base64", sigVerify: true, commitment: "confirmed" },
      ],
    );
    if (!simulation.value || simulation.value.err !== null)
      throw Error("mainnet_simulation_failed");
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
