import {
  address,
  signature,
  getTransactionDecoder,
  getPublicKeyFromAddress,
  verifySignature,
  type Address,
  type Signature,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import {
  account,
  assertSignedMessage,
  chainCheck,
  describeRpcError,
  nextUpload,
  nextWithdrawal,
  preview,
  verifyClosure,
  type Config,
  type Operation,
  type Preview,
  type RPC,
  type StoredAccount,
} from "./client";
import {
  HEADER,
  CHUNK_BYTES,
  SYSTEM,
  base64,
  decodeHeader,
  hex,
  instruction,
  registryAddress,
  shardAddress,
  sha256,
} from "./protocol";
import { canonical, validateManifest, type Manifest } from "../model/manifest";
import { mapConcurrent } from "./parallel";

export const MAX_BATCH_TRANSACTIONS = 16;
export class PendingTransactionsError extends Error {}
export class RecoverableBatchError extends Error {}
export type BatchPreview = {
  transactions: Preview[];
  authority: Address;
  program: Address;
  cluster: string;
  deposit: bigint;
  reclaim: bigint;
  fee: bigint;
  balance: bigint;
  held: bigint;
};
export type JournalEntry = {
  label: string;
  status: string;
  signature?: string;
  account?: string;
  reclaim?: string;
  operation?: string;
  expectedHash?: string;
  lastValidBlockHeight?: string;
  refundRecipient?: string;
};
export function batchLimit(limit: number) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_BATCH_TRANSACTIONS
  )
    throw new Error(
      `Choose between 1 and ${MAX_BATCH_TRANSACTIONS} transactions`,
    );
}

// Only independent operations enter one signing request. A registry must exist
// before shard creation; each shard advances once; sealing is a later request.
export async function planUploadBatch(
  rpc: RPC,
  program: Address,
  authority: Address,
  id: string,
  manifestHash: string,
  m: Manifest,
  getShard: (index: number) => Promise<Uint8Array>,
  found: StoredAccount[],
  limit: number,
): Promise<Operation[]> {
  batchLimit(limit);
  validateManifest(m);
  if ((await sha256(new TextEncoder().encode(canonical(m)))) !== manifestHash)
    throw new Error("Manifest commitment mismatch");
  const reg = await registryAddress(program, authority, id);
  const stored = found.filter((a) => a.header.id === id);
  if (stored.some((a) => !a.recoverable))
    throw new Error("Deployment failed account validation");
  const registry = stored.find((a) => a.address === reg);
  if (!registry) {
    const op = await nextUpload(
      rpc,
      program,
      authority,
      id,
      manifestHash,
      m,
      getShard,
    );
    return op ? [op] : [];
  }
  const rh = registry.header;
  if (
    rh.authority !== authority ||
    rh.hash !== manifestHash ||
    rh.count !== m.shards.length ||
    rh.bytes !== BigInt(m.payloadBytes)
  )
    throw new Error("Deployment does not match this wallet and manifest");
  if (rh.state === 2)
    throw new Error(
      "Deployment is withdrawing; finish recovery before uploading again",
    );
  const byIndex = new Map<number, StoredAccount>();
  for (const a of stored.filter((a) => a.header.kind === 2)) {
    const h = a.header,
      s = m.shards[h.index];
    if (
      !s ||
      byIndex.has(h.index) ||
      h.registry !== reg ||
      h.authority !== authority ||
      h.length !== s.length ||
      h.hash !== s.sha256 ||
      h.written > h.length
    )
      throw new Error("Shard does not match the committed manifest");
    byIndex.set(h.index, a);
  }
  if (rh.live !== byIndex.size)
    throw new Error("Incomplete RPC inventory; rescan before signing");
  const missing = m.shards.filter((s) => !byIndex.has(s.index));
  const candidates = (
    missing.length
      ? missing
      : m.shards.filter((s) => byIndex.get(s.index)!.header.state === 0)
  ).slice(0, limit);
  if (rh.state === 1 && candidates.length)
    throw new Error("Sealed deployment has incomplete shards");
  if (!candidates.length) {
    // The original planner verifies all finalized shard bytes before sealing.
    const op = await nextUpload(
      rpc,
      program,
      authority,
      id,
      manifestHash,
      m,
      getShard,
    );
    return op ? [op] : [];
  }
  const rents = new Map<number, bigint>(),
    operations: Operation[] = [];
  for (const s of candidates) {
    const key = await shardAddress(program, authority, id, s.index),
      a = await account(rpc, key);
    if (!a || a.owner === SYSTEM) {
      if (a?.bytes.length) throw new Error("PDA has an unexpected allocation");
      const size = HEADER + s.length;
      if (!rents.has(size))
        rents.set(
          size,
          await rpc
            .getMinimumBalanceForRentExemption(BigInt(size), {
              commitment: "finalized",
            })
            .send(),
        );
      const rent = rents.get(size)!,
        current = a?.lamports || 0n,
        deposit = rent > current ? rent - current : 0n;
      operations.push({
        kind: "create",
        label: `Create shard ${s.index}`,
        account: key,
        deposit,
        reclaim: 0n,
        expectedLamports: current,
        instruction: instruction(program, authority, reg, "createShard", {
          shard: key,
          index: s.index,
          length: s.length,
          hash: s.sha256,
          cap: deposit,
        }),
      });
      continue;
    }
    if (a.owner !== program) throw new Error("Unexpected shard owner");
    const h = decodeHeader(a.bytes);
    if (
      h.authority !== authority ||
      h.id !== id ||
      h.registry !== reg ||
      h.index !== s.index ||
      h.length !== s.length ||
      h.hash !== s.sha256 ||
      h.written > h.length ||
      a.bytes.length !== HEADER + s.length ||
      h.state !== 0
    )
      throw new Error("Shard changed; prepare a new batch");
    const local = await getShard(s.index);
    if (
      local.length !== s.length ||
      (await sha256(local)) !== s.sha256 ||
      hex(a.bytes.subarray(HEADER, HEADER + h.written)) !==
        hex(local.subarray(0, h.written))
    )
      throw new Error("Shard checksum or uploaded prefix mismatch");
    if (h.written < s.length) {
      const end = Math.min(s.length, h.written + CHUNK_BYTES);
      operations.push({
        kind: "write",
        label: `Write shard ${s.index} · bytes ${h.written}–${end}`,
        account: key,
        deposit: 0n,
        reclaim: 0n,
        instruction: instruction(program, authority, reg, "write", {
          shard: key,
          offset: h.written,
          chunk: local.subarray(h.written, end),
        }),
      });
    } else
      operations.push({
        kind: "finalize",
        label: `Finalize shard ${s.index} (SHA-256)`,
        account: key,
        deposit: 0n,
        reclaim: 0n,
        expectedHash: s.sha256,
        instruction: instruction(program, authority, reg, "finalize", {
          shard: key,
        }),
      });
  }
  return operations;
}

