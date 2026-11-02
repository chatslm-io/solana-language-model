import { randomBytes } from "node:crypto";
import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  signTransaction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  chainCheck,
  discover,
  estimateDeployment,
  verifyDeployment,
  type RPC,
  type StoredAccount,
} from "@/lib/chain/client";
import {
  planUploadBatch,
  planWithdrawalBatch,
  previewBatch,
  assertSignedBatch,
  submitBatch,
  reconcileJournal,
  resolvedEntry,
  RecoverableBatchError,
  PendingTransactionsError,
  type BatchPreview,
} from "@/lib/chain/batch";
import { canonical, validateManifest } from "@/lib/model/manifest";
import { sha256 } from "@/lib/chain/protocol";
import { safeError } from "@/lib/server/security";
import type { Network, OperatorConfig } from "./config";
import { assertRpcEndpoint, rpcInfo } from "./config";
import { rpcPolicy } from "@/lib/chain/rpc-policy";
import type { ModelProvider, Source } from "./models";
import type { JobStore } from "./store";
import type { Job, Mode, OperatorStatus, PublicJob } from "./types";
import { operationProgress, uploadTotals } from "./progress";
import {
  publicProgram,
  quoteProgram,
  runProgram,
  refreshProgramRecovery,
} from "./program-deploy";
import type { ProgramJob } from "./program-types";
export type OperatorDependencies = {
  store: JobStore;
  signer(): Promise<KeyPairSigner | null>;
  config(cluster: Network): OperatorConfig;
  rpc(config: OperatorConfig): RPC;
  models: ModelProvider;
  binary?(): Promise<Uint8Array>;
};
const id = () => randomBytes(32).toString("hex");
const sum = (accounts: StoredAccount[]) =>
  accounts.reduce((n, a) => n + a.lamports, 0n);
