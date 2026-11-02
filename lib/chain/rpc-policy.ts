export type RpcPolicy = {
  mode: "free" | "paid";
  rps: number;
  sendRps: number;
  scanRps: number;
};
export const DEFAULT_RPC_POLICY: RpcPolicy = {
  mode: "free",
  rps: 50,
  sendRps: 5,
  scanRps: 25,
};
export const PUBLIC_RPC_HOSTS = new Set([
  "api.devnet.solana.com",
  "api.testnet.solana.com",
  "api.mainnet-beta.solana.com",
  "api.mainnet.solana.com",
]);
export function rpcPolicy(input: unknown): RpcPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid RPC settings");
  const p = input as Record<string, unknown>;
  if (
    Object.keys(p).some(
      (k) => !["mode", "rps", "sendRps", "scanRps"].includes(k),
    ) ||
    (p.mode !== "free" && p.mode !== "paid")
  )
    throw new Error("Invalid RPC mode");
  for (const key of ["rps", "sendRps", "scanRps"] as const)
    if (
      typeof p[key] !== "number" ||
      !Number.isSafeInteger(p[key]) ||
      p[key] < 1 ||
      p[key] > 1000
    )
      throw new Error(
        "RPC rate limits must be whole numbers between 1 and 1000",
      );
  if (
    (p.sendRps as number) > (p.rps as number) ||
    (p.scanRps as number) > (p.rps as number)
  )
    throw new Error(
      "Send and account-scan limits cannot exceed total RPC requests per second",
    );
  return {
    mode: p.mode as RpcPolicy["mode"],
    rps: p.rps as number,
    sendRps: p.sendRps as number,
    scanRps: p.scanRps as number,
  };
}
