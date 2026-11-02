/** Transactional model/table admission and owner recovery. Never installs accounts
 * directly or computes production activations offchain. */
import { join } from "node:path";
import { modelUploadOperations } from "../client/model-upload-plan";
import {
  address,
  getAddressEncoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import { TransactionCoordinator } from "../coordinator/transactions";
import { modelCommitment } from "../protocol";
import { recoveryPlan, type PublicAccount } from "../coordinator/recovery";
import type { PublicModelFixture } from "./model-fixture";
import type { TokenizerFixture } from "./tokenizer-fixture";
import type { TestProgress } from "./progress";
import {
  instructionWireBytes,
  type ForkModelTransport,
  type ForkModelJournalFactory,
} from "./fork-model";
import {
  UploadTransactionSender,
  type UploadTransactionRecord,
} from "./upload-transactions";
import { loadPublicReference } from "../reference/deepseek2";
import { tokenizerMetadata } from "../../private-inference/reference/tokenizer";
import { publicTokenizer, type PublicMessage } from "../client/tokenizer";
const JOURNAL_ENTRIES = 1024,
  MAX_FUNDING = 100000000000n;
type UploadOperation = { name: string; instruction: Instruction; rent: bigint };
type RawAccount = {
  owner: string;
  executable: boolean;
  data: [string, string];
  lamports: number | bigint;
};
export type UploadSummary = {
  modelPages: number;
  tokenizerPages: number;
  accountCount: number;
  payloadBytes: number;
  uploadTransactions: number;
  maxWireBytes: number;
  maxComputeUnits: number;
  receipts: readonly UploadTransactionRecord[];
  rentDepositedLamports: string;
  feesLamports: string;
  fundedLamports: string;
  modelUploadTested: true;
  allAccountsVerified: true;
};
export type UploadRecoverySummary = {
  closedAccounts: number;
  transactions: number;
  maxWireBytes: number;
  maxComputeUnits: number;
  receipts: readonly UploadTransactionRecord[];
  extraRefundLamports: string;
  refundedLamports: string;
  feesLamports: string;
  refundVerified: true;
  allOwnedAccountsClosed: true;
};
function context(value: unknown, floor: number) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < floor)
    throw Error("upload_finalized_context");
}
async function balance(rpc: ForkModelTransport, owner: Address, floor = 0) {
  const r = await rpc.rpc<{
    context: { slot: number | bigint };
    value: number | bigint;
  }>("getBalance", [owner, { commitment: "finalized", minContextSlot: floor }]);
  context(r.context?.slot, floor);
  return BigInt(r.value);
}
async function discover(
  rpc: ForkModelTransport,
  f: PublicModelFixture,
): Promise<PublicAccount[]> {
  const rows = await rpc.rpc<{ pubkey: string; account: RawAccount }[]>(
      "getProgramAccounts",
      [
        f.program,
        {
          encoding: "base64",
          commitment: "finalized",
          filters: [{ memcmp: { offset: 16, bytes: f.signer.address } }],
        },
      ],
    ),
    owner = Buffer.from(getAddressEncoder().encode(f.signer.address));
  return rows.map((row) => {
    if (
      row.account.owner !== f.program ||
      row.account.executable ||
      row.account.data[1] !== "base64"
    )
      throw Error("upload_recovery_account");
    const data = Buffer.from(row.account.data[0], "base64");
    if (!data.subarray(16, 48).equals(owner))
      throw Error("upload_recovery_owner");
    return {
      address: address(row.pubkey),
      owner: f.program,
      data,
      lamports: BigInt(row.account.lamports),
    };
  });
}
export async function verifyUploadedAccounts(
  rpc: Pick<ForkModelTransport, "rpc">,
  f: PublicModelFixture,
  minContextSlot = 0,
): Promise<void> {
  for (let at = 0; at < f.accounts.length; at += 64) {
    const expected = f.accounts.slice(at, at + 64),
      r = await rpc.rpc<{
        context: { slot: number | bigint };
        value: (RawAccount | null)[];
      }>("getMultipleAccounts", [
        expected.map((a) => a.address),
        { encoding: "base64", commitment: "finalized", minContextSlot },
      ]);
    context(r.context?.slot, minContextSlot);
    if (!Array.isArray(r.value) || r.value.length !== expected.length)
      throw Error("upload_account_count");
    for (let i = 0; i < expected.length; i++) {
      const actual = r.value[i],
        want = expected[i];
      if (
        !actual ||
        actual.owner !== f.program ||
        actual.executable ||
        actual.data[1] !== "base64" ||
        !Buffer.from(actual.data[0], "base64").equals(Buffer.from(want.data)) ||
        BigInt(actual.lamports) !== want.lamports
      )
        throw Error("upload_finalized_account_mismatch");
    }
  }
}
/** Child order from recoveryPlan is preserved; transaction grouping performs no
 * model work. Seven closes fit the independently tested 200k recovery profile. */
