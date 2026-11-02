/** Shared on-chain execution; callers supply an owned local node or explicit mainnet transport. */
import {
  ConfirmationWindow,
  rpcSlot,
  type ConfirmationOptions,
  type SignatureObservation,
} from "./confirmation";
import { join } from "node:path";
import {
  address,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  compileTransaction,
  signTransaction,
  getTransactionEncoder,
  getSignatureFromTransaction,
  type Address,
  type Instruction,
  type Blockhash,
} from "@solana/kit";
import {
  TransactionCoordinator,
  SubmissionJournal,
} from "../../private-inference/coordinator/transactions";
import { MainnetInferenceRpc } from "../client/mainnet-rpc";
import type { OwnedLocalRpc } from "./transport";
import { createProgress, type TestProgress } from "./progress";
import type { PublicModelFixture } from "./model-fixture";
import { modelCommitment, BATCH } from "../protocol";
import { nextBatch, planBatches } from "../compiler/batches";
import { u32 } from "./client";
import {
  executionInstruction,
  isExecutionTag,
  isExecutionEnvelope,
} from "../execution-mode";
import {
  encodeRawMessages,
  type RawChatMessage,
} from "../client/tokenizer-frame";
import type { TokenizerFixture } from "./tokenizer-fixture";
export type ForkModelScenario =
  | { prompt: readonly number[]; outputs: number }
  | {
      messages: readonly RawChatMessage[];
      outputs: number;
      tokenizer: TokenizerFixture;
      tokenizeOnly?: boolean;
    };
export type ForkModelTransport = Pick<
  OwnedLocalRpc,
  "rpc" | "beforeSigning" | "status" | "sendExact" | "localOnly"
>;
export type ForkModelJournalFactory = (
  path: string,
  rpc: ForkModelTransport,
) => TransactionCoordinator;
type InstructionSet = Instruction | readonly Instruction[];
function instructionList(value: InstructionSet): readonly Instruction[] {
  const instructions: readonly Instruction[] = Array.isArray(value)
    ? [...value]
    : [value as Instruction];
  if (instructions.length < 1 || instructions.length > 7)
    throw Error("public_instruction_count");
  return instructions.map((ix) => {
    const data = Buffer.from(ix.data ?? []);
    return isExecutionTag(data[0]) && !isExecutionEnvelope(data)
      ? executionInstruction(ix, 0)
      : ix;
  });
}
/** Discovery runs against finalized, owner-checked accounts in the caller.
 * Canonical order preserves state counters and closes the session last. */
