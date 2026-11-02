import { spawnSync } from "node:child_process";

export function checkValidatorVersion(result: {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error | { code?: string };
}): string {
  if (result.error && "code" in result.error && result.error.code === "ENOENT")
    throw Error(
      "solana-test-validator was not found on this terminal's PATH. Open a new terminal after updating PATH, then run: command -v solana-test-validator && solana-test-validator --version",
    );
  const banner =
    /(?:^|\n)solana-test-validator ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/.exec(
      result.stdout + "\n" + result.stderr,
    );
  if (result.error || result.status !== 0)
    throw Error(
      `solana-test-validator --version could not run successfully (status ${result.status ?? "unavailable"}). Run it directly in this terminal to inspect the failure.`,
    );
  if (!banner)
    throw Error(
      "solana-test-validator returned an unrecognized version banner. Run: command -v solana-test-validator && solana-test-validator --version",
    );
  if (banner[1] !== "3.1.10")
    throw Error(
      `Found solana-test-validator ${banner[1]}; this harness requires exactly 3.1.10. Check which installation this terminal selects with: command -v solana-test-validator`,
    );
  return `solana-test-validator ${banner[1]}`;
}

export function validatorVersion(): string {
  const result = spawnSync("solana-test-validator", ["--version"], {
    encoding: "utf8",
    timeout: 10000,
    env: { PATH: process.env.PATH, NO_DNA: "1", NODE_ENV: "test" },
  });
  return checkValidatorVersion(result);
}
