export type Run = { deposit: string; transactions: number };
export function readRun(serialized: string | null): Run {
  if (!serialized) return { deposit: "0", transactions: 0 };
  const r = JSON.parse(serialized) as Run;
  if (
    !r ||
    typeof r.deposit !== "string" ||
    !/^\d+$/.test(r.deposit) ||
    !Number.isSafeInteger(r.transactions) ||
    r.transactions < 0
  )
    throw new Error(
      "Invalid saved run counters. Review pending signatures before starting a new run.",
    );
  return r;
}
export function reserveRun(
  run: Run,
  deposit: bigint,
  maximumDeposit: bigint,
  maximumTransactions: number,
  transactions = 1,
): Run {
  if (!Number.isSafeInteger(transactions) || transactions < 1)
    throw new Error("Invalid batch transaction count");
  if (
    deposit < 0n ||
    (deposit > 0n && BigInt(run.deposit) + deposit > maximumDeposit)
  )
    throw new Error("New-deposit cap reached for this run");
  if (run.transactions + transactions > maximumTransactions)
    throw new Error("Transaction cap reached for this run");
  return {
    deposit: (BigInt(run.deposit) + deposit).toString(),
    transactions: run.transactions + transactions,
  };
}
