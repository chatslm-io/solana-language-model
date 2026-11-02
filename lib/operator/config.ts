import { address } from "@solana/kit";
import { storageProgram } from "../config/programs";
import { parseSol } from "@/lib/chain/protocol";
import { readOperatorEnv } from "./external";
import { rpcPolicy, PUBLIC_RPC_HOSTS } from "@/lib/chain/rpc-policy";
export type Network = "devnet" | "mainnet-beta";
export function network(value: unknown): Network {
  if (value !== "devnet" && value !== "mainnet-beta")
    throw new Error("Choose Devnet or Mainnet");
  return value;
}
export function operatorConfig(cluster: Network) {
  const env = readOperatorEnv();
  const get = (key: string, fallback: string) =>
    env[key] || process.env[key] || fallback;
  const legacy =
    process.env.SOLANA_CLUSTER === cluster
      ? process.env.SOLANA_RPC_URL
      : undefined;
  const rpc = new URL(
    get(
      cluster === "devnet" ? "SLM_DEVNET_RPC_URL" : "SLM_MAINNET_RPC_URL",
      legacy || "",
    ),
  );
  if (
    rpc.protocol !== "https:" &&
    !(
      rpc.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(rpc.hostname)
    )
  )
    throw new Error("RPC must use HTTPS or local HTTP");
  const program = storageProgram(cluster, { ...process.env, ...env });
  if (program) address(program);
  const maxTransactions = Number(get("SLM_MAX_TRANSACTIONS", "100"));
  if (
    !Number.isSafeInteger(maxTransactions) ||
    maxTransactions < 1 ||
    maxTransactions > 10000
  )
    throw new Error("Invalid transaction cap");
  return {
    cluster,
    program: program as string | null,
    rpc: rpc.toString(),
    rpcDisplay: `${rpc.protocol}//${rpc.host}/…`,
    rpcPolicy: rpcPolicy({
      mode: get("SLM_RPC_MODE", "free"),
      rps: Number(get("SLM_RPC_RPS", "50")),
      sendRps: Number(get("SLM_RPC_SEND_RPS", "5")),
      scanRps: Number(get("SLM_RPC_SCAN_RPS", "25")),
    }),
    maxDeposit: parseSol(get("SLM_MAX_DEPOSIT_SOL", "0.01")).toString(),
    maxFees: parseSol(get("SLM_MAX_FEE_SOL", "0.001")).toString(),
    maxTransactions,
  };
}
export type OperatorConfig = ReturnType<typeof operatorConfig>;
export function rpcInfo(config: OperatorConfig) {
  return {
    ...config.rpcPolicy,
    endpoint: config.rpcDisplay,
    paidAvailable: !PUBLIC_RPC_HOSTS.has(new URL(config.rpc).hostname),
  };
}
export function assertRpcEndpoint(config: OperatorConfig) {
  if (config.rpcPolicy.mode === "paid" && !rpcInfo(config).paidAvailable)
    throw new Error(
      `Set ${config.cluster === "devnet" ? "SLM_DEVNET_RPC_URL" : "SLM_MAINNET_RPC_URL"} to your paid provider in the external operator.env file first`,
    );
}