export function groupRecoveryInstructions(
  instructions: readonly Instruction[],
  payer: Address,
): Instruction[][] {
  const groups: Instruction[][] = [];
  let current: Instruction[] = [];
  for (const instruction of instructions) {
    if (![5, 6, 12, 13, 19, 20, 25].includes(instruction.data?.[0] ?? -1))
      throw Error("upload_recovery_instruction");
    const candidate = [...current, instruction];
    if (
      candidate.length > 7 ||
      instructionWireBytes(candidate, payer, 200000) > 1232
    ) {
      if (!current.length) throw Error("upload_recovery_wire_limit");
      groups.push(current);
      current = [instruction];
    } else current = candidate;
    if (instructionWireBytes(current, payer, 200000) > 1232)
      throw Error("upload_recovery_wire_limit");
  }
  if (current.length) groups.push(current);
  return groups;
}
export async function uploadModel(
  rpc: ForkModelTransport,
  state: string,
  progress: TestProgress,
  f: PublicModelFixture,
  t: TokenizerFixture,
  createJournal: ForkModelJournalFactory = (path, transport) =>
    new TransactionCoordinator(path, transport),
) {
  if (rpc.localOnly !== true || f.identity.modelOwner !== f.signer.address)
    throw Error("upload_fresh_model_authority_required");
  if (
    t.binding.model !==
      Buffer.from(getAddressEncoder().encode(f.client.model)).toString("hex") ||
    t.binding.modelBinding !== modelCommitment(f.binding) ||
    t.binding.sourceSha !== f.binding.sourceSha
  )
    throw Error("upload_tokenizer_model_binding");
  await rpc.beforeSigning();
  if ((await discover(rpc, f)).length)
    throw Error("upload_owner_accounts_already_exist");
  const combined = new Map(
    [...f.accounts, ...t.accounts].map((a) => [a.address, a]),
  );
  f.accounts.splice(0, f.accounts.length, ...combined.values());
  const rents = new Map<number, bigint>();
  for (const a of f.accounts) {
    if (!rents.has(a.data.length)) {
      const rent = BigInt(
        await rpc.rpc<number | bigint>("getMinimumBalanceForRentExemption", [
          a.data.length,
        ]),
      );
      if (rent < 0n || rent > 100000000n)
        throw Error("upload_account_rent_cap");
      rents.set(a.data.length, rent);
    }
    a.lamports = rents.get(a.data.length)!;
  }
  for (const a of t.accounts) a.lamports = rents.get(a.data.length)!;
  const rentAt = (key: Address) => {
    const a = combined.get(key);
    if (!a) throw Error("upload_expected_account");
    return rents.get(a.data.length)!;
  };
  const operations: UploadOperation[] = [];
  const add = (name: string, instruction: Instruction, rent = 0n) =>
    operations.push({ name, instruction, rent });
  await progress.run(
    "Preflight every upload transaction, account rent and bounded recovery reserve",
    async () => {
      operations.push(...(await modelUploadOperations(f, rentAt)));
      add(
        "tokenizer-create",
        t.client.createRegistry(),
        rentAt(t.client.registry),
      );
      for (const page of t.tables.pages) {
        const key = await t.client.page(page.index);
        add(
          `tokenizer-page-${page.index}-allocate`,
          await t.client.allocatePage(page),
          rentAt(key),
        );
        for (let offset = 0; offset < page.payload.length; offset += 700)
          add(
            `tokenizer-page-${page.index}-write-${offset}`,
            await t.client.writePage(
              page.index,
              offset,
              page.payload.subarray(offset, offset + 700),
            ),
          );
        add(
          `tokenizer-page-${page.index}-seal`,
          await t.client.sealPage(page.index),
        );
      }
      add("tokenizer-seal", t.client.sealRegistry());
    },
  );
  let maxWireBytes = 0;
  for (const operation of operations) {
    const size = instructionWireBytes(
      operation.instruction,
      f.signer.address,
      200000,
    );
    if (size > 1232) throw Error("upload_wire_limit");
    maxWireBytes = Math.max(maxWireBytes, size);
  }
  const rentTotal = f.accounts.reduce((n, a) => n + a.lamports, 0n),
    cleanupReserve = BigInt(f.accounts.length) * 10000n,
    feeAllowance = BigInt(operations.length) * 10000n,
    required = rentTotal + cleanupReserve + feeAllowance + 1000000n,
    funding = ((required + 999999999n) / 1000000000n) * 1000000000n;
  if (funding > MAX_FUNDING) throw Error("upload_local_funding_cap");
  progress.log(
    `Upload preflight: ${f.accounts.length} accounts, ${operations.length} transactions, ${rentTotal} rent lamports, ${feeAllowance} upload fee allowance, ${cleanupReserve} recovery fee reserve; ${funding} locally minted lamports requested. No genesis model/table accounts.`,
  );
  const estimatedSeconds = Math.ceil(
    operations.length * 0.55 + Math.ceil(operations.length / 64) * 14,
  );
  progress.log(
    `Upload duration planning estimate: about ${Math.ceil(estimatedSeconds / 60)} minutes using 0.55s confirmed progression plus 14s per 64-transaction finality checkpoint from earlier local measurements; excludes download, restart, inference and recovery and is not guaranteed.`,
  );
  const journalFor = async (index: number) => {
    const slice = operations.slice(index, index + JOURNAL_ENTRIES),
      journal = createJournal(
        join(
          state,
          `upload-${Math.floor(index / JOURNAL_ENTRIES)}`,
          "transactions.json",
        ),
        rpc,
      );
    await journal.initialize({
      feeAllowance: String(slice.length * 10000),
      rentAllowance: String(slice.reduce((n, o) => n + o.rent, 0n)),
      cleanupReserve: String(cleanupReserve),
      available: String(funding),
    });
    return journal;
  };
  let journal = await journalFor(0); // Protected durable storage is checked before funding.
  const sender = new UploadTransactionSender({
    rpc,
    signer: f.signer,
    progress,
  });
  let initialBalance = 0n,
    started = false,
    recovered = false;
  const closeAll = async (
    recoveryRpc: ForkModelTransport = rpc,
  ): Promise<UploadRecoverySummary> => {
    if (recovered) throw Error("upload_recovery_already_completed");
    if (recoveryRpc.localOnly !== true) throw Error("local_transport_required");
    if (sender.pendingCount) await sender.checkpoint();
    await recoveryRpc.beforeSigning();
    const accounts = await discover(recoveryRpc, f),
      instructions = await recoveryPlan(f.program, f.signer.address, accounts),
      groups = groupRecoveryInstructions(instructions, f.signer.address),
      refundable = accounts.reduce((n, a) => n + a.lamports, 0n),
      before = await balance(recoveryRpc, f.signer.address),
      recoverySender = new UploadTransactionSender({
        rpc: recoveryRpc,
        signer: f.signer,
        progress,
      });
    const store = createJournal(
      join(state, "recovery", "transactions.json"),
      recoveryRpc,
    );
    await store.initialize({
      feeAllowance: String(groups.length * 10000),
      rentAllowance: "0",
      cleanupReserve: "0",
      available: String(before),
    });
    for (let i = 0; i < groups.length; i++)
      await recoverySender.send(`recover-upload-${i}`, groups[i], store);
    await recoverySender.checkpoint();
    const after = await balance(
      recoveryRpc,
      f.signer.address,
      recoverySender.minContextSlot,
    );
    if (
      after - before !== refundable - recoverySender.totalFees ||
      (await discover(recoveryRpc, f)).length
    )
      throw Error("upload_refund_mismatch");
    const rentsByOperation = new Map(
      operations.map((operation) => [operation.name, operation.rent]),
    );
    const paidRent = sender.transactions.reduce(
      (sum, record) =>
        sum +
        (record.finalized && !record.failed
          ? (rentsByOperation.get(record.operation) ?? 0n)
          : 0n),
      0n,
    );
    const extraRefund = refundable - paidRent;
    if (
      started &&
      initialBalance - after !==
        sender.totalFees + recoverySender.totalFees - extraRefund
    )
      throw Error("upload_owner_balance_mismatch");
    recovered = true;
    return {
      closedAccounts: accounts.length,
      transactions: groups.length,
      maxWireBytes: Math.max(
        0,
        ...recoverySender.transactions.map((record) => record.wireBytes),
      ),
      maxComputeUnits: Math.max(
        0,
        ...recoverySender.transactions.map((record) => record.computeUnits),
      ),
      receipts: recoverySender.transactions,
      extraRefundLamports: String(extraRefund),
      refundedLamports: String(refundable),
      feesLamports: String(recoverySender.totalFees),
      refundVerified: true,
      allOwnedAccountsClosed: true,
    };
  };
  try {
    await rpc.beforeSigning();
    await progress.run(
      "Fund fresh uploader with locally minted SOL (90s finality timeout)",
      async () => {
        const signature = await rpc.rpc<string>("requestAirdrop", [
            f.signer.address,
            Number(funding),
          ]),
          deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          const status = await rpc.status(signature);
          if (status === "failed") throw Error("upload_local_funding_failed");
          if (status === "finalized") return;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw Error("upload_local_funding_timeout");
      },
    );
    initialBalance = await balance(rpc, f.signer.address);
    if (initialBalance < funding)
      throw Error("upload_local_funding_incomplete");
    started = true;
    for (let i = 0; i < operations.length; i++) {
      if (i > 0 && i % JOURNAL_ENTRIES === 0) journal = await journalFor(i);
      const operation = operations[i];
      await sender.send(operation.name, operation.instruction, journal, {
        rent: operation.rent,
      });
      if (i % 100 === 0)
        progress.log(
          `Uploaded transaction ${i + 1}/${operations.length}; current account payload bytes are public and omitted from progress`,
        );
    }
    await sender.checkpoint();
    await verifyUploadedAccounts(rpc, f, sender.minContextSlot);
    if (
      initialBalance -
        (await balance(rpc, f.signer.address, sender.minContextSlot)) !==
      rentTotal + sender.totalFees
    )
      throw Error("upload_deposit_balance_mismatch");
    const summary: UploadSummary = {
      modelPages: f.artifacts.pages.length,
      tokenizerPages: t.tables.pages.length,
      accountCount: f.accounts.length,
      payloadBytes:
        f.artifacts.pages.reduce((n, p) => n + p.payload.length, 0) +
        t.tables.pages.reduce((n, p) => n + p.payload.length, 0),
      uploadTransactions: sender.transactions.length,
      maxWireBytes,
      maxComputeUnits: Math.max(
        0,
        ...sender.transactions.map((record) => record.computeUnits),
      ),
      receipts: sender.transactions,
      rentDepositedLamports: String(rentTotal),
      feesLamports: String(sender.totalFees),
      fundedLamports: String(funding),
      modelUploadTested: true,
      allAccountsVerified: true,
    };
    return { summary, closeAll };
  } catch (error) {
    if (started && !recovered) {
      try {
        await sender.checkpoint();
        await closeAll();
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "upload_failed_recovery_incomplete",
        );
      }
    }
    throw error;
  }
}
/** Independent testing oracle only; production computation stays in SBF. */
export async function referenceChat(
  f: PublicModelFixture,
  messages: readonly PublicMessage[],
  outputs: number,
): Promise<{ promptTokens: number[]; outputTokens: number[] }> {
  const metadata = tokenizerMetadata(f.compiled.modelBytes),
    tokens = publicTokenizer(
      f.compiled.plan,
      metadata.vocabulary,
      metadata.chatTemplate,
    ).encodeMessages(messages, outputs).tokens,
    model = await loadPublicReference(
      f.compiled.modelBytes,
      "ggml-scalar-reference",
    );
  let next = 0;
  for (const token of tokens) next = model.step(token).token;
  const generated = [next];
  for (let i = 1; i < outputs; i++)
    generated.push(model.step(generated[i - 1]).token);
  return { promptTokens: tokens, outputTokens: generated };
}
