import { join } from "node:path";
/** Bounded disk-history policy, independent of execution/CU/heap/transaction limits.
 * Agave3.1.10 test-validator otherwise defaults to only10000 DATA shreds. */
export const LOCAL_LEDGER_RETENTION_SHREDS = 1_000_000;
export function localValidatorArgs(input: {
  state: string;
  port: number;
  cloneAddress: string;
  cloneFile: string;
  program: string;
  binary: string;
  resume?: boolean;
}): string[] {
  if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65533)
    throw Error("invalid_local_validator_port");
  return [
    "--ledger",
    join(input.state, "ledger"),
    "--limit-ledger-size",
    String(LOCAL_LEDGER_RETENTION_SHREDS),
    "--rpc-port",
    String(input.port),
    "--bind-address",
    "127.0.0.1",
    "--faucet-port",
    String(input.port + 1),
    ...(input.resume
      ? []
      : [
          "--account",
          input.cloneAddress,
          input.cloneFile,
          "--bpf-program",
          input.program,
          input.binary,
        ]),
    "--quiet",
  ];
}
