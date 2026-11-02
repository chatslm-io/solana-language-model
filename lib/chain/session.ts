import {
  address,
  AccountRole,
  getTransactionDecoder,
  getTransactionEncoder,
  signTransaction,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  account,
  chainCheck,
  discover,
  estimateDeployment,
  preview,
  verifyDeployment,
  type Config,
  type RPC,
  type Operation,
} from "./client";
import {
  planUploadBatch,
  previewBatch,
  submitBatch,
  type BatchPreview,
} from "./batch";
import { HEADER, SYSTEM, concat, u32, u64 } from "./protocol";
import {
  decodeHeader,
  sessionAddress,
  registryAddress,
  openSessionInstruction,
  delegateInstruction,
  sha256,
} from "./protocol";
import { canonical, validateManifest, type Manifest } from "../model/manifest";

export type SessionPlan = {
  batch: BatchPreview;
  owner: Address;
  delegate: Address;
  session: Address;
  id: string;
  hash: string;
  budget: bigint;
  allowance: bigint;
  expires: bigint;
  maxOperations: number;
  reservedTransactions: number;
};
export function devnetSession(config: Config) {
  if (config.cluster !== "devnet")
    throw new Error(
      "Delegated upload is devnet-only while recovery is being validated",
    );
}

export async function prepareSession(
  rpc: RPC,
  config: Config,
  owner: Address,
  delegate: Address,
  id: string,
  hash: string,
  manifest: Manifest,
): Promise<SessionPlan> {
  devnetSession(config);
  validateManifest(manifest);
  if ((await sha256(new TextEncoder().encode(canonical(manifest)))) !== hash)
    throw new Error("Manifest commitment mismatch");
  await chainCheck(rpc, config);
  const program = address(config.program!),
    registry = await registryAddress(program, owner, id),
    session = await sessionAddress(program, owner, id);
  const old = await account(rpc, session);
  if (old && (old.owner !== SYSTEM || old.bytes.length))
    throw new Error(
      "An upload session already exists. Revoke it in Withdraw before authorizing a replacement.",
    );
  const reg = await account(rpc, registry);
  if (reg?.owner === program) {
    const h = decodeHeader(reg.bytes);
    if (
      h.state !== 0 ||
      h.authority !== owner ||
      h.hash !== hash ||
      h.count !== manifest.shards.length ||
      h.bytes !== BigInt(manifest.payloadBytes)
    )
      throw new Error("Registry is not available for this upload session");
  }
  const estimate = await estimateDeployment(
    rpc,
    program,
    owner,
    id,
    hash,
    manifest,
  );
  const rent = await rpc
    .getMinimumBalanceForRentExemption(BigInt(HEADER))
    .send();
  const registryDeposit =
    reg?.owner === program
      ? 0n
      : rent > (reg?.lamports || 0n)
        ? rent - (reg?.lamports || 0n)
        : 0n;
  const sessionDeposit =
    rent > (old?.lamports || 0n) ? rent - (old?.lamports || 0n) : 0n;
  const budget = estimate.deposit - registryDeposit;
  const maxOperations =
    estimate.transactions - (reg?.owner === program ? 0 : 1);
  if (maxOperations < 1) throw new Error("Upload already complete");
  // Keep the fee payer rent exempt while executing, with a bounded retry reserve.
  const allowance =
    (await rpc.getMinimumBalanceForRentExemption(0n).send()) +
    estimate.fees * 2n;
  const expires =
    (await rpc.getSlot({ commitment: "confirmed" }).send()) + 9000n;
  const deposit = registryDeposit + sessionDeposit + budget + allowance;
  const op: Operation = {
    kind: "session",
    label: "Authorize upload session and fund its budget",
    account: session,
    deposit,
    reclaim: 0n,
    expectedLamports: old?.lamports || 0n,
    instruction: openSessionInstruction(
      program,
      owner,
      registry,
      session,
      delegate,
      {
        id,
        hash,
        count: manifest.shards.length,
        bytes: BigInt(manifest.payloadBytes),
        budget,
        fees: allowance,
        expires,
        maxOperations,
        cap: deposit,
      },
    ),
  };
  const found = await discover(rpc, program, owner);
  return {
    batch: await previewBatch(
      rpc,
      config,
      owner,
      [op],
      found.reduce((n, a) => n + a.lamports, 0n),
    ),
    owner,
    delegate,
    session,
    id,
    hash,
    budget,
    allowance,
    expires,
    maxOperations,
    reservedTransactions: maxOperations + 2,
  };
}

async function signBatch(batch: BatchPreview, signer: KeyPairSigner) {
  return Promise.all(
    batch.transactions.map(async (p) =>
      Uint8Array.from(
        getTransactionEncoder().encode(
          await signTransaction(
            [signer.keyPair],
            getTransactionDecoder().decode(p.wire),
          ),
        ),
      ),
    ),
  );
}

