/** Ciphertext-only transaction journal. Save/reserve before broadcast; uncertainty never permits replacement. */
import { open, rename } from "node:fs/promises";
import {
  outsideGit,
  privateDirectory,
  readProtectedFile,
  type PrivateDirectory,
} from "../../lib/operator/external";
import { acquireRuntimeLock } from "../../runtime/lock";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export type PendingTransaction = {
  operation: string;
  signature: string;
  wireBase64: string;
  fee: string;
  rent: string;
  state: "reserved" | "broadcast" | "finalized" | "failed";
};
export type Journal = {
  version: 1;
  feeAllowance: string;
  rentAllowance: string;
  cleanupReserve: string;
  available: string;
  transactions: PendingTransaction[];
};
export interface LocalSubmissionTransport {
  /** Implementations must be bound to a process-owned local node; never upstream clone RPC. */
  readonly localOnly: true;
  sendExact(wireBase64: string): Promise<string>;
  status(
    signature: string,
  ): Promise<"unknown" | "pending" | "finalized" | "failed">;
}
const amount = (s: string) => {
  if (
    typeof s !== "string" ||
    s.length > 20 ||
    !/^(0|[1-9][0-9]*)$/.test(s) ||
    BigInt(s) > 0xffffffffffffffffn
  )
    throw Error("invalid_budget");
  return BigInt(s);
};
export type JournalPathIO = {
  outsideGit: typeof outsideGit;
  privateDirectory: (path: string) => PrivateDirectory;
};
const protectedPaths: JournalPathIO = { outsideGit, privateDirectory };
export class SubmissionJournal {
  constructor(
    private readonly path: string,
    private readonly transport: Pick<
      LocalSubmissionTransport,
      "sendExact" | "status"
    >,
    private readonly paths: JournalPathIO = protectedPaths,
  ) {}
  private async locked<T>(run: () => Promise<T>) {
    this.paths.outsideGit(this.path);
    const release = acquireRuntimeLock(
      this.paths.privateDirectory(dirname(this.path)),
    );
    try {
      return await run();
    } finally {
      release();
    }
  }
  private async load(): Promise<Journal> {
    const v = JSON.parse(
      readProtectedFile(this.path, 16 * 1024 * 1024).toString("utf8"),
    ) as Journal;
    if (
      !v ||
      Object.keys(v).sort().join(",") !==
        "available,cleanupReserve,feeAllowance,rentAllowance,transactions,version" ||
      v.version !== 1 ||
      !Array.isArray(v.transactions) ||
      v.transactions.length > 4096
    )
      throw Error("invalid_journal");
    for (const n of [
      v.available,
      v.cleanupReserve,
      v.feeAllowance,
      v.rentAllowance,
    ])
      amount(n);
    const operations = new Set<string>();
    for (const tx of v.transactions) {
      if (
        !tx ||
        Object.keys(tx).sort().join(",") !==
          "fee,operation,rent,signature,state,wireBase64" ||
        typeof tx.operation !== "string" ||
        !tx.operation ||
        tx.operation.length > 128 ||
        operations.has(tx.operation) ||
        typeof tx.signature !== "string" ||
        !tx.signature ||
        tx.signature.length > 128 ||
        !["reserved", "broadcast", "finalized", "failed"].includes(tx.state) ||
        typeof tx.wireBase64 !== "string" ||
        !tx.wireBase64 ||
        tx.wireBase64.length > 1644 ||
        Buffer.from(tx.wireBase64, "base64").toString("base64") !==
          tx.wireBase64
      )
        throw Error("invalid_journal");
      amount(tx.fee);
      amount(tx.rent);
      operations.add(tx.operation);
    }
    return v;
  }
  private async save(value: Journal) {
    const serialized = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024)
      throw Error("journal_size_limit");
    const temp = this.path + "." + randomUUID();
    const f = await open(temp, "wx", 0o600);
    try {
      await f.writeFile(serialized);
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(temp, this.path);
    const d = await open(dirname(this.path), "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  }
  async initialize(budget: Omit<Journal, "version" | "transactions">) {
    this.paths.outsideGit(this.path);
    this.paths.privateDirectory(dirname(this.path));
    if (
      Object.keys(budget).sort().join(",") !==
      "available,cleanupReserve,feeAllowance,rentAllowance"
    )
      throw Error("invalid_budget");
    for (const n of Object.values(budget)) amount(n);
    if (amount(budget.available) < amount(budget.cleanupReserve))
      throw Error("cleanup_reserve");
    return this.locked(async () => {
      const f = await open(this.path, "wx", 0o600);
      try {
        await f.writeFile(
          JSON.stringify({ version: 1, ...budget, transactions: [] }) + "\n",
        );
        await f.sync();
      } finally {
        await f.close();
      }
      const d = await open(dirname(this.path), "r");
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    });
  }
  async submit(tx: Omit<PendingTransaction, "state">) {
    return this.locked(async () => {
      const journal = await this.load();
      const existing = journal.transactions.find(
        (t) => t.operation === tx.operation,
      );
      if (existing) {
        if (
          existing.signature !== tx.signature ||
          existing.wireBase64 !== tx.wireBase64
        )
          throw Error("uncertain_operation_cannot_be_replaced");
        return existing.state;
      }
      if (
        Object.keys(tx).sort().join(",") !==
          "fee,operation,rent,signature,wireBase64" ||
        typeof tx.operation !== "string" ||
        !tx.operation ||
        tx.operation.length > 128 ||
        typeof tx.signature !== "string" ||
        !tx.signature ||
        tx.signature.length > 128 ||
        typeof tx.wireBase64 !== "string" ||
        !tx.wireBase64 ||
        tx.wireBase64.length > 1644 ||
        journal.transactions.length >= 4096 ||
        Buffer.from(tx.wireBase64, "base64").toString("base64") !==
          tx.wireBase64
      )
        throw Error("invalid_transaction");
      const fees =
        journal.transactions.reduce((s, t) => s + amount(t.fee), 0n) +
        amount(tx.fee);
      const rents =
        journal.transactions.reduce((s, t) => s + amount(t.rent), 0n) +
        amount(tx.rent);
      if (
        fees > amount(journal.feeAllowance) ||
        rents > amount(journal.rentAllowance) ||
        fees + rents + amount(journal.cleanupReserve) >
          amount(journal.available)
      )
        throw Error("budget_or_cleanup_reserve");
      const entry: PendingTransaction = { ...tx, state: "reserved" };
      journal.transactions.push(entry);
      await this.save(journal);
      const signature = await this.transport.sendExact(tx.wireBase64);
      if (signature !== tx.signature)
        throw Error("submission_signature_mismatch");
      entry.state = "broadcast";
      await this.save(journal);
      return entry.state;
    });
  }
  async reconcile(operation: string) {
    return this.locked(async () => {
      const journal = await this.load();
      const tx = journal.transactions.find((t) => t.operation === operation);
      if (!tx) throw Error("unknown_operation");
      if (tx.state === "finalized" || tx.state === "failed") return tx.state;
      const state = await this.transport.status(tx.signature);
      if (state === "finalized" || state === "failed") {
        tx.state = state;
        await this.save(journal);
      }
      // Unknown after timeout/blockhash expiry remains reserved; no new signed replacement.
      return tx.state;
    });
  }
}

export class TransactionCoordinator extends SubmissionJournal {
  constructor(
    path: string,
    transport: LocalSubmissionTransport,
    paths: JournalPathIO = protectedPaths,
  ) {
    if (transport.localOnly !== true) throw Error("local_transport_required");
    super(path, transport, paths);
  }
}
