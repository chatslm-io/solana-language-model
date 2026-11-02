/** Exact-wire model storage transactions. No signer material is persisted. */
import {
  address,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  signTransaction,
  getTransactionEncoder,
  getSignatureFromTransaction,
  type Instruction,
  type Blockhash,
} from "@solana/kit";
import { SubmissionJournal } from "../../private-inference/coordinator/transactions";
import {
  ConfirmationWindow,
  rpcSlot,
  type ConfirmationOptions,
  type SignatureObservation,
} from "./confirmation";
import { MainnetInferenceRpc } from "../client/mainnet-rpc";
import type { ForkModelTransport } from "./fork-model";
import type { PublicModelFixture } from "./model-fixture";
import type { TestProgress } from "./progress";

export type UploadTransactionRecord = {
  operation: string;
  signature: string;
  fee: number;
  computeUnits: number;
  wireBytes: number;
  failed: boolean;
  finalized: boolean;
};
export type UploadSendOptions = { rent?: bigint; finalize?: boolean };
export type UploadTransactionSenderOptions = {
  rpc: ForkModelTransport | MainnetInferenceRpc;
  signer: PublicModelFixture["signer"];
  progress: TestProgress;
  confirmation?: ConfirmationOptions;
};
type Receipt = { fee: number; computeUnits: number; failed: boolean };
const budgetProgram = address("ComputeBudget111111111111111111111111111111");

export class UploadTransactionSender {
  private readonly pending: ConfirmationWindow;
  private readonly records: UploadTransactionRecord[] = [];
  private readonly operations = new Set<string>();
  private readonly pruned = new Set<string>();
  private fees = 0n;
  private busy = false;
  private halted = false;
  constructor(private readonly options: UploadTransactionSenderOptions) {
    if (
      options.rpc.localOnly !== true &&
      !(options.rpc instanceof MainnetInferenceRpc)
    )
      throw Error("local_transport_required");
    this.pending = new ConfirmationWindow(options.rpc, options.confirmation);
  }
  /** Fees include authoritative finalized failures as well as successes. */
  get totalFees() {
    return this.fees;
  }
  get transactions(): readonly UploadTransactionRecord[] {
    return this.records.map((r) => ({ ...r }));
  }
  get pendingCount() {
    return this.pending.count;
  }
  get minContextSlot() {
    return this.pending.minContextSlot;
  }

