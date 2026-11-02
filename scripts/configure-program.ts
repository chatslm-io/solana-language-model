import { address } from "@solana/kit";

// Print a setting for the caller's chosen env file; never edit repository config.
const [cluster, value] = process.argv.slice(2);
const keys = {
  localnet: "SLM_LOCALNET_STORAGE_PROGRAM_ID",
  devnet: "SLM_DEVNET_STORAGE_PROGRAM_ID",
  "mainnet-beta": "SLM_MAINNET_STORAGE_PROGRAM_ID",
};
if (!Object.hasOwn(keys, cluster) || !value) {
  console.error(
    "Usage: npm run configure-program -- <localnet|devnet|mainnet-beta> <reviewed-public-program-address>",
  );
  process.exitCode = 1;
} else {
  console.log(`${keys[cluster as keyof typeof keys]}=${address(value)}`);
}