export async function planWithdrawalBatch(
  program: Address,
  authority: Address,
  accounts: StoredAccount[],
  selected: Set<string>,
  limit: number,
) {
  batchLimit(limit);
  const remaining = new Set(selected),
    operations: Operation[] = [];
  for (let i = 0; i < limit; i++) {
    // Registry live counts are deliberately not projected: close it only in a
    // subsequent batch, after every shard closure has finalized.
    const eligible = accounts.filter(
      (a) =>
        remaining.has(a.address) && !(a.header.kind === 1 && a.header.live > 0),
    );
    if (!eligible.length) break;
    const op = await nextWithdrawal(
      program,
      authority,
      accounts,
      new Set(eligible.map((a) => a.address)),
    );
    if (!op) break;
    operations.push(op);
    remaining.delete(op.account);
  }
  if (
    !operations.length &&
    accounts.some(
      (a) =>
        selected.has(a.address) && a.header.kind === 1 && a.header.live > 0,
    )
  )
    throw new Error(
      "Registry still has live shards. Select and close them first.",
    );
  return operations;
}

export async function previewBatch(
  rpc: RPC,
  config: Config,
  authority: Address,
  operations: Operation[],
  held = 0n,
  concurrency = 1,
): Promise<BatchPreview> {
  batchLimit(operations.length);
  batchLimit(concurrency);
  if (new Set(operations.map((o) => o.account)).size !== operations.length)
    throw new Error("Batch contains dependent operations for the same account");
  if (
    operations.some(
      (o) =>
        o.instruction.programAddress !== config.program ||
        o.deposit < 0n ||
        o.reclaim < 0n,
    )
  )
    throw new Error("Unexpected batch program or amount");
  if (
    operations.some((o) => o.kind === "close") &&
    operations.some((o) => o.kind !== "close")
  )
    throw new Error("Uploads and withdrawals require separate batches");
  await chainCheck(rpc, config);
  const balance = (
    await rpc.getBalance(authority, { commitment: "finalized" }).send()
  ).value;
  const deposit = operations.reduce((n, o) => n + o.deposit, 0n);
  if (balance < deposit)
    throw new Error("Wallet cannot cover the entire batch deposit and fees");
  const life = (
    await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
  ).value;
  const transactions = await mapConcurrent(operations, concurrency, (op) =>
    preview(rpc, config, authority, op, held, { ...life, balance }),
  );
  const reclaim = operations.reduce((n, o) => n + o.reclaim, 0n),
    fee = transactions.reduce((n, p) => n + p.fee, 0n);
  // Incoming refunds never fund the initial fee reserve for this batch.
  if (balance < deposit + fee)
    throw new Error("Wallet cannot cover the entire batch deposit and fees");
  if (
    life.lastValidBlockHeight -
      (await rpc.getBlockHeight({ commitment: "confirmed" }).send()) <
    30n
  )
    throw new Error(
      "Batch preview is near expiry. Prepare again or choose fewer transactions.",
    );
  return {
    transactions,
    authority,
    program: address(config.program!),
    cluster: config.cluster,
    deposit,
    reclaim,
    fee,
    balance,
    held,
  };
}