// The callback must durably journal all signatures before broadcasting (submitBatch
// calls it for every member first). A failed callback stops the run.
export async function uploadSession(
  rpc: RPC,
  config: Config,
  plan: SessionPlan,
  signer: KeyPairSigner,
  manifest: Manifest,
  getShard: (index: number) => Promise<Uint8Array>,
  status: (
    batch: BatchPreview,
    index: number,
    status: string,
    signature: string,
  ) => void,
  isCurrent: () => boolean,
) {
  devnetSession(config);
  if (signer.address !== plan.delegate)
    throw new Error("Session signer changed");
  const program = address(config.program!);
  while (isCurrent()) {
    await chainCheck(rpc, config);
    const vault = await account(rpc, plan.session);
    if (!vault || vault.owner !== program)
      throw new Error("Upload session was revoked");
    const h = decodeHeader(vault.bytes),
      s = h.session;
    if (
      h.authority !== plan.owner ||
      h.id !== plan.id ||
      h.hash !== plan.hash ||
      h.count !== manifest.shards.length ||
      h.bytes !== BigInt(manifest.payloadBytes) ||
      !s ||
      s.delegate !== signer.address ||
      s.expires !== plan.expires ||
      s.budget !== plan.budget ||
      s.maxOperations !== plan.maxOperations
    )
      throw new Error("Session authorization changed");
    const found = await discover(rpc, program, plan.owner);
    const operations = await planUploadBatch(
      rpc,
      program,
      plan.owner,
      plan.id,
      plan.hash,
      manifest,
      getShard,
      found,
      8,
    );
    if (!operations.length) {
      await verifyDeployment(
        rpc,
        program,
        plan.owner,
        plan.id,
        plan.hash,
        manifest,
        () => {},
      );
      return;
    }
    if ((await rpc.getSlot({ commitment: "confirmed" }).send()) >= s.expires)
      throw new Error(
        "Upload session expired. Revoke and authorize a replacement to resume.",
      );
    if (s.operations + operations.length > s.maxOperations)
      throw new Error("Session operation cap reached");
    if (operations.reduce((n, o) => n + o.deposit, 0n) > s.budget - s.spent)
      throw new Error("Session rent budget exhausted");
    const batch = await previewBatch(
      rpc,
      config,
      signer.address,
      operations.map((o) => ({
        ...o,
        deposit: 0n,
        instruction: delegateInstruction(
          o.instruction,
          signer.address,
          plan.session,
        ),
      })),
    );
    if (!isCurrent()) break;
    const signed = await signBatch(batch, signer);
    await submitBatch(
      rpc,
      batch,
      signed,
      (i, state, sig) => status(batch, i, state, sig),
      isCurrent,
    );
  }
  throw new Error(
    "Upload paused. Phantom can revoke the session and recover storage independently.",
  );
}

export async function refundSessionFees(
  rpc: RPC,
  config: Config,
  plan: SessionPlan,
  signer: KeyPairSigner,
  status: (
    batch: BatchPreview,
    index: number,
    status: string,
    signature: string,
  ) => void,
  isCurrent: () => boolean,
) {
  devnetSession(config);
  if (signer.address !== plan.delegate || !isCurrent())
    throw new Error("Session signer changed or upload paused");
  const balance = (
    await rpc.getBalance(signer.address, { commitment: "finalized" }).send()
  ).value;
  if (balance === 0n) return;
  const ix = (amount: bigint) => ({
    programAddress: SYSTEM,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: plan.owner, role: AccountRole.WRITABLE },
    ],
    data: concat(u32(2), u64(amount)),
  });
  // Quote using a zero transfer, then simulate the exact full-balance refund.
  const quote = await preview(rpc, config, signer.address, {
    kind: "feeRefund",
    label: "Return unused session fees",
    account: signer.address,
    deposit: 0n,
    reclaim: 0n,
    instruction: ix(0n),
  });
  if (balance <= quote.fee) return;
  const p = await preview(rpc, config, signer.address, {
    kind: "feeRefund",
    label: "Return unused session fees to owner",
    refundRecipient: plan.owner,
    account: signer.address,
    deposit: 0n,
    reclaim: balance - quote.fee,
    expectedLamports: balance,
    instruction: ix(balance - quote.fee),
  });
  if (p.fee !== quote.fee)
    throw new Error(
      "Fee changed; leave the unused allowance for later recovery",
    );
  const batch: BatchPreview = {
    transactions: [p],
    authority: signer.address,
    program: p.program,
    cluster: p.cluster,
    deposit: 0n,
    reclaim: balance - p.fee,
    fee: p.fee,
    balance,
    held: 0n,
  };
  await submitBatch(
    rpc,
    batch,
    await signBatch(batch, signer),
    (i, state, sig) => status(batch, i, state, sig),
    isCurrent,
  );
}
