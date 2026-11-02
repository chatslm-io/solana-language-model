import { configuration } from "./security";
import {
  DEFAULT_RPC_POLICY,
  PUBLIC_RPC_HOSTS,
  rpcPolicy,
  type RpcPolicy,
} from "@/lib/chain/rpc-policy";
import { createRpcLimiter } from "./rpc-limiter";
const ALLOWED = new Set([
  "getGenesisHash",
  "getVersion",
  "getBalance",
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getMinimumBalanceForRentExemption",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSlot",
  "getFeeForMessage",
  "simulateTransaction",
  "sendTransaction",
  "getSignatureStatuses",
  "getTransaction",
]);
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Shared by requests in this server process. Never retry a transaction broadcast:
// its outcome must be reconciled from the browser's durable signature journal.
export function createRpcForwarder({
  request = fetch,
  wait = pause,
  now = Date.now,
  getConfiguration = configuration,
  limiter = createRpcLimiter({ now, wait }),
}: {
  request?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  getConfiguration?: () => {
    rpc: string;
    cluster: string;
    rpcPolicy?: RpcPolicy;
  };
  limiter?: ReturnType<typeof createRpcLimiter>;
} = {}) {
  return async function forwardRpc(payload: Record<string, unknown>) {
    if (
      payload.jsonrpc !== "2.0" ||
      typeof payload.method !== "string" ||
      !ALLOWED.has(payload.method) ||
      !Array.isArray(payload.params)
    )
      throw new Error("Unsupported RPC method");
    const config = getConfiguration();
    const url = config.rpc;
    const trace =
      payload.method === "sendTransaction" ||
      payload.method === "simulateTransaction";
    const log = (phase: string, details: Record<string, unknown> = {}) => {
      if (trace)
        console.info(
          "[slm-rpc]",
          JSON.stringify({
            method: payload.method,
            cluster: config.cluster,
            phase,
            ...details,
          }),
        );
    };
    const publicEndpoint = PUBLIC_RPC_HOSTS.has(new URL(url).hostname);
    const policy = config.rpcPolicy
      ? rpcPolicy(config.rpcPolicy)
      : publicEndpoint
        ? DEFAULT_RPC_POLICY
        : undefined;
    if (publicEndpoint && policy?.mode === "paid")
      throw new Error(
        "Paid mode requires a private provider RPC URL in the external operator configuration",
      );
    const deadline = now() + 25000;
    const failure = (status: number) =>
      Response.json(
        { error: `RPC request failed (${status})` },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    for (let attempt = 0; ; attempt++) {
      if (!(await limiter.acquire(policy, payload.method, deadline)))
        return failure(429);
      if (now() >= deadline) return failure(504);
      let upstream: Response;
      try {
        log("request", { attempt: attempt + 1 });
        upstream = await request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(Math.max(1, deadline - now())),
        });
      } catch {
        log("network-failure");
        // Do not leak credential-bearing upstream URLs or retry uncertain sends.
        return failure(502);
      }
      log("response", { httpStatus: upstream.status });
      if (upstream.ok) {
        if (trace) {
          try {
            const result = await upstream.clone().json();
            // No wire bytes, instruction data, headers, URLs or raw errors.
            log("result", {
              rpcErrorCode:
                typeof result.error?.code === "number"
                  ? result.error.code
                  : null,
              ...(payload.method === "simulateTransaction"
                ? { simulationFailed: !!result.result?.value?.err }
                : {
                    signature:
                      typeof result.result === "string" &&
                      /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(result.result)
                        ? result.result
                        : null,
                  }),
            });
          } catch {
            log("invalid-json-response");
          }
        }
        return new Response(upstream.body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }
      await upstream.body?.cancel();
      if (upstream.status !== 429) return failure(upstream.status);
      const retryAfter = upstream.headers.get("Retry-After");
      const requested = retryAfter
        ? /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - now()
        : NaN;
      const delay = Math.max(
        2000 * (attempt + 1),
        Number.isFinite(requested) ? requested : 0,
      );
      limiter.cooldown(now() + delay);
      if (payload.method === "sendTransaction" || attempt >= 2)
        return failure(429);
      // A long provider cooldown is surfaced, never shortened to retry sooner.
      if (now() + delay >= deadline) return failure(429);
      await wait(delay);
    }
  };
}
export const forwardRpc = createRpcForwarder();