export async function assertSignedBatch(
  batch: BatchPreview,
  signed: readonly Uint8Array[],
): Promise<Signature[]> {
  batchLimit(batch.transactions.length);
  if (
    batch.transactions.some(
      (p) =>
        p.authority !== batch.authority ||
        p.program !== batch.program ||
        p.cluster !== batch.cluster ||
        p.blockhash !== batch.transactions[0].blockhash,
    )
  )
    throw new Error("Batch signing context changed; nothing was submitted");
  if (signed.length !== batch.transactions.length)
    throw new Error(
      "Wallet returned an incomplete batch; nothing was submitted",
    );
  const key = await getPublicKeyFromAddress(batch.authority);
  const signatures: Signature[] = [];
  for (let i = 0; i < signed.length; i++) {
    const p = batch.transactions[i],
      sig = assertSignedMessage(p, signed[i]);
    const tx = getTransactionDecoder().decode(signed[i]);
    if (
      !(await verifySignature(
        key,
        tx.signatures[batch.authority]!,
        tx.messageBytes,
      ))
    )
      throw new Error("Invalid wallet signature; nothing was submitted");
    signatures.push(sig);
  }
  if (new Set(signatures).size !== signatures.length)
    throw new Error("Wallet returned duplicate transactions");
  return signatures;
}

