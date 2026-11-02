import {
  address,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  appendTransactionMessageInstruction,
  compileTransaction,
  getTransactionEncoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  getBase58Decoder,
  type Address,
  type Instruction,
  type Signature,
  type Base64EncodedWireTransaction,
  type TransactionMessageBytesBase64,
  type Blockhash,
} from "@solana/kit";
import {
  HEADER,
  SHARD_BYTES,
  CHUNK_BYTES,
  SYSTEM,
  base64,
  fromBase64,
  decodeHeader,
  registryAddress,
  shardAddress,
  sessionAddress,
  instruction,
  sha256,
  hex,
  type Header,
} from "./protocol";
import type { Manifest } from "@/lib/model/manifest";
import { canonical, validateManifest } from "@/lib/model/manifest";
export type Config = {
  cluster: string;
  program: string | null;
  rpcDisplay: string;
  maxDeposit: string;
  maxTransactions: number;
};
export const rpcClient = (url: string) => {
  const transport = createDefaultRpcTransport({
    url,
    headers: { "X-SLM-Local": "1" },
  });
  return createSolanaRpcFromTransport(
    async <T>(request: Parameters<typeof transport>[0]) => {
      try {
        return await transport<T>(request);
      } catch (e) {
        if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
          const status = e.context.statusCode;
          throw new Error(
            status === 429
              ? "Solana RPC rate limit reached (429). Wait a few seconds and try again. If a transaction was already signed, reconcile the journal before resuming."
              : `Local RPC request failed (HTTP ${status}). If a transaction was already signed, reconcile the journal before resuming.`,
          );
        }
        throw e;
      }
    },
  );
};
export type RPC = ReturnType<typeof rpcClient>;
export type StoredAccount = {
  address: Address;
  lamports: bigint;
  space: number;
  owner: Address;
  header: Header;
  recoverable: boolean;
  reason?: string;
};
export type Operation = {
  label: string;
  account: Address;
  instruction: Instruction;
  deposit: bigint;
  reclaim: bigint;
  kind:
    | "create"
    | "write"
    | "finalize"
    | "close"
    | "seal"
    | "session"
    | "feeRefund";
  expectedLamports?: bigint;
  expectedHash?: string;
  refundRecipient?: Address;
};
export type Preview = {
  operation: Operation;
  wire: Uint8Array;
  message: Uint8Array;
  fee: bigint;
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
  authority: Address;
  program: Address;
  cluster: string;
  createdAt: number;
  balance: bigint;
  held: bigint;
  simulation: "passed";
};
export async function api<T>(action: string, input: unknown = {}): Promise<T> {
  const r = await fetch(`/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SLM-Local": "1" },
    body: JSON.stringify(input),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Local request failed");
  return data;
}
export async function chainCheck(rpc: RPC, config: Config) {
  const genesis = await rpc.getGenesisHash().send();
  const expected: Record<string, string> = {
    devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  };
  if (config.cluster === "localnet") {
    if (
      Object.values(expected).includes(genesis) ||
      genesis === "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
    )
      throw new Error("Localnet RPC points to a public cluster");
  } else if (expected[config.cluster] !== genesis)
    throw new Error("RPC genesis hash does not match selected cluster");
  if (!config.program)
    throw new Error("No reviewed program ID configured for this cluster");
  const program = await rpc
    .getAccountInfo(address(config.program), {
      encoding: "base64",
      commitment: "finalized",
    })
    .send();
  if (!program.value?.executable)
    throw new Error(
      "Configured storage program is not deployed on this cluster",
    );
}
export async function account(rpc: RPC, key: Address) {
  const r = await rpc
    .getAccountInfo(key, { encoding: "base64", commitment: "finalized" })
    .send();
  return r.value ? { ...r.value, bytes: fromBase64(r.value.data[0]) } : null;
}
export async function discover(
  rpc: RPC,
  program: Address,
  authority: Address,
): Promise<StoredAccount[]> {
  const result = await rpc
    .getProgramAccounts(program, {
      encoding: "base64",
      commitment: "finalized",
      filters: [
        { memcmp: { offset: 16n, bytes: authority, encoding: "base58" } },
      ],
      dataSlice: { offset: 0, length: HEADER },
    })
    .send();
  const out: StoredAccount[] = [];
  for (const a of result) {
    const h = decodeHeader(fromBase64(a.account.data[0]));
    const expected =
      h.kind === 1
        ? await registryAddress(program, authority, h.id)
        : h.kind === 3
          ? await sessionAddress(program, authority, h.id)
          : await shardAddress(program, authority, h.id, h.index);
    const reg = await registryAddress(program, authority, h.id);
    const recoverable =
      a.pubkey === expected &&
      h.authority === authority &&
      a.account.owner === program &&
      (h.kind !== 2 || h.registry === reg) &&
      (h.kind !== 3 || (Number(a.account.space) === HEADER && h.state === 0));
    out.push({
      address: a.pubkey,
      lamports: a.account.lamports,
      space: Number(a.account.space),
      owner: a.account.owner,
      header: h,
      recoverable,
      reason: recoverable ? undefined : "Ownership or PDA validation failed",
    });
  }
  return out.sort(
    (a, b) =>
      a.header.id.localeCompare(b.header.id) ||
      b.header.kind - a.header.kind ||
      a.header.index - b.header.index,
  );
}
export function transaction(
  authority: Address,
  ix: Instruction,
  blockhash: Blockhash,
  lastValidBlockHeight: bigint,
) {
  // Phantom inserts priority-fee instructions when none are present, including
  // for sign-only requests. Pin both values BEFORE simulation and fee preview
  // so the wallet can sign the exact reviewed message. Each transaction has
  // one storage operation; retain its existing 200,000 CU allowance and zero
  // priority fee. Never accept wallet changes after approval instead.
  const message = appendTransactionMessageInstruction(
    ix,
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash, lastValidBlockHeight },
      setTransactionMessageFeePayer(
        authority,
        setTransactionMessageComputeUnitPrice(
          0n,
          setTransactionMessageComputeUnitLimit(
            200_000,
            createTransactionMessage({ version: 0 }),
          ),
        ),
      ),
    ),
  );
  const tx = compileTransaction(message);
  const wire = Uint8Array.from(getTransactionEncoder().encode(tx));
  if (wire.length > 1232)
    throw new Error("Transaction exceeds the conservative 1,232-byte limit");
  return { wire, message: Uint8Array.from(tx.messageBytes), tx };
}
export function describeRpcError(error: unknown) {
  return JSON.stringify(error, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}
export async function preview(
  rpc: RPC,
  config: Config,
  authority: Address,
  operation: Operation,
  held = 0n,
  shared?: {
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
    balance: bigint;
  },
): Promise<Preview> {
  if (!shared) await chainCheck(rpc, config);
  const commitment = shared ? "confirmed" : "finalized";
  const life =
    shared || (await rpc.getLatestBlockhash({ commitment }).send()).value;
  const { wire, message } = transaction(
    authority,
    operation.instruction,
    life.blockhash,
    life.lastValidBlockHeight,
  );
  const fee = (
    await rpc
      .getFeeForMessage(base64(message) as TransactionMessageBytesBase64, {
        commitment,
      })
      .send()
  ).value;
  if (fee === null)
    throw new Error("Unable to quote the exact transaction fee");
  const balance =
    shared?.balance ??
    (await rpc.getBalance(authority, { commitment }).send()).value;
  if (balance < operation.deposit + fee)
    throw new Error("Wallet cannot cover the deposit and transaction fee");
  const simulation = await rpc
    .simulateTransaction(base64(wire) as Base64EncodedWireTransaction, {
      encoding: "base64",
      sigVerify: false,
      commitment,
    })
    .send();
  if (simulation.value.err)
    throw new Error(
      `Simulation failed: ${describeRpcError(simulation.value.err)}`,
    );
  return {
    operation,
    wire,
    message,
    fee,
    blockhash: life.blockhash,
    lastValidBlockHeight: life.lastValidBlockHeight,
    authority,
    program: address(config.program!),
    cluster: config.cluster,
    createdAt: Date.now(),
    balance,
    held,
    simulation: "passed",
  };
}
export async function nextUpload(
  rpc: RPC,
  program: Address,
  authority: Address,
  id: string,
  manifestHash: string,
  m: Manifest,
  getShard: (index: number) => Promise<Uint8Array>,
): Promise<Operation | null> {
  validateManifest(m);
  if ((await sha256(new TextEncoder().encode(canonical(m)))) !== manifestHash)
    throw new Error("Manifest commitment mismatch");
  let offset = 0;
  if (
    m.version !== 1 ||
    !m.shards.length ||
    m.shards.some((s, i) => {
      const invalid =
        s.index !== i ||
        s.length < 1 ||
        s.length > SHARD_BYTES ||
        s.offset !== offset;
      offset += s.length;
      return invalid;
    }) ||
    offset !== m.payloadBytes
  )
    throw new Error("Invalid manifest layout");
  const registry = await registryAddress(program, authority, id);
  const reg = await account(rpc, registry);
  const create = async (
    key: Address,
    size: number,
    label: string,
    make: (cap: bigint) => Instruction,
  ): Promise<Operation> => {
    const existing = await account(rpc, key);
    if (existing && (existing.owner !== SYSTEM || existing.bytes.length))
      throw new Error("PDA already has an unexpected owner or allocation");
    const rent = await rpc
      .getMinimumBalanceForRentExemption(BigInt(size), {
        commitment: "finalized",
      })
      .send();
    const deposit =
      rent > (existing?.lamports || 0n)
        ? rent - (existing?.lamports || 0n)
        : 0n;
    return {
      kind: "create",
      label,
      account: key,
      deposit,
      reclaim: 0n,
      expectedLamports: existing?.lamports || 0n,
      instruction: make(deposit),
    };
  };
  if (!reg || reg.owner === SYSTEM)
    return create(registry, HEADER, "Create deployment registry", (cap) =>
      instruction(program, authority, registry, "createRegistry", {
        id,
        hash: manifestHash,
        count: m.shards.length,
        bytes: BigInt(m.payloadBytes),
        cap,
      }),
    );
  if (reg.owner !== program) throw new Error("Unexpected registry owner");
  const rh = decodeHeader(reg.bytes);
  if (
    rh.authority !== authority ||
    rh.id !== id ||
    rh.hash !== manifestHash ||
    rh.count !== m.shards.length ||
    rh.bytes !== BigInt(m.payloadBytes)
  )
    throw new Error("Deployment does not match this wallet and manifest");
  if (rh.state === 2)
    throw new Error(
      "This deployment is withdrawing. Finish recovery before creating a new deployment.",
    );
  for (const s of m.shards) {
    const key = await shardAddress(program, authority, id, s.index);
    const a = await account(rpc, key);
    if (!a || a.owner === SYSTEM)
      return create(key, HEADER + s.length, `Create shard ${s.index}`, (cap) =>
        instruction(program, authority, registry, "createShard", {
          shard: key,
          index: s.index,
          length: s.length,
          hash: s.sha256,
          cap,
        }),
      );
    if (a.owner !== program) throw new Error("Unexpected shard owner");
    const h = decodeHeader(a.bytes);
    if (
      h.authority !== authority ||
      h.id !== id ||
      h.registry !== registry ||
      h.index !== s.index ||
      h.length !== s.length ||
      h.hash !== s.sha256 ||
      h.written > h.length ||
      a.bytes.length !== HEADER + s.length
    )
      throw new Error("Shard does not match the committed manifest");
    if (h.state === 1) {
      if ((await sha256(a.bytes.subarray(HEADER))) !== s.sha256)
        throw new Error("Finalized shard failed verification");
      continue;
    }
    const local = await getShard(s.index);
    if (local.length !== s.length || (await sha256(local)) !== s.sha256)
      throw new Error("Local shard bytes failed checksum");
    if (
      hex(a.bytes.subarray(HEADER, HEADER + h.written)) !==
      hex(local.subarray(0, h.written))
    )
      throw new Error(
        "Uploaded prefix differs from local bytes; withdraw this deployment",
      );
    if (h.written < s.length)
      return {
        kind: "write",
        label: `Write shard ${s.index} · bytes ${h.written}–${Math.min(s.length, h.written + CHUNK_BYTES)}`,
        account: key,
        deposit: 0n,
        reclaim: 0n,
        instruction: instruction(program, authority, registry, "write", {
          shard: key,
          offset: h.written,
          chunk: local.subarray(
            h.written,
            Math.min(s.length, h.written + CHUNK_BYTES),
          ),
        }),
      };
    return {
      kind: "finalize",
      label: `Finalize shard ${s.index} (SHA-256)`,
      account: key,
      deposit: 0n,
      reclaim: 0n,
      expectedHash: s.sha256,
      instruction: instruction(program, authority, registry, "finalize", {
        shard: key,
      }),
    };
  }
  if (rh.state !== 1)
    return {
      kind: "seal",
      label: "Seal verified deployment",
      account: registry,
      deposit: 0n,
      reclaim: 0n,
      instruction: instruction(program, authority, registry, "seal"),
    };
  return null;
}
export async function verifyDeployment(
  rpc: RPC,
  program: Address,
  authority: Address,
  id: string,
  manifestHash: string,
  m: Manifest,
  progress: (index: number, ok: boolean) => void,
) {
  validateManifest(m);
  if ((await sha256(new TextEncoder().encode(canonical(m)))) !== manifestHash)
    throw new Error("Manifest checksum mismatch");
  const registry = await registryAddress(program, authority, id);
  const r = await account(rpc, registry);
  if (!r)
    throw new Error(
      "No onchain deployment found for this wallet and deployment ID. Upload it first, then verify. If it was already uploaded, check the wallet, cluster, and deployment ID.",
    );
  if (r.owner !== program)
    throw new Error("Deployment registry belongs to a different program");
  const h = decodeHeader(r.bytes);
  if (
    h.authority !== authority ||
    h.id !== id ||
    h.hash !== manifestHash ||
    h.state !== 1 ||
    h.count !== m.shards.length ||
    h.live !== h.count ||
    h.finalized !== h.count ||
    h.bytes !== BigInt(m.payloadBytes)
  )
    throw new Error(
      "Deployment is not finalized or does not match the manifest",
    );
  for (const s of m.shards) {
    const a = await account(
      rpc,
      await shardAddress(program, authority, id, s.index),
    );
    const sh = a && a.owner === program ? decodeHeader(a.bytes) : null;
    const ok =
      !!a &&
      !!sh &&
      sh.state === 1 &&
      sh.authority === authority &&
      sh.id === id &&
      sh.index === s.index &&
      sh.registry === registry &&
      sh.length === s.length &&
      sh.written === s.length &&
      sh.hash === s.sha256 &&
      a.bytes.length === HEADER + s.length &&
      (await sha256(a.bytes.subarray(HEADER))) === s.sha256;
    progress(s.index, ok);
    if (!ok) throw new Error(`Shard ${s.index} failed finalized verification`);
  }
}
export async function nextWithdrawal(
  program: Address,
  authority: Address,
  accounts: StoredAccount[],
  selected: Set<string>,
): Promise<Operation | null> {
  const eligible = accounts.filter((a) => selected.has(a.address));
  if (eligible.some((a) => !a.recoverable))
    throw new Error(
      "Selection includes an account that failed recovery checks",
    );
  for (const a of eligible) {
    const h = a.header;
    const registry = await registryAddress(program, authority, h.id);
    if (h.kind === 1 && h.live > 0) continue;
    return {
      kind: "close",
      label:
        h.kind === 1
          ? "Close empty registry"
          : h.kind === 3
            ? "Revoke session / reclaim unused budget"
            : `Close shard ${h.index}`,
      account: a.address,
      deposit: 0n,
      reclaim: a.lamports,
      expectedLamports: a.lamports,
      instruction: instruction(
        program,
        authority,
        h.kind === 3 ? a.address : registry,
        h.kind === 1
          ? "closeRegistry"
          : h.kind === 3
            ? "closeSession"
            : "closeShard",
        { id: h.id, index: h.index, shard: a.address },
      ),
    };
  }
  if (eligible.length)
    throw new Error(
      "Registry still has live shards. Select and close them first.",
    );
  return null;
}
export function assertSignedMessage(
  preview: Pick<Preview, "message" | "authority">,
  signed: Uint8Array,
) {
  const decoded = getTransactionDecoder().decode(signed);
  if (hex(Uint8Array.from(decoded.messageBytes)) !== hex(preview.message))
    throw new Error(
      `Wallet changed the previewed transaction; submission blocked. ${describeMessageChange(preview.message, Uint8Array.from(decoded.messageBytes))} Prepare a fresh preview and leave Phantom's fee settings unchanged.`,
    );
  const signature = decoded.signatures[preview.authority];
  if (!signature || signature.every((n) => n === 0))
    throw new Error("Wallet signature missing");
  return getBase58Decoder().decode(signature) as Signature;
}
function describeMessageChange(before: Uint8Array, after: Uint8Array): string {
  // Report structure only: never include transaction bytes, payloads, or keys.
  try {
    const decoder = getCompiledTransactionMessageDecoder();
    const a = decoder.decode(before),
      b = decoder.decode(after);
    const changes: string[] = [];
    if (a.version !== b.version) changes.push("message version");
    if (a.lifetimeToken !== b.lifetimeToken) changes.push("blockhash");
    if (JSON.stringify(a.header) !== JSON.stringify(b.header))
      changes.push("account permissions");
    if (JSON.stringify(a.staticAccounts) !== JSON.stringify(b.staticAccounts))
      changes.push("account list/order");
    if (
      a.version !== 1 &&
      b.version !== 1 &&
      a.instructions.length !== b.instructions.length
    )
      changes.push(
        `instruction count ${a.instructions.length} to ${b.instructions.length}`,
      );
    return `Changed: ${changes.join(", ") || "instruction encoding or lookup tables"}.`;
  } catch {
    return "Returned message encoding differs.";
  }
}
export async function submit(
  rpc: RPC,
  p: Preview,
  signed: Uint8Array,
  onStatus: (status: string, signature?: string) => void,
) {
  const sig = assertSignedMessage(p, signed);
  onStatus("signed", sig);
  if (
    (await rpc.getBlockHeight({ commitment: "finalized" }).send()) >
    p.lastValidBlockHeight
  )
    throw new Error("Preview expired; prepare a fresh preview");
  if (p.operation.expectedLamports !== undefined) {
    const a = await account(rpc, p.operation.account);
    if ((a?.lamports || 0n) !== p.operation.expectedLamports)
      throw new Error("Account balance changed; prepare a fresh preview");
  }
  // Record the deterministic signature before submission: a transport timeout may still have landed.
  onStatus("submitting", sig);
  let sendError = false;
  try {
    await rpc
      .sendTransaction(base64(signed) as Base64EncodedWireTransaction, {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "finalized",
        maxRetries: 3n,
      })
      .send();
  } catch {
    sendError = true;
  }
  onStatus(
    sendError ? "submission uncertain; checking signature" : "submitted",
    sig,
  );
  for (let i = 0; i < 90; i++) {
    const status = (
      await rpc
        .getSignatureStatuses([sig], { searchTransactionHistory: true })
        .send()
    ).value[0];
    if (status?.err)
      throw new Error(`Transaction failed: ${describeRpcError(status.err)}`);
    if (status?.confirmationStatus === "finalized") {
      onStatus("finalized", sig);
      if (p.operation.kind === "close") await verifyClosure(rpc, p, sig);
      else if (p.operation.kind === "finalize") {
        const a = await account(rpc, p.operation.account);
        if (
          !a ||
          decodeHeader(a.bytes).state !== 1 ||
          (await sha256(a.bytes.subarray(HEADER))) !== p.operation.expectedHash
        )
          throw new Error("Finalized shard failed readback");
      }
      onStatus(
        p.operation.kind === "close" || p.operation.kind === "finalize"
          ? "verified"
          : "finalized",
        sig,
      );
      return sig;
    }
    if (
      !status &&
      (await rpc.getBlockHeight({ commitment: "finalized" }).send()) >
        p.lastValidBlockHeight
    )
      throw new Error(
        "Transaction expired without confirmation; rescan before retrying",
      );
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    "Confirmation pending. Keep this signature and rescan; do not assume failure.",
  );
}
export async function verifyClosure(
  rpc: RPC,
  p: Pick<Preview, "authority"> & {
    operation: Pick<Operation, "account" | "reclaim">;
  },
  sig: Signature,
) {
  const tx = await rpc
    .getTransaction(sig, {
      commitment: "finalized",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  if (!tx?.meta || tx.meta.err)
    throw new Error(
      "Finalized closure receipt unavailable; retry verification",
    );
  const keys = tx.transaction.message.accountKeys;
  const wi = keys.indexOf(p.authority),
    ai = keys.indexOf(p.operation.account);
  if (wi < 0 || ai < 0) throw new Error("Closure receipt account mismatch");
  const recovered = tx.meta.preBalances[ai];
  const delta =
    tx.meta.postBalances[wi] - tx.meta.preBalances[wi] + tx.meta.fee;
  if (
    tx.meta.postBalances[ai] !== 0n ||
    delta !== recovered ||
    recovered < p.operation.reclaim
  )
    throw new Error("Closure receipt does not prove the expected refund");
  if (await account(rpc, p.operation.account))
    throw new Error(
      "Account still exists at finalized commitment; inspect before retrying",
    );
  return recovered;
}
export type Estimate = {
  rent: bigint;
  deposit: bigint;
  balanceAfter: bigint;
  fees: bigint;
  transactions: number;
  accounts: { address: Address; size: number; rent: bigint }[];
};
export async function estimateDeployment(
  rpc: RPC,
  program: Address,
  authority: Address,
  id: string,
  manifestHash: string,
  m: Manifest,
): Promise<Estimate> {
  validateManifest(m);
  const rents = new Map<number, bigint>();
  for (const n of new Set([HEADER, ...m.shards.map((s) => HEADER + s.length)]))
    rents.set(
      n,
      await rpc
        .getMinimumBalanceForRentExemption(BigInt(n), {
          commitment: "finalized",
        })
        .send(),
    );
  const registry = await registryAddress(program, authority, id);
  const accounts = [
    { address: registry, size: HEADER, rent: rents.get(HEADER)! },
  ];
  for (const s of m.shards)
    accounts.push({
      address: await shardAddress(program, authority, id, s.index),
      size: HEADER + s.length,
      rent: rents.get(HEADER + s.length)!,
    });
  const life = (
    await rpc.getLatestBlockhash({ commitment: "finalized" }).send()
  ).value;
  const ix = instruction(program, authority, registry, "createRegistry", {
    id,
    hash: manifestHash,
    count: m.shards.length,
    bytes: BigInt(m.payloadBytes),
    cap: rents.get(HEADER)!,
  });
  const tx = transaction(
    authority,
    ix,
    life.blockhash,
    life.lastValidBlockHeight,
  );
  const fee = (
    await rpc
      .getFeeForMessage(base64(tx.message) as TransactionMessageBytesBase64, {
        commitment: "finalized",
      })
      .send()
  ).value;
  if (fee === null) throw new Error("Fee estimate unavailable");
  let transactions = 0,
    deposit = 0n,
    recoverable = 0n;
  const snapshots = new Map<
    Address,
    { owner: Address; lamports: bigint; bytes: Uint8Array } | null
  >();
  for (let at = 0; at < accounts.length; at += 100) {
    const group = accounts.slice(at, at + 100);
    const { value } = await rpc
      .getMultipleAccounts(
        group.map((a) => a.address),
        {
          encoding: "base64",
          commitment: "finalized",
          dataSlice: { offset: 0, length: HEADER },
        },
      )
      .send();
    if (value.length !== group.length)
      throw new Error("Incomplete account estimate response");
    value.forEach((a, i) =>
      snapshots.set(
        group[i].address,
        a ? { ...a, bytes: fromBase64(a.data[0]) } : null,
      ),
    );
  }
  for (const [i, entry] of accounts.entries()) {
    const existing = snapshots.get(entry.address);
    const initialized = existing?.owner === program;
    if (
      existing &&
      !initialized &&
      (existing.owner !== SYSTEM || existing.bytes.length)
    )
      throw new Error("Unexpected account in deployment estimate");
    const held = existing?.lamports || 0n;
    if (!initialized) deposit += entry.rent > held ? entry.rent - held : 0n;
    recoverable += initialized || held > entry.rent ? held : entry.rent;
    if (i === 0) {
      if (!initialized) transactions += 2;
      else if (decodeHeader(existing!.bytes).state === 0) transactions++;
    } else {
      const shard = m.shards[i - 1];
      if (!initialized)
        transactions += 2 + Math.ceil(shard.length / CHUNK_BYTES);
      else {
        const h = decodeHeader(existing!.bytes);
        if (h.state === 0)
          transactions +=
            1 + Math.ceil((shard.length - h.written) / CHUNK_BYTES);
      }
    }
  }
  const fees = fee * BigInt(transactions);
  const balance = (
    await rpc.getBalance(authority, { commitment: "finalized" }).send()
  ).value;
  return {
    rent: recoverable,
    deposit,
    balanceAfter: balance - deposit - fees,
    fees,
    transactions,
    accounts,
  };
}