export class OperatorEngine {
  private jobs: Job[];
  private busy = false;
  private stopped = false;
  private task: Promise<void> | null = null;
  private inventory = new Map<
    string,
    { balance: string; refundable: string; accounts: number }
  >();
  constructor(private deps: OperatorDependencies) {
    this.jobs = deps.store.load();
  }
  private save() {
    this.deps.store.save(this.jobs);
  }
  private config(cluster: Network): OperatorConfig {
    const config = this.deps.config(cluster);
    return {
      ...config,
      program: config.program || this.deps.store.programs[cluster] || null,
      rpcPolicy: rpcPolicy(
        this.deps.store.rpcSettings[cluster] || config.rpcPolicy,
      ),
    };
  }
  async configureRpc(cluster: Network, input: unknown) {
    const policy = rpcPolicy(input);
    const release = this.acquire();
    try {
      const config = { ...this.config(cluster), rpcPolicy: policy };
      assertRpcEndpoint(config);
      this.deps.store.rpcSettings[cluster] = policy;
      const job = this.current();
      if (job?.cluster === cluster && job.phase !== "complete")
        job.rpcPolicy = policy;
      this.save();
      this.inventory.clear();
      return rpcInfo(config);
    } finally {
      release();
    }
  }
  private saveProgress(job: Job) {
    job.reclaimed = String(
      job.journal
        .filter((e) => e.operation === "close" && e.status === "verified")
        .reduce((n, e) => n + BigInt(e.reclaim || "0"), 0n),
    );
    this.save();
  }
  private current() {
    return this.jobs.at(-1);
  }
  private view(job: Job): PublicJob {
    const { journal, ...publicJob } = job;
    if (!this.busy && ["running", "preparing"].includes(publicJob.phase)) {
      publicJob.phase = "paused";
      publicJob.message =
        "Operator process stopped. Resume reconciles saved signatures before continuing.";
    }
    return {
      ...publicJob,
      operationProgress: operationProgress(job),
      lastSignature: journal.findLast((e) => e.signature)?.signature,
    };
  }
  async status(cluster: Network, refresh = true): Promise<OperatorStatus> {
    if (!this.busy) {
      const previous = this.current();
      const latest = this.deps.store.load();
      const current = latest.at(-1);
      if (
        previous?.id !== current?.id ||
        previous?.phase !== current?.phase ||
        previous?.signedTransactions !== current?.signedTransactions
      )
        this.inventory.clear();
      this.jobs = latest;
    }
    const config = this.config(cluster);
    const signer = await this.deps.signer();
    const job = this.current();
    if (job?.manifestId && job.mode !== "withdraw" && !job.uploadTotals) {
      // Older journals remain resumable. Reading totals is optional and must
      // never prevent recovery if the original model files are unavailable.
      try {
        const prepared = await this.deps.models.manifest(job.manifestId);
        job.uploadTotals = uploadTotals(prepared.manifest);
      } catch {
        /* Keep status/recovery available without model files. */
      }
    }
    const out: OperatorStatus = {
      cluster,
      owner: signer?.address || null,
      program: config.program,
      balance: "0",
      refundable: "0",
      accounts: 0,
      maxDeposit: config.maxDeposit,
      maxFees: config.maxFees,
      busy: this.busy,
      rpc: rpcInfo(config),
      programDeployment: this.programJob()
        ? publicProgram(this.programJob()!, this.busy)
        : null,
      job: this.current() ? this.view(this.current()!) : null,
    };
    if (config.rpcPolicy.mode === "paid" && !out.rpc.paidAvailable) {
      out.error =
        "Paid mode needs a private provider RPC URL. Update operator.env or select Free RPC.";
      return out;
    }
    const key = `${cluster}:${signer?.address}:${config.program}`;
    const cached = this.inventory.get(key);
    if (cached) Object.assign(out, cached);
    if ((refresh || !cached) && signer && !this.busy) {
      const rpc = this.deps.rpc(config);
      out.balance = String(
        (
          await rpc
            .getBalance(signer.address, { commitment: "finalized" })
            .send()
        ).value,
      );
      if (config.program) {
        await chainCheck(rpc, config);
        const found = await discover(
          rpc,
          address(config.program),
          signer.address,
        );
        if (found.some((a) => !a.recoverable))
          throw new Error(
            "An account failed recovery validation; inspect it in advanced recovery",
          );
        out.refundable = String(sum(found));
        out.accounts = found.length;
      }
      this.inventory.set(key, {
        balance: out.balance,
        refundable: out.refundable,
        accounts: out.accounts,
      });
    }
    return out;
  }
  private acquire() {
    if (this.busy)
      throw new Error(
        "An operation is already active. Pause it before changing modes or networks.",
      );
    const release = this.deps.store.lock();
    try {
      this.jobs = this.deps.store.load();
    } catch (e) {
      release();
      throw e;
    }
    this.busy = true;
    this.stopped = false;
    return () => {
      this.busy = false;
      release();
    };
  }
  private async reconcile() {
    for (const job of this.jobs) {
      if (!job.journal.some((e) => e.signature && !resolvedEntry(e))) continue;
      const config = this.config(job.cluster);
      if (config.program !== job.program)
        throw new Error(
          "Pinned program changed; retain the journal and restore its configuration before recovery",
        );
      const rpc = this.deps.rpc(config);
      await chainCheck(rpc, config);
      await reconcileJournal(rpc, address(job.owner), job.journal, () =>
        this.saveProgress(job),
      );
    }
  }
  private runTask(
    job: Job | ProgramJob,
    release: () => void,
    work: () => Promise<void>,
  ) {
    this.task = (async () => {
      try {
        await work();
      } catch (e) {
        job.phase = this.stopped ? "paused" : "failed";
        job.message = safeError(e);
        this.save();
      } finally {
        this.inventory.clear();
        release();
      }
    })();
    // The durable journal is the recovery source if a write fails. Never print
    // arbitrary exception objects or abandon a submitted batch before it settles.
    void this.task.catch(() => {});
  }
  async wait() {
    await this.task;
  }
  private programJob() {
    return this.deps.store.programJobs.at(-1);
  }
  async prepareProgram(cluster: Network) {
    const release = this.acquire();
    try {
      const config = this.config(cluster);
      assertRpcEndpoint(config);
      if (config.program)
        throw new Error(
          "A storage program is already configured; this action never replaces or upgrades it",
        );
      const current = this.programJob();
      if (
        current?.cluster === cluster &&
        current.intent === "recover" &&
        current.phase !== "recovered"
      ) {
        const signer = await this.deps.signer();
        if (!signer || signer.address !== current.owner)
          throw new Error("Restore the original buffer owner before recovery");
        await refreshProgramRecovery(
          current,
          this.deps.rpc(config),
          config,
          () => this.save(),
        );
        return publicProgram(current, false);
      }
      if (
        current?.approved &&
        !["complete", "recovered"].includes(current.phase)
      )
        throw new Error(
          "Resume or reclaim the unfinished program deployment first",
        );
      if (!this.deps.binary)
        throw new Error("Program deployment is unavailable in this process");
      const signer = await this.deps.signer();
      if (!signer) throw new Error("Configure the external local signer first");
      await this.reconcile();
      if (this.deps.store.programJobs.length >= 100)
        throw new Error(
          "Archive fully resolved program journals before preparing more deployments",
        );
      const job = await quoteProgram(
        config,
        this.deps.rpc(config),
        signer,
        await this.deps.binary(),
      );
      this.deps.store.programJobs.push(job);
      this.save();
      return publicProgram(job, false);
    } finally {
      release();
    }
  }
  async startProgram(jobId: string, cluster: Network, recover = false) {
    const release = this.acquire();
    try {
      const job = this.programJob();
      if (
        !job ||
        job.id !== jobId ||
        job.cluster !== cluster ||
        ["complete", "recovered"].includes(job.phase)
      )
        throw new Error("Program preview or network changed");
      if (!recover && job.intent === "recover")
        throw new Error("Finish buffer recovery before deploying again");
      if (!recover && !job.approved && Date.now() - job.quotedAt > 600000)
        throw new Error("Program cost preview expired; review a fresh quote");
      const signer = await this.deps.signer();
      if (!signer || signer.address !== job.owner)
        throw new Error(
          "Restore the program deployment's original local signer",
        );
      const config = this.config(cluster);
      assertRpcEndpoint(config);
      if (config.program && config.program !== job.program)
        throw new Error("A different storage program is already configured");
      if (
        !recover &&
        (BigInt(config.maxDeposit) < BigInt(job.deposit) ||
          BigInt(config.maxFees) < BigInt(job.feeBudget) ||
          config.maxTransactions < job.transactionBudget)
      )
        throw new Error(
          "Program deployment limits changed; restore the approved limits or reclaim the buffer",
        );
      if (recover && BigInt(config.maxFees) < BigInt(job.recoveryFeeBudget))
        throw new Error("Buffer recovery exceeds the configured fee cap");
      if (
        !recover &&
        !job.approved &&
        (
          await this.deps
            .rpc(config)
            .getBalance(signer.address, { commitment: "finalized" })
            .send()
        ).value <
          BigInt(job.deposit) + BigInt(job.feeBudget)
      )
        throw new Error(
          "Fund the wallet for the complete program deposit and approved fee budget before deploying",
        );
      job.approved = true;
      job.intent = recover ? "recover" : "deploy";
      job.phase = "running";
      job.message = "Reconciling program deployment signatures…";
      this.save();
      this.runTask(job, release, async () => {
        await this.reconcile();
        await runProgram({
          job,
          config,
          signer,
          rpc: this.deps.rpc(config),
          binary: async () => {
            if (!this.deps.binary)
              throw new Error("Program binary unavailable");
            return this.deps.binary();
          },
          save: () => this.save(),
          stopped: () => this.stopped,
          pin: (program) => {
            const current = this.config(cluster).program;
            if (current && current !== program)
              throw new Error("Pinned program changed during deployment");
            this.deps.store.programs[cluster] = program;
          },
        });
        if (this.stopped && job.phase === "running") {
          job.phase = "paused";
          job.message =
            "Program deployment paused. Resume or reclaim its unfinished buffer.";
          this.save();
        }
      });
      return publicProgram(job, true);
    } catch (error) {
      release();
      throw error;
    }
  }
  async prepare(
    cluster: Network,
    mode: Mode,
    source?: Source,
  ): Promise<PublicJob> {
    if (!["test", "upload", "withdraw"].includes(mode))
      throw new Error("Unsupported operator mode");
    const release = this.acquire();
    let job: Job;
    try {
      const signer = await this.deps.signer();
      if (!signer)
        throw new Error(
          "Configure your isolated key in the external operator.env file first",
        );
      const config = this.config(cluster);
      assertRpcEndpoint(config);
      if (!config.program)
        throw new Error(
          `No storage program is configured for ${cluster}. Program deployment is a separate bootstrap step.`,
        );
      if (
        cluster === "mainnet-beta" &&
        mode === "upload" &&
        !this.jobs.some(
          (previous) =>
            previous.cluster === cluster &&
            previous.program === config.program &&
            previous.owner === signer.address &&
            previous.mode === "test" &&
            previous.phase === "complete",
        )
      )
        throw new Error(
          "Run Test on mainnet and verify its full rent recovery before uploading a model",
        );
      if (mode === "upload" && !source)
        throw new Error("Choose a Hugging Face repository and GGUF first");
      // Never drop uncertain signatures when replacing a preview or changing networks.
      await this.reconcile();
      if (this.jobs.length >= 100)
        throw new Error(
          "Operator journal has 100 runs. Archive resolved history before starting another run.",
        );
      job = {
        id: id(),
        cluster,
        mode,
        rpcPolicy: config.rpcPolicy,
        owner: signer.address,
        program: config.program,
        phase: "preparing",
        message: "Preparing…",
        created: Date.now(),
        deployment: mode === "withdraw" ? undefined : id(),
        accounts: [],
        bytes: 0,
        tensors: 0,
        file: source?.file,
        source,
        expectedRefund: "0",
        deposit: "0",
        estimatedFees: "0",
        feeBudget: "0",
        transactionBudget: 0,
        reservedDeposit: "0",
        reservedFees: "0",
        signedTransactions: 0,
        reclaimed: "0",
        verifiedBytes: 0,
        journal: [],
        approved: false,
        stage: mode === "withdraw" ? "withdraw" : "upload",
      };
      this.jobs.push(job);
      this.save();
      this.runTask(job, release, async () => {
        const rpc = this.deps.rpc(config);
        await chainCheck(rpc, config);
        let fees = 0n,
          transactions = 0;
        if (mode === "withdraw") {
          const found = await discover(
            rpc,
            address(job.program),
            signer.address,
          );
          if (found.some((a) => !a.recoverable))
            throw new Error("An account failed recovery validation");
          job.accounts = found.map((a) => a.address);
          job.expectedRefund = String(sum(found));
          job.message = `Ready to return rent from ${found.length} accounts to the local signer.`;
          if (found.length) {
            const ops = await planWithdrawalBatch(
              address(job.program),
              signer.address,
              found,
              new Set(job.accounts),
              1,
            );
            const quote = await previewBatch(
              rpc,
              config,
              signer.address,
              ops,
              sum(found),
            );
            transactions = found.length;
            fees = quote.fee * BigInt(transactions);
          }
        } else {
          const prepared = await this.deps.models.prepare(
            mode === "test" ? null : source!,
            (message, bytes, total) => {
              job.message = message;
              job.downloadBytes = bytes;
              job.downloadTotal = total;
              this.save();
            },
            () => this.stopped,
          );
          validateManifest(prepared.manifest);
          if (
            (await sha256(
              new TextEncoder().encode(canonical(prepared.manifest)),
            )) !== prepared.id
          )
            throw new Error("Manifest commitment mismatch");
          job.manifestId = prepared.id;
          job.bytes = prepared.manifest.payloadBytes;
          job.tensors = prepared.manifest.tensors.length;
          job.uploadTotals = uploadTotals(prepared.manifest);
          const estimate = await estimateDeployment(
            rpc,
            address(job.program),
            signer.address,
            job.deployment!,
            prepared.id,
            prepared.manifest,
          );
          job.deposit = String(estimate.deposit);
          job.expectedRefund = String(estimate.rent);
          job.accounts = estimate.accounts.map((a) => a.address);
          transactions = estimate.transactions;
          fees = estimate.fees;
          if (mode === "test") {
            fees += (fees / BigInt(transactions)) * BigInt(job.accounts.length);
            transactions += job.accounts.length;
          }
          job.message =
            mode === "test"
              ? "Ready: upload 78 test bytes, verify them, and reclaim the rent."
              : "Ready to deploy the selected transformer weights. Embeddings stay offchain.";
        }
        if (this.stopped) throw new Error("Preparation paused");
        if (BigInt(job.deposit) > BigInt(config.maxDeposit))
          throw new Error("Deployment exceeds the configured deposit cap");
        if (
          fees > BigInt(config.maxFees) ||
          transactions > config.maxTransactions
        )
          throw new Error(
            "Operation exceeds the configured fee or transaction cap",
          );
        job.estimatedFees = String(fees);
        job.feeBudget = String(
          fees * 2n > BigInt(config.maxFees)
            ? BigInt(config.maxFees)
            : fees * 2n,
        );
        job.transactionBudget = Math.min(
          config.maxTransactions,
          transactions * 2,
        );
        const balance = (
          await rpc
            .getBalance(signer.address, { commitment: "finalized" })
            .send()
        ).value;
        if (balance < BigInt(job.deposit) + BigInt(job.feeBudget))
          throw new Error(
            "Fund the local signer to cover the displayed deposit and fee budget, then prepare again",
          );
        job.quotedAt = Date.now();
        job.phase = "ready";
        this.save();
      });
      return this.view(job);
    } catch (e) {
      release();
      throw e;
    }
  }
  async start(jobId: string, cluster: Network): Promise<PublicJob> {
    const release = this.acquire();
    try {
      const job = this.current();
      if (!job || job.id !== jobId || job.cluster !== cluster)
        throw new Error("Operation or network changed; prepare a new preview");
      if (
        !["ready", "paused", "failed", "running"].includes(job.phase) ||
        (!job.approved && job.phase !== "ready")
      )
        throw new Error("Prepare and review the operation first");
      if (
        !job.approved &&
        Date.now() - (job.quotedAt ?? job.created) > 600000
      ) {
        job.phase = "failed";
        job.message =
          "Cost preview expired. Prepare it again before deploying.";
        this.save();
        throw new Error(job.message);
      }
      const signer = await this.deps.signer();
      if (!signer || signer.address !== job.owner)
        throw new Error(
          "Local signer changed; restore the original key or prepare a new operation",
        );
      const config = this.config(cluster);
      assertRpcEndpoint(config);
      if (
        config.program !== job.program ||
        BigInt(config.maxDeposit) < BigInt(job.deposit) ||
        BigInt(config.maxFees) < BigInt(job.feeBudget) ||
        config.maxTransactions < job.transactionBudget
      )
        throw new Error("Program or run limits changed; prepare again");
      job.approved = true;
      job.rpcPolicy = config.rpcPolicy;
      job.phase = "running";
      job.message = "Reconciling saved signatures…";
      this.save();
      this.runTask(job, release, () => this.execute(job, signer, config));
      return this.view(job);
    } catch (e) {
      release();
      throw e;
    }
  }
  pause(jobId: string) {
    const program = this.programJob();
    if (program?.id === jobId) {
      this.stopped = true;
      program.message = "Pausing after in-flight program transactions settle…";
      if (this.busy) this.save();
      return publicProgram(program, this.busy);
    }
    const job = this.current();
    if (!job || job.id !== jobId) throw new Error("Operation changed");
    this.stopped = true;
    job.message =
      "Pausing after in-flight transactions settle. Storage remains recoverable.";
    // Only write while holding this process's operation lock.
    if (this.busy) this.save();
    return this.view(job);
  }
  private async signAndSubmit(
    job: Job,
    signer: KeyPairSigner,
    config: OperatorConfig,
    batch: BatchPreview,
  ) {
    if (this.stopped) return;
    const deposit = BigInt(job.reservedDeposit) + batch.deposit;
    const fees = BigInt(job.reservedFees) + batch.fee;
    const count = job.signedTransactions + batch.transactions.length;
    if (
      deposit > BigInt(job.deposit) ||
      fees > BigInt(job.feeBudget) ||
      count > job.transactionBudget
    )
      throw new Error(
        "Approved operation budget exhausted. Reconcile and prepare a new bounded run.",
      );
    const signed = await Promise.all(
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
    const signatures = await assertSignedBatch(batch, signed);
    job.reservedDeposit = String(deposit);
    job.reservedFees = String(fees);
    job.signedTransactions = count;
    const at = job.journal.length;
    job.journal.push(
      ...batch.transactions.map((p, i) => ({
        label: p.operation.label,
        status: "signed; not submitted",
        signature: signatures[i],
        account: p.operation.account,
        operation: p.operation.kind,
        reclaim: p.operation.reclaim.toString(),
        expectedHash: p.operation.expectedHash,
        refundRecipient: p.operation.refundRecipient,
        lastValidBlockHeight: p.lastValidBlockHeight.toString(),
      })),
    );
    this.save();
    await submitBatch(
      this.deps.rpc(config),
      batch,
      signed,
      (i, status, signature) => {
        job.journal[at + i] = { ...job.journal[at + i], status, signature };
        job.message = `${batch.transactions[i].operation.label}: ${status}`;
        this.saveProgress(job);
      },
      () => !this.stopped,
      config.rpcPolicy.mode === "paid"
        ? Math.min(16, config.rpcPolicy.sendRps)
        : 3,
    );
  }
  private async execute(
    job: Job,
    signer: KeyPairSigner,
    config: OperatorConfig,
  ) {
    let retries = 0,
      completed = 0;
    while (!this.stopped) {
      try {
        await this.executeAttempt(job, signer, config);
        return;
      } catch (error) {
        if (this.stopped) break;
        if (!(
          error instanceof RecoverableBatchError ||
          error instanceof PendingTransactionsError
        ))
          throw error;
        const progress = job.journal.filter((e) =>
          ["finalized", "verified"].includes(e.status),
        ).length;
        if (progress > completed) {
          retries = 0;
          completed = progress;
        }
        if (++retries > 3)
          throw new Error(
            "Upload made no progress after three automatic recovery attempts. Pause and check the RPC before resuming.",
          );
        job.message =
          "Waiting for pending transactions to finalize or expire. Automatic recovery will rescan before signing…";
        this.save();
        let resolved = false;
        for (let attempt = 0; attempt < 90 && !this.stopped; attempt++) {
          try {
            await this.reconcile();
            resolved = true;
            break;
          } catch (pending) {
            if (!(pending instanceof PendingTransactionsError)) throw pending;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (this.stopped) break;
        if (!resolved)
          throw new Error(
            "Transactions remain unresolved after automatic checks. No replacement was signed; resume when the RPC recovers.",
          );
        if (job.journal.some((e) => e.status === "failed"))
          throw new Error(
            "A transaction failed onchain. Review the journal before continuing.",
          );
        job.message =
          "Signatures reconciled. Rescanning finalized accounts and continuing within the approved budget…";
        this.save();
      }
    }
    job.phase = "paused";
    job.message =
      "Paused. Resume reconciles saved signatures before continuing.";
    this.save();
  }
  private async executeAttempt(
    job: Job,
    signer: KeyPairSigner,
    config: OperatorConfig,
  ) {
    const rpc = this.deps.rpc(config),
      program = address(job.program);
    const paid = config.rpcPolicy.mode === "paid";
    const batchSize = paid
      ? Math.min(16, Math.max(1, Math.floor(config.rpcPolicy.rps / 2)))
      : 16;
    await chainCheck(rpc, config);
    await this.reconcile();
    const prepared =
      job.stage === "upload"
        ? await this.deps.models.manifest(job.manifestId!)
        : null;
    if (prepared && !job.uploadTotals) {
      job.uploadTotals = uploadTotals(prepared.manifest);
      this.save();
    }
    while (!this.stopped) {
      const found = await discover(rpc, program, signer.address);
      let operations;
      if (job.stage === "upload") {
        operations = await planUploadBatch(
          rpc,
          program,
          signer.address,
          job.deployment!,
          job.manifestId!,
          prepared!.manifest,
          (i) => this.deps.models.shard(job.manifestId!, i),
          found,
          batchSize,
        );
        if (!operations.length) {
          job.message = "Reading back and verifying every stored byte…";
          this.save();
          await verifyDeployment(
            rpc,
            program,
            signer.address,
            job.deployment!,
            job.manifestId!,
            prepared!.manifest,
            () => {},
          );
          job.verifiedBytes = job.bytes;
          if (job.mode === "test") {
            job.stage = "withdraw";
            this.save();
            continue;
          }
          job.phase = "complete";
          job.message =
            "Deployment verified from Solana. Storage rent can be reclaimed in Withdraw.";
          this.save();
          return;
        }
      } else {
        if (
          found.some((a) => job.accounts.includes(a.address) && !a.recoverable)
        )
          throw new Error("An account failed recovery validation");
        operations = await planWithdrawalBatch(
          program,
          signer.address,
          found,
          new Set(job.accounts),
          batchSize,
        );
        if (!operations.length) {
          if (found.some((a) => job.accounts.includes(a.address)))
            throw new Error(
              "Some selected accounts remain; recovery is incomplete",
            );
          job.phase = "complete";
          job.message =
            job.mode === "test"
              ? "Test passed: bytes verified and all storage rent reclaimed. Only network fees were spent."
              : "Withdrawal complete. Every selected account closed and every rent refund verified.";
          this.save();
          return;
        }
      }
      const batch = await previewBatch(
        rpc,
        config,
        signer.address,
        operations,
        sum(found),
        paid ? Math.min(8, config.rpcPolicy.rps) : 1,
      );
      await this.signAndSubmit(job, signer, config, batch);
    }
    job.phase = "paused";
    job.message =
      "Paused. Resume reconciles saved signatures before continuing.";
    this.save();
  }
}
