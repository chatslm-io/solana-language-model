/** Isolated devnet-only rehearsal. Never changes storage pins or runtime config. */
import {
  existsSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  constants,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { configuredPath } from "../lib/config/environment.mjs";
import {
  createTransactionMessage,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  signTransaction,
  getTransactionEncoder,
  getSignatureFromTransaction,
  type Instruction,
  type Base64EncodedWireTransaction,
  type TransactionMessageBytesBase64,
} from "@solana/kit";
import { operatorConfig } from "../lib/operator/config";
import { localSigner } from "../lib/operator/signer";
import { privateDirectory, privateRead } from "../lib/operator/external";
import { rpcClient } from "../lib/chain/client";
import { loaderTransaction } from "../lib/chain/loader";
import { reconcilePending } from "../lib/private-linear/devnet-pending";
import { parseStrict } from "../runtime/receipt";
import { acquireRuntimeLock } from "../runtime/lock";
import { rpcCall } from "../runtime/publisher";
import {
  quotePrivateLinearDeployment,
  runPrivateLinearDeployment,
  verifyPrivateLinearDeployment,
  preparePrivateLinearRetirement,
  verifyPrivateLinearRetirement,
  type PrivateLinearProgramJob,
} from "../lib/private-linear/devnet-deploy";
import { verifyFinalizedPrivateLinear } from "../lib/private-linear/devnet-proof";
import {
  createPrivateLinearKey,
  privateLinearInstruction,
  decryptOutput,
  WEIGHTS,
  BIAS,
} from "../lib/private-linear";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEPOSIT_CAP = 300_000_000n,
  INFERENCE_FEE_CAP = 10_000n,
  RETIREMENT_FEE_CAP = 10_000n,
  EXTRA_FEE_CAP = INFERENCE_FEE_CAP + RETIREMENT_FEE_CAP,
  TOTAL_FEE_CAP = 1_000_000n;
type Pending = {
  kind: "inference" | "retire";
  signature: string;
  wire: string;
  fee: string;
  lastValidBlockHeight: string;
  status: "signed" | "finalized" | "failed" | "expired";
  refund?: string;
};
type Journal = {
  version: 1;
  job: PrivateLinearProgramJob;
  inferenceFeesReserved: string;
  retirementFeesReserved: string;
  history: Pending[];
  pending?: Pending;
  inference?: { signature: string; slot: number; matched: boolean };
  retired?: {
    signature: string;
    refunded: string;
    retainedProgramDeposit: string;
  };
};
export function parseDevnetArguments(args: string[]) {
  const action = args[0] ?? "--quote";
  const readonly = action === "--quote" || action === "--prepare";
  if (!readonly && action !== "--execute" && action !== "--recover")
    throw Error("usage");
  if (
    readonly
      ? args.length > 1
      : args.length !== 3 ||
        args[1] !== "--approve-binary" ||
        !/^[a-f0-9]{64}$/.test(args[2])
  )
    throw Error("usage");
  return { action, approvedBinary: args[2] };
}
export function cappedDevnetConfig(source: ReturnType<typeof operatorConfig>) {
  const minimum = (a: bigint, b: bigint) => (a < b ? a : b);
  const totalFees = minimum(BigInt(source.maxFees), TOTAL_FEE_CAP);
  const totalTransactions = Math.min(source.maxTransactions, 100);
  if (totalFees <= EXTRA_FEE_CAP || totalTransactions <= 6)
    throw Error("operator_caps_too_small");
  return {
    config: {
      ...source,
      maxDeposit: String(minimum(BigInt(source.maxDeposit), DEPOSIT_CAP)),
      maxFees: String(totalFees - EXTRA_FEE_CAP),
      maxTransactions: totalTransactions - 6,
    },
    totalFees,
    totalTransactions,
  };
}
export function writeDevnetJournal(path: string, root: string, value: unknown) {
  const temporary = path + "." + randomBytes(16).toString("hex") + ".tmp";
  const fd = openSync(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeFileSync(fd, JSON.stringify(value) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function validateDevnetJournal(state: Journal, owner: string) {
  if (
    !state ||
    state.version !== 1 ||
    state.job?.owner !== owner ||
    state.job?.cluster !== "devnet" ||
    state.job?.purpose !== "private-linear-devnet-v1" ||
    !Array.isArray(state.history) ||
    state.history.length > 4 ||
    !/^(0|[1-9][0-9]*)$/.test(state.inferenceFeesReserved) ||
    !/^(0|[1-9][0-9]*)$/.test(state.retirementFeesReserved) ||
    BigInt(state.inferenceFeesReserved) > INFERENCE_FEE_CAP ||
    BigInt(state.retirementFeesReserved) > RETIREMENT_FEE_CAP
  )
    throw Error("journal_identity_mismatch");
}
async function main() {
  const { action, approvedBinary } = parseDevnetArguments(
    process.argv.slice(2),
  );
  const { config, totalFees, totalTransactions } = cappedDevnetConfig(
    operatorConfig("devnet"),
  );
  const signer = await localSigner();
  if (!signer) throw Error("missing_external_devnet_signer");
  const rpc = rpcClient(config.rpc),
    raw = rpcCall(config.rpc);
  if ((await raw<string>("getGenesisHash")) !== GENESIS)
    throw Error("wrong_network");
  const stateRoot = configuredPath("SLM_PRIVATE_LINEAR_STATE_DIR");
  const statePath = join(stateRoot, "rehearsal.json");
  let state: Journal | undefined;
  if (existsSync(statePath))
    state = parseStrict(
      privateRead(statePath, 4 * 1024 * 1024),
      4 * 1024 * 1024,
    ) as Journal;
  if (state) validateDevnetJournal(state, signer.address);
  if (!state && (action === "--execute" || action === "--recover"))
    throw Error("prepared_quote_required");
  const job =
    state?.job ?? (await quotePrivateLinearDeployment(config, rpc, signer));
  const balance = await raw<{ value: number }>("getBalance", [
    signer.address,
    { commitment: "finalized" },
  ]);
  const maximumFees =
    BigInt(job.feeBudget) + BigInt(job.recoveryFeeBudget) + EXTRA_FEE_CAP;
  if (
    BigInt(job.deposit) > BigInt(config.maxDeposit) ||
    maximumFees > totalFees ||
    job.transactionBudget > config.maxTransactions
  )
    throw Error("quote_exceeds_hard_caps");
  process.stdout.write(
    JSON.stringify(
      {
        cluster: "devnet",
        owner: signer.address,
        balanceLamports: String(balance.value),
        program: job.program,
        programData: job.programData,
        buffer: job.buffer,
        binarySha256: job.binaryHash,
        binaryBytes: job.binaryBytes,
        maximumDepositLamports: job.deposit,
        maximumTotalFeeLamports: String(maximumFees),
        refundableCodeRentLamports: job.codeRent,
        nonrefundableProgramDepositLamports: job.programRent,
        plannedDeploymentTransactions: job.totalTransactions,
        plan: "Deploy separate program, test one encrypted vector, retire program and return code rent to the same owner",
        journal: statePath,
      },
      null,
      2,
    ) + "\n",
  );
  if (action === "--quote") return;
  if (action !== "--prepare" && approvedBinary !== job.binaryHash)
    throw Error("approved_binary_mismatch");
  if (state?.retired || state?.job.phase === "recovered") {
    process.stdout.write(
      "Rehearsal already retired or recovered; no new transactions sent.\n",
    );
    return;
  }
  if (!state && BigInt(balance.value) < BigInt(job.deposit) + maximumFees)
    throw Error("insufficient_devnet_balance");
  const root = privateDirectory(stateRoot),
    release = acquireRuntimeLock(privateDirectory(join(root, "lock")));
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    // Reload after obtaining the cross-process lock, before any financial action.
    if (existsSync(statePath)) {
      state = parseStrict(
        privateRead(statePath, 4 * 1024 * 1024),
        4 * 1024 * 1024,
      ) as Journal;
      validateDevnetJournal(state, signer.address);
      if (state!.job.id !== job.id || state!.job.binaryHash !== job.binaryHash)
        throw Error("journal_changed_retry_quote");
      if (state.retired || state.job.phase === "recovered") return;
    }
    state ??= {
      version: 1,
      job,
      inferenceFeesReserved: "0",
      retirementFeesReserved: "0",
      history: [],
    };
    const current = state;
    const save = () => writeDevnetJournal(statePath, root, current);
    const archive = (p: Pending) => {
      current.history.push({ ...p });
      delete current.pending;
      save();
    };
    const wait = async (p: Pending) => {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (stopped) throw Error("stopped_preserve_journal");
        const disposition = await reconcilePending(raw, p);
        if (disposition !== "pending") {
          p.status = disposition;
          save();
          return disposition;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw Error("confirmation_uncertain_preserve_journal");
    };
    const inferenceMessage = (
      instructions: Instruction[],
      life: Parameters<typeof loaderTransaction>[2],
    ) =>
      compileTransaction(
        appendTransactionMessageInstructions(
          instructions,
          setTransactionMessageLifetimeUsingBlockhash(
            life,
            setTransactionMessageFeePayer(
              signer.address,
              setTransactionMessageConfig(
                {
                  computeUnitLimit: 200_000,
                  loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
                },
                createTransactionMessage({ version: 1 }),
              ),
            ),
          ),
        ),
      );
    // Read-only compatibility check before creating any paid deployment account.
    const preflightV1 = async () => {
      const key = createPrivateLinearKey();
      try {
        const request = key.encrypt([0, 0, 0, 0]);
        const life = (
          await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
        ).value;
        const tx = inferenceMessage(
          [
            privateLinearInstruction(
              current.job.program,
              signer.address,
              request,
            ),
          ],
          life,
        );
        const fee = (
          await rpc
            .getFeeForMessage(
              Buffer.from(tx.messageBytes).toString(
                "base64",
              ) as TransactionMessageBytesBase64,
              { commitment: "confirmed" },
            )
            .send()
        ).value;
        if (fee === null || fee < 1n || fee > INFERENCE_FEE_CAP)
          throw Error("v1_fee_preflight_unavailable");
      } finally {
        key.destroy();
      }
    };
    if (action === "--prepare") {
      await preflightV1();
      if (stopped) throw Error("stopped_preserve_journal");
      save();
      process.stdout.write(
        "Prepared protected quote. No transactions were signed or sent.\n",
      );
      return;
    }
    const submit = async (
      kind: Pending["kind"],
      instructions: Instruction[],
      refund?: bigint,
    ) => {
      if (stopped) throw Error("stopped_preserve_journal");
      if (current.pending)
        throw Error("pending_transaction_requires_reconciliation");
      if (
        current.history.length >= 4 ||
        current.job.journal.length + current.history.length >= totalTransactions
      )
        throw Error("transaction_cap");
      if ((await raw<string>("getGenesisHash")) !== GENESIS)
        throw Error("wrong_network");
      const life = (
        await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
      ).value;
      const unsigned =
        kind === "retire"
          ? loaderTransaction(signer.address, instructions, life).tx
          : inferenceMessage(instructions, life);
      const reservedKey =
        kind === "retire" ? "retirementFeesReserved" : "inferenceFeesReserved";
      const feeCap = kind === "retire" ? RETIREMENT_FEE_CAP : INFERENCE_FEE_CAP;
      const fee = (
        await rpc
          .getFeeForMessage(
            Buffer.from(unsigned.messageBytes).toString(
              "base64",
            ) as TransactionMessageBytesBase64,
            { commitment: "confirmed" },
          )
          .send()
      ).value;
      if (
        fee === null ||
        fee < 1n ||
        fee > 10_000n ||
        BigInt(current[reservedKey]) + fee > feeCap
      )
        throw Error("extra_fee_cap");
      const simulation = await rpc
        .simulateTransaction(
          Buffer.from(getTransactionEncoder().encode(unsigned)).toString(
            "base64",
          ) as Base64EncodedWireTransaction,
          { encoding: "base64", sigVerify: false, commitment: "confirmed" },
        )
        .send();
      if (simulation.value.err) throw Error("simulation_failed_no_broadcast");
      if (stopped) throw Error("stopped_preserve_journal");
      const signed = await signTransaction([signer.keyPair], unsigned);
      if (
        !Buffer.from(signed.messageBytes).equals(
          Buffer.from(unsigned.messageBytes),
        )
      )
        throw Error("signed_message_changed");
      const wire = Buffer.from(getTransactionEncoder().encode(signed)).toString(
          "base64",
        ),
        sig = getSignatureFromTransaction(signed);
      const pending: Pending = {
        kind,
        signature: sig,
        wire,
        fee: String(fee),
        lastValidBlockHeight: String(life.lastValidBlockHeight),
        status: "signed",
        ...(refund === undefined ? {} : { refund: String(refund) }),
      };
      current.pending = pending;
      current[reservedKey] = String(BigInt(current[reservedKey]) + fee);
      save();
      if (stopped) throw Error("stopped_preserve_journal");
      const returned = await raw<string>("sendTransaction", [
        wire,
        {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 0,
        },
      ]);
      if (returned !== sig) throw Error("signature_mismatch_preserve_journal");
      const disposition = await wait(pending);
      if (disposition !== "finalized") {
        archive(pending);
        throw Error("definitive_failure_use_recover");
      }
      return pending;
    };
    const context = {
      job: current.job,
      config,
      signer,
      rpc,
      save,
      stopped: () => stopped,
    };
    if (current.pending) {
      const pending = current.pending;
      const disposition = await wait(pending);
      if (disposition === "failed" || disposition === "expired") {
        archive(pending);
        if (action !== "--recover")
          throw Error("definitive_failure_use_recover");
      } else if (pending.kind === "retire") {
        const recovered = await verifyPrivateLinearRetirement(
          rpc,
          current.job,
          pending.signature,
          BigInt(pending.refund!),
        );
        current.retired = {
          signature: pending.signature,
          refunded: String(recovered.reclaimedLamports),
          retainedProgramDeposit: String(recovered.retainedProgramLamports),
        };
        archive(pending);
        process.stdout.write("Prior retirement reconciled.\n");
        return;
      }
      if (current.pending) {
        if (action !== "--recover")
          throw Error("ephemeral_decryption_key_lost_use_recover");
        archive(current.pending);
      }
    }
    if (action === "--recover" && current.job.phase !== "complete") {
      current.job.intent = "recover";
      current.job.approved = true;
      save();
      await runPrivateLinearDeployment(context);
      const recoveryPhase: string = current.job.phase;
      if (recoveryPhase === "recovered") {
        process.stdout.write(
          "Unfinished deployment buffer recovery completed.\n",
        );
        return;
      }
      if (recoveryPhase !== "complete")
        throw Error("deployment_incomplete_preserve_journal");
    }
    if (action === "--execute") {
      if (
        !current.inference &&
        current.history.some((p) => p.kind === "inference")
      )
        throw Error("definitive_failure_use_recover");
      await preflightV1();
      current.job.approved = true;
      save();
      await runPrivateLinearDeployment(context);
      if (current.job.phase !== "complete")
        throw Error("deployment_incomplete_preserve_journal");
      await verifyPrivateLinearDeployment(rpc, current.job);
      if (!current.inference) {
        const key = createPrivateLinearKey(),
          features = [12, -7, 3, 9];
        try {
          const request = key.encrypt(features);
          const sent = await submit("inference", [
            privateLinearInstruction(
              current.job.program,
              signer.address,
              request,
            ),
          ]);
          const evidence = await verifyFinalizedPrivateLinear(
            raw,
            sent.signature,
            {
              program: current.job.program,
              caller: signer.address,
              request,
              genesisHash: GENESIS,
              maxFeeLamports: 10_000n,
            },
          );
          const result = decryptOutput(key, evidence.output, {
            program: current.job.program,
            returnProgram: current.job.program,
            caller: signer.address,
            request,
          });
          const matched =
            result ===
            features.reduce((sum, x, i) => sum + x * WEIGHTS[i], BIAS);
          if (!matched) throw Error("encrypted_result_mismatch");
          current.inference = {
            signature: sent.signature,
            slot: evidence.slot,
            matched,
          };
          archive(sent);
          process.stdout.write(
            JSON.stringify({
              encryptedInferenceVerified: true,
              signature: sent.signature,
              slot: evidence.slot,
            }) + "\n",
          );
        } finally {
          key.destroy();
        }
      }
    }
    const retirement = await preparePrivateLinearRetirement(rpc, current.job);
    const retired = await submit(
      "retire",
      [retirement.instruction],
      retirement.refundableLamports,
    );
    const recovered = await verifyPrivateLinearRetirement(
      rpc,
      current.job,
      retired.signature,
      retirement.refundableLamports,
    );
    current.retired = {
      signature: retired.signature,
      refunded: String(recovered.reclaimedLamports),
      retainedProgramDeposit: String(recovered.retainedProgramLamports),
    };
    archive(retired);
    process.stdout.write(
      JSON.stringify({ retired: true, ...current.retired }) + "\n",
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    release();
  }
}
const SAFE_CODES = new Set([
  "usage",
  "prepared_quote_required",
  "approved_binary_mismatch",
  "operator_caps_too_small",
  "quote_exceeds_hard_caps",
  "insufficient_devnet_balance",
  "stopped_preserve_journal",
  "confirmation_uncertain_preserve_journal",
  "definitive_failure_use_recover",
  "ephemeral_decryption_key_lost_use_recover",
  "v1_fee_preflight_unavailable",
  "journal_identity_mismatch",
  "journal_changed_retry_quote",
  "extra_fee_cap",
  "transaction_cap",
  "simulation_failed_no_broadcast",
]);
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    const code = message.startsWith("External operator folder is not writable.")
      ? "external_state_not_writable_run_from_your_terminal"
      : SAFE_CODES.has(message)
        ? message
        : "provider_or_configuration_unavailable";
    process.stderr.write(`Devnet rehearsal stopped (${code}).\n`);
    process.stderr.write(
      "Devnet rehearsal stopped. No private/provider details logged. Preserve the external journal; use --quote to inspect and --recover --approve-binary <reviewed-sha256> to reconcile/reclaim. Usage: node --import tsx scripts/private-linear-devnet.ts --quote | --prepare | --execute --approve-binary <sha256> | --recover --approve-binary <sha256>. External state must be writable from your terminal.\n",
    );
    process.exitCode = 1;
  });