export async function verifyJournalEntry(
  rpc: RPC,
  authority: Address,
  entry: JournalEntry,
) {
  if (!entry.signature || !entry.account)
    throw new Error("Missing transaction journal metadata");
  if (entry.operation === "close")
    await verifyClosure(
      rpc,
      {
        authority,
        operation: {
          account: address(entry.account),
          reclaim: BigInt(entry.reclaim || "0"),
        },
      },
      signature(entry.signature),
    );
  if (entry.operation === "finalize") {
    const a = await account(rpc, address(entry.account));
    if (
      !a ||
      decodeHeader(a.bytes).state !== 1 ||
      (await sha256(a.bytes.subarray(HEADER))) !== entry.expectedHash
    )
      throw new Error("Finalized shard failed readback");
  }
  if (entry.operation === "feeRefund") {
    if (!entry.refundRecipient) throw new Error("Missing fee refund recipient");
    const tx = await rpc
      .getTransaction(signature(entry.signature), {
        commitment: "finalized",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (!tx?.meta || tx.meta.err)
      throw new Error("Fee refund receipt unavailable");
    const keys = tx.transaction.message.accountKeys,
      from = keys.indexOf(address(entry.account)),
      to = keys.indexOf(address(entry.refundRecipient));
    const amount = BigInt(entry.reclaim || "0");
    if (
      from !== 0 ||
      to < 0 ||
      to === from ||
      tx.meta.postBalances[from] !== 0n ||
      tx.meta.preBalances[from] !== amount + tx.meta.fee ||
      tx.meta.postBalances[to] - tx.meta.preBalances[to] !== amount
    )
      throw new Error("Fee refund receipt mismatch");
  }
}
export const resolvedEntry = (e: JournalEntry) =>
  e.status === "verified" ||
  e.status === "failed" ||
  e.status === "expired without confirmation" ||
  (e.status === "finalized" &&
    !["close", "finalize", "feeRefund"].includes(e.operation || ""));

export async function reconcileJournal(
  rpc: RPC,
  authority: Address,
  entries: JournalEntry[],
  persist: () => void,
) {
  const pending = entries.filter((e) => e.signature && !resolvedEntry(e));
  if (!pending.length) return;
  const height = await rpc.getBlockHeight({ commitment: "finalized" }).send();
  for (let at = 0; at < pending.length; at += 256) {
    const group = pending.slice(at, at + 256);
    const states = (
      await rpc
        .getSignatureStatuses(
          group.map((e) => signature(e.signature!)),
          { searchTransactionHistory: true },
        )
        .send()
    ).value;
    for (let i = 0; i < group.length; i++) {
      const e = group[i],
        state = states[i];
      if (state?.err) e.status = "failed";
      else if (state?.confirmationStatus === "finalized") {
        await verifyJournalEntry(rpc, authority, e);
        e.status = ["close", "finalize", "feeRefund"].includes(
          e.operation || "",
        )
          ? "verified"
          : "finalized";
      } else if (
        !state &&
        e.lastValidBlockHeight &&
        height > BigInt(e.lastValidBlockHeight)
      )
        e.status = "expired without confirmation";
      persist();
    }
  }
  if (pending.some((e) => !resolvedEntry(e)))
    throw new PendingTransactionsError(
      "Signed transactions are still pending. Recheck the journal before preparing another batch.",
    );
}

export async function submitBatch(
  rpc: RPC,
  batch: BatchPreview,
  signed: readonly Uint8Array[],
  onStatus: (index: number, status: string, signature: string) => void,
  isCurrent: () => boolean = () => true,
  concurrency = 3,
) {
  batchLimit(concurrency);
  const signatures = await assertSignedBatch(batch, signed);
  // All deterministic signatures must be durable before the first broadcast.
  signatures.forEach((sig, i) => onStatus(i, "signed; not submitted", sig));
  const life = batch.transactions[0].lastValidBlockHeight;
  if ((await rpc.getBlockHeight({ commitment: "confirmed" }).send()) >= life)
    throw new RecoverableBatchError(
      "Signed batch expired; reconcile and prepare a fresh batch",
    );
  for (const p of batch.transactions) {
    if (p.operation.expectedLamports !== undefined) {
      const current = await account(rpc, p.operation.account);
      if ((current?.lamports || 0n) !== p.operation.expectedLamports)
        throw new Error("Account balance changed; reconcile and prepare again");
    }
  }
  let cursor = 0,
    stop = false;
  const sent = new Set<number>();
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, signed.length) }, async () => {
      try {
        while (!stop && isCurrent()) {
          const i = cursor++;
          if (i >= signed.length) return;
          onStatus(i, "submitting", signatures[i]);
          sent.add(i);
          try {
            const sig = await rpc
              .sendTransaction(
                base64(signed[i]) as Base64EncodedWireTransaction,
                {
                  encoding: "base64",
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                  maxRetries: 3n,
                },
              )
              .send();
            if (sig !== signatures[i])
              throw new Error("RPC returned a different signature");
            onStatus(i, "submitted", signatures[i]);
          } catch {
            stop = true;
            onStatus(
              i,
              "submission uncertain; checking signature",
              signatures[i],
            );
          }
        }
      } catch (error) {
        // A failed journal write must stop other workers. Wait for every
        // in-flight send before releasing the browser's approval lock.
        stop = true;
        throw error;
      }
    }),
  );
  const workerError = workers.find((r) => r.status === "rejected");
  if (workerError?.status === "rejected")
    throw new Error(
      "Batch journal update failed. Recheck saved signatures before signing again.",
      { cause: workerError.reason },
    );
  const pending = new Set(sent),
    failures: string[] = [];
  for (let attempt = 0; pending.size && attempt < 90; attempt++) {
    const indexes = [...pending];
    const states = (
      await rpc
        .getSignatureStatuses(
          indexes.map((i) => signatures[i]),
          { searchTransactionHistory: true },
        )
        .send()
    ).value;
    for (let n = 0; n < indexes.length; n++) {
      const i = indexes[n],
        state = states[n],
        p = batch.transactions[i];
      if (state?.err) {
        onStatus(i, "failed", signatures[i]);
        failures.push(describeRpcError(state.err));
        pending.delete(i);
      } else if (state?.confirmationStatus === "finalized") {
        onStatus(i, "finalized; verification pending", signatures[i]);
        await verifyJournalEntry(rpc, batch.authority, {
          label: p.operation.label,
          status: "finalized",
          signature: signatures[i],
          account: p.operation.account,
          operation: p.operation.kind,
          reclaim: p.operation.reclaim.toString(),
          expectedHash: p.operation.expectedHash,
          refundRecipient: p.operation.refundRecipient,
        });
        onStatus(
          i,
          ["close", "finalize", "feeRefund"].includes(p.operation.kind)
            ? "verified"
            : "finalized",
          signatures[i],
        );
        pending.delete(i);
      }
    }
    if (
      pending.size &&
      (await rpc.getBlockHeight({ commitment: "finalized" }).send()) > life
    )
      break;
    if (pending.size) await new Promise((r) => setTimeout(r, 1500));
  }
  if (failures.length)
    throw new Error(
      `Transaction failed onchain: ${failures.join("; ")}. Review the journal before retrying.`,
    );
  if (pending.size || sent.size !== signed.length)
    throw new RecoverableBatchError(
      "Batch stopped or has unresolved transactions. Recheck the journal and rescan before signing again.",
    );
}
