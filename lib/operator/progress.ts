import { CHUNK_BYTES } from "@/lib/chain/protocol";
import { resolvedEntry } from "@/lib/chain/batch";
import type { Manifest } from "@/lib/model/manifest";
import type { Job, OperationProgress } from "./types";

export function uploadTotals(manifest: Manifest) {
  return {
    shards: manifest.shards.length,
    // Registry creation + sealing; shard creation + writes + finalization.
    transactions:
      2 +
      manifest.shards.reduce(
        (n, shard) => n + 2 + Math.ceil(shard.length / CHUNK_BYTES),
        0,
      ),
  };
}

export function operationProgress(job: Job): OperationProgress | undefined {
  const uploading = job.mode !== "withdraw";
  const withdrawing = job.mode !== "upload";
  if (uploading && !job.uploadTotals) return;
  if (!uploading && job.phase === "preparing" && !job.accounts.length) return;
  const total =
    (uploading ? job.uploadTotals!.transactions : 0) +
    (withdrawing ? job.accounts.length : 0);
  const operations = [
    ...(uploading ? ["create", "write", "finalize", "seal"] : []),
    ...(withdrawing ? ["close"] : []),
  ];
  const completed = job.journal.filter(
    (entry) =>
      operations.includes(entry.operation || "") &&
      ["finalized", "verified"].includes(entry.status) &&
      resolvedEntry(entry),
  );
  // Write labels contain their exact byte range. A successful replay of the
  // same operation is one completed step, regardless of signing attempts.
  const transactions = new Set(
    completed.map((entry) =>
      JSON.stringify([entry.operation, entry.account, entry.label]),
    ),
  ).size;
  const shards = new Set(
    completed
      .filter((entry) => entry.operation === "finalize")
      .map((entry) => entry.account),
  ).size;
  const accounts = new Set(
    completed
      .filter(
        (entry) =>
          entry.operation === "close" &&
          job.accounts.includes(entry.account || ""),
      )
      .map((entry) => entry.account),
  ).size;
  const count = (done: number, total: number) => ({
    completed: Math.min(done, total),
    total,
    remaining: Math.max(0, total - done),
  });
  return {
    // 100% requires the complete workflow, including readback/refund checks.
    percent: Math.min(
      job.phase === "complete" &&
        (!uploading || (job.bytes > 0 && job.verifiedBytes === job.bytes))
        ? 100
        : 99,
      total
        ? Math.floor((100 * transactions) / total)
        : job.phase === "complete"
          ? 100
          : 0,
    ),
    ...(uploading ? { shards: count(shards, job.uploadTotals!.shards) } : {}),
    ...(withdrawing ? { accounts: count(accounts, job.accounts.length) } : {}),
    transactions: count(transactions, total),
  };
}