  private async receipt(
    signature: string,
    observation: SignatureObservation,
  ): Promise<Receipt> {
    if (this.pruned.has(signature))
      throw Error("public_execution_receipt_pruned");
    const commitment = observation.finalized ? "finalized" : "confirmed";
    type Detail = {
      slot: number | bigint;
      meta: {
        err: unknown;
        fee: number | bigint;
        computeUnitsConsumed: number | bigint;
      };
    };
    const deadline = Date.now() + this.pending.timeout;
    let detail: Detail | null;
    for (;;) {
      detail = await this.options.rpc.rpc<Detail | null>("getTransaction", [
        signature,
        { encoding: "json", commitment, maxSupportedTransactionVersion: 0 },
      ]);
      if (detail !== null) break;
      const floor = rpcSlot(
        await this.options.rpc.rpc<number | bigint>(
          "getFirstAvailableBlock",
          [],
        ),
      );
      if (floor > observation.slot) {
        this.pruned.add(signature);
        throw Error("public_execution_receipt_pruned");
      }
      if (Date.now() >= deadline)
        throw Error("public_execution_receipt_timeout");
      await new Promise((resolve) => setTimeout(resolve, this.pending.poll));
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
      computeUnits > 200000 ||
      failed !== observation.failed
    )
      throw Error("public_execution_receipt");
    return { fee, computeUnits, failed };
  }
  private async drain() {
    if (this.pruned.size) throw Error("public_execution_receipt_pruned");
    await this.options.progress.run(
      `Finalizing ${this.pending.count} upload/cleanup transactions`,
      () => this.pending.checkpoint(),
    );
    this.halted = false;
  }
  /** Required before restart, account/output acceptance, or rent recovery. */
  async checkpoint() {
    if (this.busy) throw Error("public_sender_concurrent_operation");
    this.busy = true;
    try {
      await this.drain();
    } catch (error) {
      this.halted = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async send(
    operation: string,
    value: Instruction | readonly Instruction[],
    journal: SubmissionJournal,
    options: UploadSendOptions = {},
  ): Promise<UploadTransactionRecord> {
    if (this.busy || this.halted)
      throw Error("public_sender_checkpoint_required");
    if (
      typeof operation !== "string" ||
      !operation ||
      operation.length > 128 ||
      this.operations.has(operation)
    )
      throw Error("public_sender_operation");
    const rent = options.rent ?? 0n;
    if (typeof rent !== "bigint" || rent < 0n || rent > 0xffffffffffffffffn)
      throw Error("invalid_budget");
    const original: readonly Instruction[] = Array.isArray(value)
      ? value
      : [value as Instruction];
    if (
      original.length < 1 ||
      original.length > 7 ||
      original.some((ix) => ix.programAddress === budgetProgram)
    )
      throw Error("public_instruction_count_or_budget");
    // Snapshot caller buffers before the first await, including Buffer-backed views.
    const instructions = original.map((ix) => ({
      ...ix,
      data: ix.data && Uint8Array.from(ix.data),
      accounts: ix.accounts?.map((a) => ({ ...a })),
    }));
    this.busy = true;
    const { rpc, signer, progress } = this.options;
    try {
      return await progress.run(
        `${operation}: reserve, submit, verify ${options.finalize ? "finalized" : this.pending.mode} receipt`,
        async () => {
          await rpc.beforeSigning();
          const lifetime = (
            await rpc.rpc<{
              value: {
                blockhash: Blockhash;
                lastValidBlockHeight: number | bigint;
              };
            }>("getLatestBlockhash", [{ commitment: this.pending.mode }])
          ).value;
          const message = setTransactionMessageLifetimeUsingBlockhash(
            {
              ...lifetime,
              lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
            },
            setTransactionMessageFeePayer(
              signer.address,
              createTransactionMessage({ version: 0 }),
            ),
          );
          const data = Buffer.alloc(5);
          data[0] = 2;
          data.writeUInt32LE(200000, 1);
          const signed = await signTransaction(
            [signer.keyPair],
            compileTransaction(
              appendTransactionMessageInstructions(
                [{ programAddress: budgetProgram, data }, ...instructions],
                message,
              ),
            ),
          );
          const wire = getTransactionEncoder().encode(signed),
            signature = getSignatureFromTransaction(signed);
          if (wire.length > 1232) throw Error("public_wire_limit");
          let provisional: Receipt | undefined = undefined;
          let record: UploadTransactionRecord | undefined;
          this.operations.add(operation);
          this.pending.track(signature, async (observation) => {
            const final = await this.receipt(signature, observation);
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
            if (!record) {
              record = {
                operation,
                signature,
                wireBytes: wire.length,
                ...final,
                finalized: false,
              };
              this.records.push(record);
            }
            if (!record.finalized) {
              this.fees += BigInt(final.fee);
              record.finalized = true;
            }
          });
          await journal.submit({
            operation,
            signature,
            wireBase64: Buffer.from(wire).toString("base64"),
            fee: "10000",
            rent: String(rent),
          });
          const observation = await this.pending.confirm(signature);
          provisional = await this.receipt(signature, observation);
          record = {
            operation,
            signature,
            wireBytes: wire.length,
            ...provisional,
            finalized: false,
          };
          this.records.push(record);
          if (
            options.finalize ||
            this.pending.mode === "finalized" ||
            this.pending.count === this.pending.limit
          )
            await this.drain();
          return { ...record };
        },
      );
    } catch (error) {
      if (this.pending.count) this.halted = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
