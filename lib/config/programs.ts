import { address } from "@solana/kit";

const keys = {
  localnet: "SLM_LOCALNET_STORAGE_PROGRAM_ID",
  devnet: "SLM_DEVNET_STORAGE_PROGRAM_ID",
  "mainnet-beta": "SLM_MAINNET_STORAGE_PROGRAM_ID",
} as const;

export function storageProgram(
  cluster: string,
  env: Record<string, string | undefined> = process.env,
) {
  if (!Object.hasOwn(keys, cluster)) throw new Error("Unsupported cluster");
  const value = env[keys[cluster as keyof typeof keys]]?.trim();
  return value ? address(value) : null;
}