export async function discoverCleanupInstructions(
  client: Pick<
    PublicModelFixture["client"],
    "states" | "session" | "closeState" | "closeSession"
  >,
  account: (address: Address) => Promise<{ lamports: bigint } | null>,
  text?: Pick<TokenizerFixture["client"], "scratch" | "closeText">,
) {
  const instructions: Instruction[] = [];
  let expectedRefund = 0n;
  for (let index = 0; index < 5; index++) {
    const found = await account(client.states[index]);
    if (found) {
      expectedRefund += found.lamports;
      instructions.push(client.closeState(index));
    }
  }
  if (text) {
    const found = await account(text.scratch);
    if (found) {
      expectedRefund += found.lamports;
      instructions.push(text.closeText());
    }
  }
  const session = await account(client.session);
  if (session) {
    expectedRefund += session.lamports;
    instructions.push(client.closeSession());
  }
  return { instructions, expectedRefund };
}
/** Exact unsigned serialization size: public accounts/data only, before signing. */
export function instructionWireBytes(
  ix: InstructionSet,
  payer: Address,
  computeUnitLimit: number,
): number {
  const base = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: "11111111111111111111111111111111" as Blockhash,
      lastValidBlockHeight: 0n,
    },
    setTransactionMessageFeePayer(
      payer,
      createTransactionMessage({ version: 0 }),
    ),
  );
  const budgetIx: Instruction = {
    programAddress: address("ComputeBudget111111111111111111111111111111"),
    data: Buffer.concat([Buffer.from([2]), u32(computeUnitLimit)]),
  };
  return getTransactionEncoder().encode(
    compileTransaction(
      appendTransactionMessageInstructions(
        instructionList(ix),
        appendTransactionMessageInstruction(budgetIx, base),
      ),
    ),
  ).length;
}
export async function runModel(
  rpc: ForkModelTransport | MainnetInferenceRpc,
  state: string,
  progress: TestProgress = createProgress("local public model"),
  fixture: PublicModelFixture,
  scenario: ForkModelScenario = {
    prompt: [1],
    outputs: 1,
  },
  createJournal: (
    path: string,
    transport: ForkModelTransport | MainnetInferenceRpc,
  ) => SubmissionJournal = (path, transport) =>
    transport instanceof MainnetInferenceRpc
      ? new SubmissionJournal(path, transport)
      : new TransactionCoordinator(path, transport),
  options: ConfirmationOptions & {
    mainnetBudgetLamports?: bigint;
    batched?: boolean;
    modelAccountSource?: "uploaded" | "genesis";
  } = {},
) {
  const pending = new ConfirmationWindow(rpc, options);
  const batched = options.batched ?? true;
  let readCommitment: "confirmed" | "finalized" = "finalized";
  const text = "messages" in scenario ? scenario : undefined;
  const prompt = "prompt" in scenario ? scenario.prompt : undefined;
  const frame = text ? encodeRawMessages(text.messages) : undefined;
  if (
    (!(rpc instanceof MainnetInferenceRpc) && rpc.localOnly !== true) ||
    !Number.isInteger(scenario.outputs) ||
    scenario.outputs < 1 ||
    scenario.outputs > 15 ||
    (!text &&
      (!Array.isArray(prompt) ||
        prompt.length < 1 ||
        prompt.length + scenario.outputs > 16 ||
        Array.from(prompt).some(
          (t) => !Number.isInteger(t) || t < 0 || t >= 8196,
        )))
  )
    throw Error("public_local_scenario");
  await rpc.beforeSigning();
  const { signer, client, compiled, program } = fixture,
    started = performance.now();
  const rawBytes = frame ? frame.length - 4 - text!.messages.length * 8 : 0;
  // Pair lookups <= n(n-1)/2 as every merge reduces symbol count. Four
  // linear passes cover merge/piece/emit overhead; classification is 32-byte
  // chunks, plus bounded message transitions and finalization.
  const maxTokenizerSteps = text
    ? (rawBytes * (rawBytes - 1)) / 2 +
      4 * rawBytes +
      Math.ceil(rawBytes / 32) +
      8 * text.messages.length +
      32
    : 0;
  if (maxTokenizerSteps > 133000)
    throw Error("public_tokenizer_global_step_bound");
  let forwards = text
    ? text.tokenizeOnly
      ? 0
      : 15
    : prompt!.length + scenario.outputs - 1;
  const plannedPerForward = batched
    ? planBatches(compiled.commands).length
    : compiled.commands.length;
  const setupTransactions = text ? (text.tokenizeOnly ? 3 : 9) : 7,
    cleanupTransactions = 1,
    maximumCleanupTransactions = text ? (text.tokenizeOnly ? 2 : 7) : 6;
  const expectedTransactions =
    setupTransactions +
    maxTokenizerSteps +
    forwards * plannedPerForward +
    cleanupTransactions;
  const maximumTransactions =
    setupTransactions +
    maxTokenizerSteps +
    forwards * compiled.commands.length +
    maximumCleanupTransactions;
  progress.log(
    `Inference phase using ${options.modelAccountSource === "uploaded" ? "transaction-uploaded model/tokenizer accounts" : "genesis model/tokenizer fixtures"}: ${compiled.commands.length} model commands/token (${plannedPerForward} planned transactions, batch size ${batched ? 8 : 1}); ${text ? "upper bound " : ""}${forwards} forwards, ${maxTokenizerSteps} tokenizer steps, ${expectedTransactions} total transactions; ${pending.mode} advancement with finalized checkpoints every ${pending.limit} transactions and before output/refund. Strict-finalized baseline ${Math.ceil((expectedTransactions * 14) / 60)} minutes at 14s/transaction (estimate, not measured confirmed throughput). Model/table upload and its rent are accounted separately from this inference phase.`,
  );
  const account = async (a: Address) => {
    type AccountResult = {
      context: { slot: number | bigint };
      value: {
        owner: string;
        data: [string, string];
        lamports: number | bigint;
      } | null;
    };
    const started = Date.now(),
      deadline = started + pending.timeout;
    let nextReport = started;
    let r: AccountResult;
    for (;;) {
      let response: AccountResult | undefined;
      try {
        response = await rpc.rpc<AccountResult>("getAccountInfo", [
          a,
          {
            encoding: "base64",
            commitment: readCommitment,
            minContextSlot: pending.minContextSlot,
          },
        ]);
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      if (response) {
        if (!response.context) throw Error("public_invalid_account_context");
        if (rpcSlot(response.context.slot) >= BigInt(pending.minContextSlot)) {
          r = response;
          break;
        }
      }
      if (Date.now() >= deadline) throw Error("public_account_context_timeout");
      if (Date.now() >= nextReport) {
        progress.log(
          `Waiting for ${readCommitment} account context >= ${pending.minContextSlot}; elapsed ${Math.floor((Date.now() - started) / 1000)}s / timeout ${pending.timeout / 1000}s`,
        );
        nextReport = Date.now() + 5000;
      }
      await new Promise((resolve) => setTimeout(resolve, pending.poll));
    }
    if (r.value && (r.value.owner !== program || r.value.data[1] !== "base64"))
      throw Error("public_account_owner");
    return r.value
      ? {
          data: Buffer.from(r.value.data[0], "base64"),
          lamports: BigInt(r.value.lamports),
        }
      : null;
  };
  const read = async (a: Address) => {
    const v = await account(a);
    if (!v) throw Error("public_account_missing");
    return v.data;
  };
  const model = await read(client.model);
  if (
    model.subarray(80, 112).toString("hex") !==
      modelCommitment(fixture.binding) ||
    model[10] !== 1 ||
    !model.equals(
      Buffer.from(
        fixture.accounts.find((a) => a.address === client.model)!.data,
      ),
    )
  )
    throw Error("public_model_binding");
  if (text) {
    const actual = await read(text.tokenizer.client.registry),
      expected = text.tokenizer.accounts.find(
        (a) => a.address === text.tokenizer.client.registry,
      );
    if (!expected || !actual.equals(Buffer.from(expected.data)))
      throw Error("public_tokenizer_binding");
  }
  const balance = async () => {
    const started = Date.now(),
      deadline = started + pending.timeout;
    let nextReport = started;
    for (;;) {
      let r:
        | { context: { slot: number | bigint }; value: number | bigint }
        | undefined;
      try {
        r = await rpc.rpc("getBalance", [
          signer.address,
          { commitment: "finalized", minContextSlot: pending.minContextSlot },
        ]);
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      if (r) {
        if (!r.context) throw Error("public_invalid_balance_context");
        if (rpcSlot(r.context.slot) >= BigInt(pending.minContextSlot))
          return BigInt(r.value);
      }
      if (Date.now() >= deadline) throw Error("public_balance_context_timeout");
      if (Date.now() >= nextReport) {
        progress.log(
          `Waiting for finalized balance context >= ${pending.minContextSlot}; elapsed ${Math.floor((Date.now() - started) / 1000)}s / timeout ${pending.timeout / 1000}s`,
        );
        nextReport = Date.now() + 5000;
      }
      await new Promise((resolve) => setTimeout(resolve, pending.poll));
    }
  };
  const rent = async (size: number) =>
    BigInt(
      await rpc.rpc<number | bigint>("getMinimumBalanceForRentExemption", [
        size,
      ]),
    );
  const deposits = await Promise.all(
      [384, 192 + 8192, ...Array(4).fill(192 + 3072)].map(rent),
    ),
    textDeposit = text ? await rent(4260) : 0n,
    rentTotal =
      (text?.tokenizeOnly
        ? deposits[0]
        : deposits.reduce((a, b) => a + b, 0n)) + textDeposit;
  const mainnet = rpc instanceof MainnetInferenceRpc;
  const available = mainnet ? options.mainnetBudgetLamports : 2000000000n;
  if (typeof available !== "bigint" || available <= 0n)
    throw Error("inference_budget_required");
  if (BigInt(maximumTransactions) * 10000n + rentTotal + 100000n > available)
    throw Error("public_total_budget_exceeds_allowance");
  const budget = (tx: number, rentAllowance = 0n) => ({
    feeAllowance: String(tx * 10000),
    rentAllowance: String(rentAllowance),
    cleanupReserve: "100000",
    available: String(available),
  });
  // Journal path checks and reservation budgets must precede local funding.
  const setup = createJournal(join(state, "setup", "transactions.json"), rpc);
  await setup.initialize(budget(setupTransactions, rentTotal));
  const cleanupJournal = createJournal(
    join(state, "cleanup", "transactions.json"),
    rpc,
  );
  await cleanupJournal.initialize({
    ...budget(maximumCleanupTransactions),
    cleanupReserve: "0",
  });
  const wait = async (signature: string) => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const status = await rpc.status(signature);
      if (status === "failed") throw Error("public_transaction_failed");
      if (status === "finalized") return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw Error("public_finality_timeout");
  };
  await rpc.beforeSigning();
  if (!mainnet)
    await progress.run(
      "Fund fresh local wallet (90s finality timeout)",
      async () =>
        wait(
          await rpc.rpc<string>("requestAirdrop", [signer.address, 2000000000]),
        ),
    );
  const initialBalance = await balance();
  if (initialBalance < available) throw Error("public_funding_incomplete");
  const transactions: {
    operation: string;
    signature: string;
    fee: number;
    computeUnits: number;
    wireBytes: number;
  }[] = [];
  let totalFees = 0n,
    refundedLamports = 0n,
    cleanupAttempted = false;

  // A pruned authoritative receipt cannot become available by polling this
  // local ledger. Preserve the pending journal and fail subsequent barriers fast.
  const prunedReceipts = new Set<string>();
  type Receipt = { fee: number; computeUnits: number; failed: boolean };
  const receipt = async (
    signature: string,
    commitment: "confirmed" | "finalized",
    observation: SignatureObservation,
    computeUnitLimit: number,
  ): Promise<Receipt> => {
    if (prunedReceipts.has(signature))
      throw Error("public_execution_receipt_pruned");
    type Detail = {
      slot: number | bigint;
      meta: {
        err: unknown;
        fee: number | bigint;
        computeUnitsConsumed: number | bigint;
      };
    };
    const started = Date.now(),
      deadline = started + pending.timeout;
    let nextReport = started;
    let detail: Detail | null;
    for (;;) {
      detail = await rpc.rpc<Detail | null>("getTransaction", [
        signature,
        { encoding: "json", commitment, maxSupportedTransactionVersion: 0 },
      ]);
      if (detail !== null) break;
      const firstAvailable = rpcSlot(
        await rpc.rpc<number | bigint>("getFirstAvailableBlock", []),
      );
      if (firstAvailable > observation.slot) {
        prunedReceipts.add(signature);
        progress.log(
          `${commitment} transaction metadata is pruned: observed slot ${observation.slot}, first available block ${firstAvailable}; preserving pending journal and stopping cleanup.`,
        );
        throw Error("public_execution_receipt_pruned");
      }
      if (Date.now() >= deadline)
        throw Error("public_execution_receipt_timeout");
      if (Date.now() >= nextReport) {
        progress.log(
          `Waiting for ${commitment} transaction metadata; elapsed ${Math.floor((Date.now() - started) / 1000)}s / timeout ${pending.timeout / 1000}s`,
        );
        nextReport = Date.now() + 5000;
      }
      await new Promise((resolve) => setTimeout(resolve, pending.poll));
    }
    if (
      !detail?.meta ||
      rpcSlot(detail.slot) !== observation.slot ||
      !Object.hasOwn(detail.meta, "err")
    )
      throw Error("public_execution_receipt");
    const fee = Number(detail.meta.fee),
      computeUnits = Number(detail.meta.computeUnitsConsumed),
      failed = detail.meta.err !== null;
    if (
      !Number.isSafeInteger(fee) ||
      fee < 0 ||
      fee > 10000 ||
      !Number.isSafeInteger(computeUnits) ||
      computeUnits < 0 ||
      computeUnits > computeUnitLimit ||
      failed !== observation.failed
    )
      throw Error("public_execution_receipt");
    return { fee, computeUnits, failed };
  };
  const checkpoint = async () => {
    if (prunedReceipts.size) throw Error("public_execution_receipt_pruned");
    if (pending.count)
      await progress.run(
        `Finalized checkpoint for ${pending.count} provisional transactions (${pending.timeout / 1000}s timeout)`,
        () => pending.checkpoint(),
      );
  };
  const send = async (
    operation: string,
    ix: InstructionSet,
    journal: SubmissionJournal,
    deposit = 0n,
    forceFinalized = false,
    computeUnitLimit: number = BATCH.baselineComputeUnitLimit,
  ) => {
    const instructions = instructionList(ix);
    if (
      computeUnitLimit !== BATCH.baselineComputeUnitLimit &&
      !(
        computeUnitLimit === BATCH.computeUnitLimit &&
        instructions.length === 1 &&
        instructions[0].data?.[0] === BATCH.tag
      )
    )
      throw Error("public_compute_budget_profile");
    await rpc.beforeSigning();
    const lifetime = (
      await rpc.rpc<{
        value: { blockhash: Blockhash; lastValidBlockHeight: number | bigint };
      }>("getLatestBlockhash", [{ commitment: pending.mode }])
    ).value;
    const base = setTransactionMessageLifetimeUsingBlockhash(
        {
          ...lifetime,
          lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          signer.address,
          createTransactionMessage({ version: 0 }),
        ),
      ),
      budgetIx: Instruction = {
        programAddress: address("ComputeBudget111111111111111111111111111111"),
        data: Buffer.concat([Buffer.from([2]), u32(computeUnitLimit)]),
      };
    const signed = await signTransaction(
        [signer.keyPair],
        compileTransaction(
          appendTransactionMessageInstructions(
            instructions,
            appendTransactionMessageInstruction(budgetIx, base),
          ),
        ),
      ),
      wire = getTransactionEncoder().encode(signed),
      signature = getSignatureFromTransaction(signed);
    if (wire.length > 1232) throw Error("public_wire_limit");
    let provisional: Receipt | undefined,
      record: (typeof transactions)[number] | undefined;
    const recordReceipt = (r: Receipt) => {
      totalFees += BigInt(r.fee);
      record = {
        operation,
        signature,
        fee: r.fee,
        computeUnits: r.computeUnits,
        wireBytes: wire.length,
      };
      transactions.push(record);
    };
    pending.track(signature, async (observation) => {
      const final = await receipt(
        signature,
        "finalized",
        observation,
        computeUnitLimit,
      );
      if (
        provisional &&
        (final.fee !== provisional.fee ||
          final.computeUnits !== provisional.computeUnits ||
          final.failed !== provisional.failed)
      )
        throw Error("public_finalized_receipt_changed");
      const state = await journal.reconcile(operation);
      if (state !== (observation.failed ? "failed" : "finalized"))
        throw Error("public_finalized_journal_unsettled");
      if (!record) recordReceipt(final);
    });
    await progress.run(
      `${operation}: reserve, submit, ${forceFinalized ? "finalize" : pending.mode} (${pending.timeout / 1000}s timeout)`,
      async () => {
        await journal.submit({
          operation,
          signature,
          wireBase64: Buffer.from(wire).toString("base64"),
          fee: "10000",
          rent: String(deposit),
        });
        const observation = await pending.confirm(signature);
        provisional = await receipt(
          signature,
          observation.finalized ? "finalized" : "confirmed",
          observation,
          computeUnitLimit,
        );
        recordReceipt(provisional);
        if (
          forceFinalized ||
          pending.mode === "finalized" ||
          pending.count === pending.limit
        )
          await checkpoint();
      },
    );
    readCommitment = forceFinalized ? "finalized" : pending.mode;
  };
  const cleanup = async () => {
    cleanupAttempted = true;
    await checkpoint();
    readCommitment = "finalized";
    const before = await balance(),
      priorFees = totalFees;
    const { instructions, expectedRefund } = await discoverCleanupInstructions(
      client,
      account,
      text?.tokenizer.client,
    );
    if (instructions.length) {
      if (
        instructionWireBytes(
          instructions,
          signer.address,
          BATCH.baselineComputeUnitLimit,
        ) <= 1232
      ) {
        await send("close-accounts", instructions, cleanupJournal, 0n, true);
      } else {
        // Preserve individual recovery if a future account layout exceeds wire
        // limits. Never retry an ambiguous signed grouped transaction.
        for (let index = 0; index < instructions.length; index++)
          await send(
            `close-account-${index}`,
            instructions[index],
            cleanupJournal,
            0n,
            true,
          );
      }
    }
    if ((await balance()) - before !== expectedRefund - (totalFees - priorFees))
      throw Error("public_refund_mismatch");
    for (const a of [
      ...client.states,
      client.session,
      ...(text ? [text.tokenizer.client.scratch] : []),
    ])
      if (await account(a)) throw Error("public_recovery_accounts_remain");
    refundedLamports = expectedRefund;
  };
  let inferenceTransactions = 0,
    commandsExecuted = 0,
    forwardsExecuted = 0,
    modelExecutionElapsedMs = 0;
  let outputs: number[] = [];
  try {
    const slot = Number(
      await rpc.rpc<number | bigint>("getSlot", [{ commitment: "finalized" }]),
    );
    const expiry = BigInt(slot + Math.max(10000, maximumTransactions * 200));
    let onchainPrompt: number[] = [];
    if (text) {
      const tc = text.tokenizer.client;
      await send(
        "create-text",
        tc.createText(frame!, scenario.outputs, expiry),
        setup,
        deposits[0] + textDeposit,
      );
      await send("write-raw", tc.writeRaw(0, frame!), setup);
      await send("seal-raw", tc.sealRaw(), setup);
      let journal: TransactionCoordinator | undefined;
      for (let step = 0; step < maxTokenizerSteps; step++) {
        const scratch = await read(tc.scratch);
        if (scratch[10] === 2) break;
        if (step % 2048 === 0) {
          journal = createJournal(
            join(
              state,
              `tokenizer-${Math.floor(step / 2048)}`,
              "transactions.json",
            ),
            rpc,
          );
          await journal.initialize(
            budget(Math.min(2048, maxTokenizerSteps - step)),
          );
        }
        await send(`tokenizer-step-${step}`, await tc.step(scratch), journal!);
      }
      if ((await read(tc.scratch))[10] !== 2)
        throw Error("public_tokenizer_proven_step_bound");
      await checkpoint();
      readCommitment = "finalized";
      const session = await read(client.session),
        count = session.readUInt32LE(244);
      if (count < 1 || count + scenario.outputs > 16)
        throw Error("public_onchain_prompt_bound");
      onchainPrompt = Array.from({ length: count }, (_, i) =>
        session.readUInt32LE(256 + i * 4),
      );
      forwards = text.tokenizeOnly ? 0 : count + scenario.outputs - 1;
      progress.log(
        `SBF tokenization completed: ${count} prompt tokens; ${forwards} model forwards (${forwards * plannedPerForward} planned model transactions) remaining; raw content and token IDs omitted.`,
      );
      if (text.tokenizeOnly) {
        await cleanup();
        if (initialBalance - (await balance()) !== totalFees)
          throw Error("public_final_balance_mismatch");
        return {
          outputs: [],
          onchainPrompt,
          transactions,
          totalFees: Number(totalFees),
          refundedLamports: refundedLamports.toString(),
          refundVerified: true,
          elapsedMs: Math.round(performance.now() - started),
          modelUploadTested: false,
          inferenceExecuted: false,
          confirmationMode: pending.mode,
          pendingWindowLimit: pending.limit,
          finalizedBeforeReturn: true,
        };
      }
    } else
      await send(
        "create-session",
        client.createSession(prompt!, scenario.outputs, expiry),
        setup,
        deposits[0],
      );
    for (let index = 0; index < 5; index++)
      await send(
        `allocate-state-${index}`,
        client.allocateState(index),
        setup,
        deposits[index + 1],
      );
    await send("start", client.start(), setup);
    const modelExecutionStarted = performance.now();
    for (let token = 0; token < forwards; token++) {
      const journal = createJournal(
        join(state, `token-${token}`, "transactions.json"),
        rpc,
      );
      await journal.initialize(budget(compiled.commands.length));
      for (let pc = 0; pc < compiled.commands.length;) {
        const session = await read(client.session),
          global = await read(client.states[0]);
        if (session.readUInt32LE(176) !== pc)
          throw Error("public_cursor_mismatch");
        let count = batched ? nextBatch(compiled.commands, pc).count : 1;
        let ix: Instruction;
        for (;;) {
          ix = batched
            ? await client.batch(
                session,
                global,
                compiled.commands.slice(pc, pc + count),
                compiled.weights.pages.length,
              )
            : await client.step(
                session,
                global,
                compiled.commands[pc],
                compiled.weights.pages.length,
              );
          if (
            instructionWireBytes(
              ix,
              signer.address,
              batched ? BATCH.computeUnitLimit : BATCH.baselineComputeUnitLimit,
            ) <= 1232
          )
            break;
          if (count === 1) throw Error("public_wire_limit");
          count--;
        }
        await send(
          `token-${token}-${batched ? "batch" : "step"}-${pc}`,
          ix,
          journal,
          0n,
          false,
          batched ? BATCH.computeUnitLimit : BATCH.baselineComputeUnitLimit,
        );
        pc += count;
        commandsExecuted += count;
        inferenceTransactions++;
      }
      forwardsExecuted++;
      const session = await read(client.session);
      progress.log(
        `Completed onchain forward ${token + 1}/${forwards}; ${transactions.length} ${pending.mode}-observed transactions (finalized checkpoints retained)`,
      );
      if (session[10] === 3) break;
    }
    await checkpoint();
    modelExecutionElapsedMs = performance.now() - modelExecutionStarted;
    readCommitment = "finalized";
    const session = await read(client.session);
    if (session[10] !== 3) throw Error("public_session_incomplete");
    const count = session.readUInt32LE(248);
    if (count > scenario.outputs) throw Error("public_output_bound");
    outputs = Array.from({ length: count }, (_, i) =>
      session.readUInt32LE(320 + i * 4),
    );
    await cleanup();
    if (initialBalance - (await balance()) !== totalFees)
      throw Error("public_final_balance_mismatch");
    return {
      outputs,
      benchmark: {
        sourceSha: compiled.plan.source.sha256,
        confirmationMode: pending.mode,
        modelUploadTested: false,
        elapsedMs: Math.round(performance.now() - started),
        inputMode: text ? "raw-text" : "token-ids",
        forwardsExecuted,
        commandsExecuted,
        inferenceTransactions,
        totalTransactions: transactions.length,
        batchSizeLimit: batched ? 8 : 1,
        computeBudgets: {
          ordinary: BATCH.baselineComputeUnitLimit,
          model: batched
            ? BATCH.computeUnitLimit
            : BATCH.baselineComputeUnitLimit,
        },
        maxComputeUnits: Math.max(
          0,
          ...transactions.map((t) => t.computeUnits),
        ),
        maxWireBytes: Math.max(0, ...transactions.map((t) => t.wireBytes)),
        modelExecutionElapsedMs: Math.round(modelExecutionElapsedMs),
        timingScope:
          "runner-wall-clock-including-finalized-result-barrier; transport provenance must be reported separately",
      },
      onchainPrompt,
      inferenceExecuted: true,
      confirmationMode: pending.mode,
      pendingWindowLimit: pending.limit,
      finalizedBeforeReturn: true,
      transactions,
      totalFees: Number(totalFees),
      refundedLamports: refundedLamports.toString(),
      refundVerified: true,
      elapsedMs: Math.round(performance.now() - started),
      modelUploadTested: false,
    };
  } finally {
    if (!cleanupAttempted) await cleanup();
  }
}

export async function runForkModel(
  rpc: ForkModelTransport,
  state: string,
  progress: TestProgress | undefined,
  fixture: PublicModelFixture,
  scenario?: ForkModelScenario,
  createJournal?: ForkModelJournalFactory,
  options?: Parameters<typeof runModel>[6],
) {
  if (rpc.localOnly !== true) throw Error("local_transport_required");
  return runModel(
    rpc,
    state,
    progress,
    fixture,
    scenario,
    createJournal ? (path) => createJournal(path, rpc) : undefined,
    options,
  );
}
