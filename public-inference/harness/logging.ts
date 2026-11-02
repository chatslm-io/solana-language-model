/** External public-run evidence. Never pass secrets, raw prompts or provider errors
 * as progress messages. Full result files preserve the existing runner output. */
import { constants, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import {
  privateDirectory,
  type PrivateDirectory,
} from "../../lib/operator/external";
import type { TestProgress } from "./progress";
export type LogPathPolicy = {
  privateDirectory: (path: string) => PrivateDirectory;
};
const protectedPaths: LogPathPolicy = { privateDirectory };
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ) + "\n";
/** Exclusive creation prevents overwriting earlier run evidence. */
export function writeProtectedResult(
  state: string,
  name: "result.json" | "comparison.json",
  value: unknown,
  paths: LogPathPolicy = protectedPaths,
): string {
  if (name !== "result.json" && name !== "comparison.json")
    throw Error("public_log_filename");
  const directory = paths.privateDirectory(state),
    path = join(directory, name),
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  try {
    writeSync(fd, json(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return path;
}
export function compactRunResult(
  result: Record<string, unknown>,
): Record<string, unknown> & { transactionCount: number } {
  const keys = [
    "scope",
    "sourceSha256",
    "sourceSha",
    "validatorRestartVerified",
    "referenceParity",
    "genesisModelAccounts",
    "totalTransactions",
    "outputs",
    "inferenceExecuted",
    "confirmationMode",
    "pendingWindowLimit",
    "finalizedBeforeReturn",
    "totalFees",
    "refundedLamports",
    "refundVerified",
    "elapsedMs",
    "modelUploadTested",
    "benchmark",
  ];
  return {
    ...Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(result, key))
        .map((key) => [key, result[key]]),
    ),
    transactionCount: Array.isArray(result.transactions)
      ? result.transactions.length
      : Number.isSafeInteger(result.totalTransactions) &&
          Number(result.totalTransactions) >= 0
        ? Number(result.totalTransactions)
        : 0,
  };
}
export function createRunLogs(
  state: string,
  consoleProgress: TestProgress,
  paths: LogPathPolicy = protectedPaths,
) {
  const directory = paths.privateDirectory(state),
    progressPath = join(directory, "progress.log"),
    fd = openSync(
      progressPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    ),
    started = performance.now();
  let closed = false,
    lastConsole = -Infinity;
  const log = (message: string) => {
    if (closed) throw Error("public_log_closed");
    const elapsed = performance.now() - started;
    writeSync(
      fd,
      `[${new Date().toISOString()} +${(elapsed / 1000).toFixed(1)}s] ${message}\n`,
    );
    const transactionDetail = message.includes(": reserve, submit locally,");
    if (
      !transactionDetail ||
      message.endsWith(" — failed") ||
      elapsed - lastConsole >= 5000
    ) {
      consoleProgress.log(message);
      lastConsole = elapsed;
    }
  };
  const progress: TestProgress = {
    log,
    async run<T>(stage: string, action: () => Promise<T>): Promise<T> {
      log(stage);
      const since = performance.now(),
        timer = setInterval(
          () =>
            log(
              `${stage} — still waiting (${Math.floor((performance.now() - since) / 1000)}s)`,
            ),
          5000,
        );
      timer.unref();
      try {
        const value = await action();
        log(`${stage} — done`);
        return value;
      } catch (error) {
        log(`${stage} — failed`);
        throw error;
      } finally {
        clearInterval(timer);
      }
    },
  };
  return {
    progress,
    progressPath,
    writeResult(result: Record<string, unknown>) {
      const resultPath = writeProtectedResult(
        directory,
        "result.json",
        result,
        paths,
      );
      return {
        summary: {
          ...compactRunResult(result),
          files: { progress: progressPath, result: resultPath },
        },
        resultPath,
        progressPath,
      };
    },
    close() {
      if (!closed) {
        closed = true;
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    },
  };
}
