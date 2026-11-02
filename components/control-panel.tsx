"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import SlmLogo from "./slm-logo";
import {
  address,
  signature,
  generateKeyPairSigner,
  type KeyPairSigner,
} from "@solana/kit";
import {
  prepareSession,
  uploadSession,
  refundSessionFees,
  type SessionPlan,
} from "@/lib/chain/session";
import { readRun, reserveRun, type Run } from "@/lib/chain/run";
import {
  api,
  rpcClient,
  chainCheck,
  discover,
  verifyDeployment,
  estimateDeployment,
  verifyClosure,
  type Config,
  type StoredAccount,
  type Estimate,
} from "@/lib/chain/client";
import {
  planUploadBatch,
  planWithdrawalBatch,
  previewBatch,
  assertSignedBatch,
  submitBatch,
  reconcileJournal,
  type BatchPreview,
  type JournalEntry,
} from "@/lib/chain/batch";
import { connectPhantom, type Connected } from "@/lib/chain/wallet";
import { sol, hex, fromBase64 } from "@/lib/chain/protocol";
import { selection, type Tensor } from "@/lib/model/formats";
import type { Manifest } from "@/lib/model/manifest";
type Resolved = {
  repo: string;
  revision: string;
  files: { name: string; size: number }[];
};
type Model = { id: string; tensors: Tensor[] };
type Prepared = { id: string; manifest: Manifest };
type Log = JournalEntry;
type Quote = { usd: number | null; timestamp: number | null; stale: boolean };
const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 1048576).toFixed(2)} MiB`;
const downloadJson = (name: string, value: unknown) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const Item = ({ label, value }: { label: string; value: string }) => (
  <div className="line-item">
    <span>{label}</span>
    <span>{value}</span>
  </div>
);
export default function ControlPanel({
  recoveryOnly = false,
}: {
  recoveryOnly?: boolean;
}) {
  const [config, setConfig] = useState<Config | null>(null),
    [wallet, setWallet] = useState<Connected | null>(null),
    [mode, setMode] = useState<"upload" | "withdraw">(
      recoveryOnly ? "withdraw" : "upload",
    );
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [balance, setBalance] = useState<bigint | null>(null),
    [accounts, setAccounts] = useState<StoredAccount[]>([]),
    [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [repo, setRepo] = useState(""),
    [revision, setRevision] = useState(""),
    [resolved, setResolved] = useState<Resolved | null>(null),
    [files, setFiles] = useState<Set<string>>(new Set()),
    [model, setModel] = useState<Model | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [range, setRange] = useState("0-1"),
    [query, setQuery] = useState("");
  const [job, setJob] = useState<{
      bytes: number;
      total: number;
      file: string;
    } | null>(null),
    [prepared, setPrepared] = useState<Prepared | null>(null),
    [deployment, setDeployment] = useState(""),
    [estimate, setEstimate] = useState<Estimate | null>(null),
    [batch, setBatch] = useState<BatchPreview | null>(null),
    [batchSize, setBatchSize] = useState(8),
    [confirmed, setConfirmed] = useState(false),
    [mainnet, setMainnet] = useState(""),
    [logs, setLogs] = useState<Log[]>([]),
    [verified, setVerified] = useState<Record<number, boolean>>({}),
    [run, setRun] = useState<Run>({ deposit: "0", transactions: 0 }),
    [quote, setQuote] = useState<Quote | null>(null);
  const stopRequested = useRef(false);
  const sessionKey = useRef<KeyPairSigner | null>(null);
  const activeSession = useRef<SessionPlan | null>(null);
  const [sessionReview, setSessionReview] = useState<SessionPlan | null>(null);
  const [sessionConfirmed, setSessionConfirmed] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const sessionReviewElement = useRef<HTMLDivElement | null>(null);
  const batchReviewElement = useRef<HTMLDivElement | null>(null);
  const errorElement = useRef<HTMLDivElement | null>(null);
  const operationRunning = useRef(false);
  const epoch = useRef(0),
    walletRef = useRef<Connected | null>(null);
  const rpc = useCallback(
    () => rpcClient(new URL("/api/rpc", location.href).toString()),
    [],
  );
  const identity =
    wallet && config
      ? `${config.cluster}:${config.program}:${wallet.account.address}`
      : "";
  const runKey = `slm-run-v1:${identity}`;
  useEffect(() => {
    if (sessionReview) sessionReviewElement.current?.focus();
  }, [sessionReview]);
  useEffect(() => {
    if (batch) batchReviewElement.current?.focus();
  }, [batch]);
  useEffect(() => {
    if (error) errorElement.current?.focus();
  }, [error]);
  const perform = async (work: () => Promise<void>) => {
    if (operationRunning.current) return;
    operationRunning.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      operationRunning.current = false;
      setBusy(false);
    }
  };
  const invalidate = () => {
    epoch.current++;
    setBatch(null);
    setSessionReview(null);
    setSessionConfirmed(false);
    setConfirmed(false);
    setEstimate(null);
    setVerified({});
  };
  useEffect(() => {
    api<Config>("config")
      .then(setConfig)
      .catch((e) => setError(e.message));
    let live = true;
    const refresh = () =>
      api<Quote>("price")
        .then((q) => {
          if (live) setQuote(q);
        })
        .catch(() => {
          if (live) setQuote(null);
        });
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      live = false;
      clearInterval(timer);
      walletRef.current?.cleanup();
      sessionKey.current = null;
      activeSession.current = null;
    };
  }, []);
  const refreshAccounts = async () => {
    if (!wallet || !config) return;
    const mark = epoch.current,
      r = rpc(),
      who = address(wallet.account.address);
    const balance = (
      await r.getBalance(who, { commitment: "finalized" }).send()
    ).value;
    const found = config.program
      ? (await chainCheck(r, config),
        await discover(r, address(config.program), who))
      : [];
    if (mark !== epoch.current || walletRef.current?.account.address !== who)
      return;
    setBalance(balance);
    setAccounts(found);
  };
  async function connect() {
    await perform(async () => {
      const w = await connectPhantom(() => {
        epoch.current++;
        walletRef.current?.cleanup();
        walletRef.current = null;
        sessionKey.current = null;
        activeSession.current = null;
        setSessionStarted(false);
        setWallet(null);
        setLogs([]);
        setBatch(null);
        setAccounts([]);
        setPrepared(null);
        setDeployment("");
        setBalance(null);
        setEstimate(null);
        setMessage(
          "Wallet changed. Reconnect to load that wallet’s deployments.",
        );
      });
      walletRef.current = w;
      setWallet(w);
      invalidate();
      setAccounts([]);
      setPrepared(null);
      setDeployment("");
      if (config) {
        const key = `${config.cluster}:${config.program}:${w.account.address}`;
        const saved = localStorage.getItem(`slm-deployment-v1:${key}`),
          savedRun = localStorage.getItem(`slm-run-v1:${key}`);
        setRun(readRun(savedRun));
        const savedJournal = JSON.parse(
          localStorage.getItem(`slm-journal-v1:${key}`) || "[]",
        );
        setLogs(
          Array.isArray(savedJournal)
            ? savedJournal.filter(
                (x: Log) =>
                  typeof x.label === "string" && typeof x.status === "string",
              )
            : [],
        );
        if (saved && !recoveryOnly) {
          const p = JSON.parse(saved);
          setDeployment(p.deployment);
          try {
            setPrepared(
              await api<Prepared>("model", {
                action: "manifest",
                id: p.manifest,
              }),
            );
          } catch {
            setMessage(
              "Local manifest unavailable. Withdraw remains available.",
            );
          }
        }
        const r = rpc();
        setBalance(
          (
            await r
              .getBalance(address(w.account.address), {
                commitment: "finalized",
              })
              .send()
          ).value,
        );
        if (config.program) {
          await chainCheck(r, config);
          const found = await discover(
            r,
            address(config.program),
            address(w.account.address),
          );
          setAccounts(found);
          setSelectedAccounts(new Set(found.map((a) => a.address)));
        }
      }
    });
  }
  async function disconnect() {
    invalidate();
    sessionKey.current = null;
    activeSession.current = null;
    setSessionStarted(false);
    await wallet?.disconnect();
    walletRef.current = null;
    setWallet(null);
    setAccounts([]);
    setBalance(null);
    setPrepared(null);
    setDeployment("");
  }
  async function choosePrepared(p: Prepared) {
    invalidate();
    setPrepared(p);
    const id = hex(crypto.getRandomValues(new Uint8Array(32)));
    setDeployment(id);
    if (identity)
      localStorage.setItem(
        `slm-deployment-v1:${identity}`,
        JSON.stringify({ deployment: id, manifest: p.id }),
      );
  }
  const selectedTensors = model ? selection(model.tensors, [...selected]) : [],
    selectedBytes = selectedTensors.reduce((n, t) => n + t.length, 0),
    held = accounts.reduce((n, a) => n + a.lamports, 0n),
    reclaim = accounts
      .filter((a) => selectedAccounts.has(a.address))
      .reduce((n, a) => n + a.lamports, 0n);
  const registry = accounts.find(
    (a) => a.header.kind === 1 && a.header.id === deployment,
  );
  const readyToVerify = registry?.header.state === 1;
  const usd = (n: bigint) =>
    quote?.usd
      ? `≈ $${((Number(n) / 1e9) * quote.usd).toLocaleString(undefined, { maximumFractionDigits: 2 })}${quote.stale ? " (stale)" : ""}`
      : "USD unavailable";
  async function checkedJournal() {
    if (!wallet) throw new Error("Connect Phantom first");
    const entries = JSON.parse(
      localStorage.getItem(`slm-journal-v1:${identity}`) || "[]",
    ) as Log[];
    const persist = () => {
      localStorage.setItem(
        `slm-journal-v1:${identity}`,
        JSON.stringify(entries),
      );
      setLogs([...entries]);
    };
    await reconcileJournal(
      rpc(),
      address(wallet.account.address),
      entries,
      persist,
    );
    return { entries, persist };
  }
  async function prepareBatch(allWithdrawalAccounts = false) {
    await perform(async () => {
      if (!wallet || !config?.program)
        throw new Error(
          "Connect Phantom and configure a deployed program first",
        );
      if (allWithdrawalAccounts && mode !== "withdraw")
        throw new Error("Switch to Withdraw before reclaiming accounts");
      if (allWithdrawalAccounts) invalidate();
      else {
        setBatch(null);
        setSessionReview(null);
      }
      setMessage(
        mode === "withdraw"
          ? "Scanning Solana and simulating the refund batch. Phantom opens after you review and click Sign."
          : "Preparing and simulating the next batch…",
      );
      const r = rpc(),
        who = address(wallet.account.address),
        program = address(config.program),
        mark = epoch.current;
      await chainCheck(r, config);
      await checkedJournal();
      const currentRun = readRun(localStorage.getItem(runKey));
      const limit = Math.min(
        batchSize,
        config.maxTransactions - currentRun.transactions,
      );
      if (limit < 1)
        throw new Error(
          "Transaction cap reached. Explicitly start a new capped run to continue.",
        );
      const found = await discover(r, program, who);
      if (mark !== epoch.current)
        throw new Error("Wallet changed; reconnect before preparing");
      setAccounts(found);
      // Use the fresh inventory directly. React's selectedAccounts state does
      // not update synchronously when Close All changes the selection.
      const withdrawalSelection = allWithdrawalAccounts
        ? new Set(found.filter((a) => a.recoverable).map((a) => a.address))
        : selectedAccounts;
      if (allWithdrawalAccounts) setSelectedAccounts(withdrawalSelection);
      let operations;
      if (mode === "upload") {
        if (!prepared || !deployment)
          throw new Error(
            "Prepare a tensor selection or synthetic proof first",
          );
        if (!estimate)
          setEstimate(
            await estimateDeployment(
              r,
              program,
              who,
              deployment,
              prepared.id,
              prepared.manifest,
            ),
          );
        operations = await planUploadBatch(
          r,
          program,
          who,
          deployment,
          prepared.id,
          prepared.manifest,
          async (index) =>
            fromBase64(
              (
                await api<{ bytes: string }>("model", {
                  action: "shard",
                  id: prepared.id,
                  index,
                })
              ).bytes,
            ),
          found,
          limit,
        );
        if (!operations.length) {
          await verifyDeployment(
            r,
            program,
            who,
            deployment,
            prepared.id,
            prepared.manifest,
            (i, ok) => setVerified((v) => ({ ...v, [i]: ok })),
          );
          setMessage(
            "Deployment complete: every shard was read back at finalized commitment and verified.",
          );
          return;
        }
      } else
        operations = await planWithdrawalBatch(
          program,
          who,
          found,
          withdrawalSelection,
          limit,
        );
      if (!operations.length) {
        setMessage(
          "All selected accounts are closed. Rescan to check remaining wallet accounts.",
        );
        return;
      }
      reserveRun(
        currentRun,
        operations.reduce((n, o) => n + o.deposit, 0n),
        BigInt(config.maxDeposit),
        config.maxTransactions,
        operations.length,
      );
      const p = await previewBatch(
        r,
        config,
        who,
        operations,
        found.reduce((n, a) => n + a.lamports, 0n),
      );
      if (mark !== epoch.current)
        throw new Error("Wallet or selection changed; prepare again");
      setBatch(p);
      setConfirmed(false);
      setMainnet("");
      setMessage(
        mode === "withdraw"
          ? `Refund preview ready for ${p.transactions.length} transaction(s). Review the amounts, check the confirmation box, then click Sign in Phantom. Registries with live shards close in a later batch.`
          : `Prepared and simulated ${p.transactions.length} transaction(s). Review the whole batch before signing.`,
      );
    });
  }
  async function signBatch() {
    await perform(async () => {
      if (!wallet || !batch || !config || !confirmed)
        throw new Error("Review and confirm the batch first");
      if (config.cluster === "mainnet-beta" && mainnet !== "MAINNET")
        throw new Error("Type MAINNET to confirm this batch");
      if (!navigator.locks)
        throw new Error(
          "Use a browser with Web Locks support for serialized wallet approvals",
        );
      const p = batch,
        mark = epoch.current;
      setBatch(null);
      stopRequested.current = false;
      await navigator.locks.request(
        runKey,
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error(
              "Another tab is already handling this wallet. Finish or close its pending request before retrying here.",
            );
          const { entries, persist } = await checkedJournal();
          const current = readRun(localStorage.getItem(runKey));
          const nextRun = reserveRun(
            current,
            p.deposit,
            BigInt(config.maxDeposit),
            config.maxTransactions,
            p.transactions.length,
          );
          await chainCheck(rpc(), config);
          if (
            (await rpc().getBlockHeight({ commitment: "confirmed" }).send()) >=
            p.transactions[0].lastValidBlockHeight
          )
            throw new Error("Preview expired; prepare again before signing");
          setMessage("Waiting for Phantom to return your signed batch…");
          const signed = await wallet.signAll(
            p.transactions.map((t) => t.wire),
            config.cluster,
          );
          setMessage(
            "Phantom returned the batch. Checking instructions and signatures…",
          );
          const signatures = await assertSignedBatch(p, signed);
          setRun(nextRun);
          localStorage.setItem(runKey, JSON.stringify(nextRun));
          const start = entries.length;
          entries.push(
            ...p.transactions.map((t, i) => ({
              label: t.operation.label,
              status: "signed; not submitted",
              signature: signatures[i],
              account: t.operation.account,
              operation: t.operation.kind,
              reclaim: t.operation.reclaim.toString(),
              expectedHash: t.operation.expectedHash,
              refundRecipient: t.operation.refundRecipient,
              lastValidBlockHeight: t.lastValidBlockHeight.toString(),
            })),
          );
          persist();
          setMessage(
            "Signatures verified. Broadcasting the batch and waiting for finalized confirmation…",
          );
          await submitBatch(
            rpc(),
            p,
            signed,
            (i, status, signature) => {
              entries[start + i] = { ...entries[start + i], status, signature };
              persist();
            },
            () =>
              !stopRequested.current &&
              mark === epoch.current &&
              walletRef.current?.account.address === p.authority,
          );
        },
      );
      setEstimate(null);
      await refreshAccounts();
      setConfirmed(false);
      setMessage(
        p.transactions.length === 1
          ? "Transaction finalized. Prepare the next batch to continue."
          : `Batch finalized: ${p.transactions.length} transactions. Prepare the next batch to continue.`,
      );
    });
  }
  async function prepareDelegated() {
    await perform(async () => {
      if (!wallet || !config || !prepared)
        throw new Error("Connect Phantom and select a payload first");
      invalidate();
      setMessage(
        "Checking devnet balance, rent and simulation. Next, review the budget; Phantom opens only after you approve it below.",
      );
      const mark = epoch.current;
      await checkedJournal();
      const signer = await generateKeyPairSigner(false);
      const plan = await prepareSession(
        rpc(),
        config,
        address(wallet.account.address),
        signer.address,
        deployment,
        prepared.id,
        prepared.manifest,
      );
      reserveRun(
        readRun(localStorage.getItem(runKey)),
        plan.batch.deposit,
        BigInt(config.maxDeposit),
        config.maxTransactions,
        plan.reservedTransactions,
      );
      if (mark !== epoch.current)
        throw new Error("Selection changed; prepare again");
      sessionKey.current = signer;
      activeSession.current = plan;
      setSessionStarted(false);
      setSessionReview(plan);
      setMessage(
        "Review the complete session budget. One Phantom approval starts the automatic upload.",
      );
    });
  }
  async function startDelegated(resume = false) {
    await perform(async () => {
      const plan = activeSession.current,
        signer = sessionKey.current;
      if (
        !wallet ||
        !config ||
        !prepared ||
        !plan ||
        !signer ||
        plan.owner !== wallet.account.address ||
        plan.id !== deployment ||
        plan.hash !== prepared.id
      )
        throw new Error(
          "Session context changed. Revoke the old session in Withdraw before replacing it.",
        );
      if (!resume && (!sessionConfirmed || sessionReview !== plan))
        throw new Error("Review and confirm the session budget first");
      if (!navigator.locks)
        throw new Error("This browser needs Web Locks support");
      const mark = epoch.current;
      stopRequested.current = false;
      const current = () =>
        !stopRequested.current &&
        epoch.current === mark &&
        walletRef.current?.account.address === plan.owner;
      setMessage("Checking the upload lock and previous transactions…");
      await navigator.locks.request(
        runKey,
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error(
              "Another tab is already handling this wallet. Finish or close its pending request before retrying here.",
            );
          const { entries, persist } = await checkedJournal();
          setMessage("Checking devnet and the setup transaction’s expiry…");
          const starts = new Map<BatchPreview, number>();
          const status = (
            batch: BatchPreview,
            i: number,
            state: string,
            sig: string,
          ) => {
            if (!starts.has(batch)) {
              if (batch !== plan.batch) {
                const reserved = reserveRun(
                  readRun(localStorage.getItem(runKey)),
                  0n,
                  BigInt(config.maxDeposit),
                  config.maxTransactions,
                  batch.transactions.length,
                );
                localStorage.setItem(runKey, JSON.stringify(reserved));
                setRun(reserved);
              }
              starts.set(batch, entries.length);
              entries.push(
                ...batch.transactions.map((t) => ({
                  label: t.operation.label,
                  status: "prepared",
                  account: t.operation.account,
                  operation: t.operation.kind,
                  reclaim: t.operation.reclaim.toString(),
                  expectedHash: t.operation.expectedHash,
                  refundRecipient: t.operation.refundRecipient,
                  lastValidBlockHeight: t.lastValidBlockHeight.toString(),
                })),
              );
            }
            const at = starts.get(batch)! + i;
            entries[at] = { ...entries[at], status: state, signature: sig };
            persist();
            setMessage(`${batch.transactions[i].operation.label}: ${state}`);
          };
          if (!resume) {
            const currentRun = readRun(localStorage.getItem(runKey));
            reserveRun(
              currentRun,
              plan.batch.deposit,
              BigInt(config.maxDeposit),
              config.maxTransactions,
              plan.reservedTransactions,
            );
            const next = reserveRun(
              currentRun,
              plan.batch.deposit,
              BigInt(config.maxDeposit),
              config.maxTransactions,
              1,
            );
            await chainCheck(rpc(), config);
            if (
              !current() ||
              (await rpc()
                .getBlockHeight({ commitment: "confirmed" })
                .send()) >= plan.batch.transactions[0].lastValidBlockHeight
            )
              throw new Error(
                "Session preview expired or changed; prepare again",
              );
            setMessage(
              "Waiting for Phantom to return your signed setup. Confirm in the Phantom window.",
            );
            const signed = await wallet.signAll(
              plan.batch.transactions.map((t) => t.wire),
              config.cluster,
            );
            setMessage(
              "Phantom returned the signed setup. Checking its instructions and signature…",
            );
            await assertSignedBatch(plan.batch, signed);
            localStorage.setItem(runKey, JSON.stringify(next));
            setRun(next);
            setSessionStarted(true);
            setSessionReview(null);
            setMessage(
              "Signature verified. Broadcasting the setup through the devnet RPC…",
            );
            await submitBatch(
              rpc(),
              plan.batch,
              signed,
              (i, state, sig) => status(plan.batch, i, state, sig),
              current,
            );
          }
          await uploadSession(
            rpc(),
            config,
            plan,
            signer,
            prepared.manifest,
            async (index) =>
              fromBase64(
                (
                  await api<{ bytes: string }>("model", {
                    action: "shard",
                    id: prepared.id,
                    index,
                  })
                ).bytes,
              ),
            status,
            current,
          );
          if (current())
            setVerified(
              Object.fromEntries(
                prepared.manifest.shards.map((s) => [s.index, true]),
              ),
            );
          await refundSessionFees(rpc(), config, plan, signer, status, current);
          sessionKey.current = null;
          activeSession.current = null;
          setSessionStarted(false);
        },
      );
      await refreshAccounts();
      setMessage(
        "Delegated upload verified from Solana. Unused fee allowance returned. Withdraw can reclaim the session account and all storage rent.",
      );
    });
  }
  const sessionFeedback =
    config?.cluster === "devnet" && mode === "upload" && !!prepared && !!wallet;
  const feedback = (
    <>
      {error && (
        <div ref={errorElement} tabIndex={-1} className="error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
    </>
  );
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <SlmLogo />
          <span className="brand-label">
            SLM <span className="muted">/</span> onchain
          </span>
        </div>
        <div className="row">
          <span className="badge">
            {recoveryOnly ? "Independent recovery" : "Local operator console"}
          </span>
          <button
            onClick={() => void (wallet ? perform(disconnect) : connect())}
            disabled={busy}
          >
            {wallet ? "Disconnect Phantom" : "Connect Phantom"}
          </button>
        </div>
      </header>
      <section className="hero">
        <div>
          <p className="eyebrow">Solana Language Model</p>
          <h1>
            {mode === "upload"
              ? "Weights onchain. Control in your wallet."
              : "Recover your storage deposit."}
          </h1>
          <p className="muted">
            {mode === "upload"
              ? "Select, commit, and verify model weights on Solana."
              : "Discover storage accounts, close them, and verify every refund."}
          </p>
        </div>
        <span className="badge">
          {config?.cluster || "Loading configuration"}
        </span>
      </section>
      {config?.cluster === "mainnet-beta" && (
        <div className="notice">
          <strong>MAINNET — real SOL is at risk.</strong> Start with synthetic
          bytes and full rent recovery. Large deposits require independent
          security review.
        </div>
      )}
      {config && !config.program && (
        <div className="notice">
          No storage program is configured for {config.cluster}. Build and test
          the Rust program, deploy with an external signer, then pin its public
          address with <code>npm run configure-program</code>. Signing stays
          disabled until configuration is complete.
        </div>
      )}
      <div className="statusbar">
        <div>
          <small>Connected wallet / refund recipient</small>
          <code>{wallet?.account.address || "Not connected"}</code>
        </div>
        <div>
          <small>Finalized wallet balance</small>
          <strong>{balance === null ? "—" : `${sol(balance)} SOL`}</strong>
        </div>
        <div>
          <small>RPC endpoint · credential path redacted</small>
          <code>{config?.rpcDisplay || "—"}</code>
          <small>Program: {config?.program || "Not configured"}</small>
        </div>
      </div>
      {!recoveryOnly && (
        <nav className="tabs" aria-label="Primary modes">
          <button
            className={mode === "upload" ? "active" : ""}
            disabled={busy}
            onClick={() => {
              invalidate();
              setMode("upload");
            }}
          >
            ↑ Upload
          </button>
          <button
            className={mode === "withdraw" ? "active" : ""}
            disabled={busy}
            onClick={() => {
              invalidate();
              setMode("withdraw");
              setSelectedAccounts(new Set(accounts.map((a) => a.address)));
            }}
          >
            ↓ Withdraw
          </button>
        </nav>
      )}
      {!sessionFeedback && mode !== "withdraw" && feedback}
      <div className="grid">
        <div>
          {mode === "upload" ? (
            <>
              <section className="panel">
                <h2>
                  <span className="section-number">01</span>Choose a checkpoint
                </h2>
                <div className="two">
                  <label className="stack">
                    Hugging Face repository
                    <input
                      value={repo}
                      disabled={busy}
                      onChange={(e) => setRepo(e.target.value)}
                    />
                  </label>
                  <label className="stack">
                    Revision (optional)
                    <input
                      value={revision}
                      disabled={busy}
                      placeholder="main → pinned commit"
                      onChange={(e) => setRevision(e.target.value)}
                    />
                  </label>
                </div>
                <div className="row" style={{ marginTop: 16 }}>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const r = await api<Resolved>("model", {
                          action: "resolve",
                          repo,
                          revision: revision || "main",
                        });
                        setResolved(r);
                        setModel(null);
                        setSelected(new Set());
                        invalidate();
                        setPrepared(null);
                        setFiles(
                          new Set(
                            r.files
                              .filter((f) => f.name.endsWith(".safetensors"))
                              .map((f) => f.name),
                          ),
                        );
                      })
                    }
                  >
                    Inspect repository
                  </button>
                  <button
                    disabled={busy || !wallet}
                    onClick={() =>
                      void perform(async () =>
                        choosePrepared(
                          await api<Prepared>("model", { action: "synthetic" }),
                        ),
                      )
                    }
                  >
                    Use tiny synthetic proof
                  </button>
                </div>
                <p className="muted" style={{ marginTop: 14 }}>
                  Private/gated access uses server-only HF_TOKEN. Remote model
                  code is never executed.
                </p>
                {resolved && (
                  <>
                    <p className="mono">Pinned: {resolved.revision}</p>
                    <div className="file-list">
                      {resolved.files
                        .filter((f) => /\.(safetensors|gguf)$/.test(f.name))
                        .map((f) => (
                          <label key={f.name}>
                            <input
                              type="checkbox"
                              disabled={busy}
                              checked={files.has(f.name)}
                              onChange={(e) => {
                                setFiles((s) => {
                                  const n = new Set(s);
                                  if (e.target.checked) n.add(f.name);
                                  else n.delete(f.name);
                                  return n;
                                });
                                setModel(null);
                              }}
                            />
                            <span className="grow mono">{f.name}</span>
                            <span className="muted">{bytes(f.size)}</span>
                          </label>
                        ))}
                    </div>
                    <button
                      disabled={busy || !files.size}
                      onClick={() =>
                        void perform(async () => {
                          invalidate();
                          setPrepared(null);
                          setModel(null);
                          const input = {
                            repo: resolved.repo,
                            revision: resolved.revision,
                            files: [...files],
                          };
                          let j = await api<{
                            id: string;
                            done: boolean;
                            bytes: number;
                            total: number;
                            file: string;
                            error?: string;
                          }>("model", { action: "download", ...input });
                          setJob(j);
                          while (!j.done) {
                            await new Promise((r) => setTimeout(r, 1000));
                            j = await api("model", { action: "job", id: j.id });
                            setJob(j);
                          }
                          if (j.error) throw new Error(j.error);
                          const m = await api<Model>("model", {
                            action: "inspect",
                            ...input,
                          });
                          setModel(m);
                          setSelected(
                            new Set(
                              m.tensors
                                .filter(
                                  (t) => t.role === "transformer" && t.length,
                                )
                                .map((t) => t.id),
                            ),
                          );
                          setJob(null);
                        })
                      }
                    >
                      Download & inspect selected files
                    </button>
                  </>
                )}
                {job && (
                  <div style={{ marginTop: 16 }}>
                    <progress value={job.bytes} max={job.total || 1} />
                    <small>
                      {bytes(job.bytes)} / {bytes(job.total)} · {job.file}
                    </small>
                  </div>
                )}
              </section>
              {model && (
                <section className="panel">
                  <h2>
                    <span className="section-number">02</span>Select tensors
                  </h2>
                  <div className="row controls">
                    <button
                      disabled={busy}
                      onClick={() =>
                        setSelected(
                          new Set(
                            model.tensors
                              .filter((t) => t.length)
                              .map((t) => t.id),
                          ),
                        )
                      }
                    >
                      All supported
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setSelected(new Set())}
                    >
                      Clear
                    </button>
                    <input
                      aria-label="Layer range"
                      value={range}
                      onChange={(e) => setRange(e.target.value)}
                    />
                    <button
                      disabled={busy}
                      onClick={() => {
                        const m = range.match(/^(\d+)(?:-(\d+))?$/);
                        if (!m) {
                          setError(
                            "Enter a layer or inclusive range, for example 0-3",
                          );
                          return;
                        }
                        setSelected(
                          new Set(
                            model.tensors
                              .filter(
                                (t) =>
                                  t.layer !== null &&
                                  t.layer >= Number(m[1]) &&
                                  t.layer <= Number(m[2] || m[1]) &&
                                  t.length,
                              )
                              .map((t) => t.id),
                          ),
                        );
                      }}
                    >
                      Select layers
                    </button>
                  </div>
                  <div className="row" style={{ margin: "16px 0" }}>
                    <input
                      className="grow"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Filter tensor names"
                    />
                    <span className="selected">
                      {selectedTensors.length} tensors · {bytes(selectedBytes)}
                    </span>
                  </div>
                  <p className="muted">
                    Embeddings default to offchain learned weights. Required
                    quantization dependencies are included automatically;
                    original headers and configuration are also committed.
                  </p>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Select / tensor</th>
                          <th>Layer / format</th>
                          <th>Shape / size</th>
                        </tr>
                      </thead>
                      <tbody>
                        {model.tensors
                          .filter((t) => t.name.includes(query))
                          .map((t) => (
                            <tr key={t.id}>
                              <td>
                                <label>
                                  <input
                                    type="checkbox"
                                    disabled={busy || !t.length}
                                    checked={selectedTensors.some(
                                      (s) => s.id === t.id,
                                    )}
                                    onChange={(e) =>
                                      setSelected((s) => {
                                        const n = new Set(s);
                                        if (e.target.checked) n.add(t.id);
                                        else {
                                          n.delete(t.id);
                                          for (const v of model.tensors)
                                            if (v.dependencies.includes(t.id))
                                              n.delete(v.id);
                                        }
                                        return n;
                                      })
                                    }
                                  />
                                  <code>{t.name}</code>
                                </label>
                                <small>{t.role}</small>
                              </td>
                              <td>
                                {t.layer ?? "—"} · {t.format}
                                <small>{t.dtype}</small>
                              </td>
                              <td>
                                {t.shape.join(" × ")}
                                <small>{bytes(t.length)}</small>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    className="primary"
                    style={{ marginTop: 16 }}
                    disabled={busy || !wallet || !selectedTensors.length}
                    onClick={() =>
                      void perform(async () =>
                        choosePrepared(
                          await api<Prepared>("model", {
                            action: "prepare",
                            id: model.id,
                            tensors: selectedTensors.map((t) => t.id),
                          }),
                        ),
                      )
                    }
                  >
                    Commit selection & prepare manifest
                  </button>
                </section>
              )}
              {prepared && (
                <section className="panel">
                  <h2>
                    <span className="section-number">03</span>Deployment
                  </h2>
                  <p>{prepared.manifest.source.repo}</p>
                  <div className="stats">
                    <div>
                      <small>Exact payload</small>
                      <strong>{bytes(prepared.manifest.payloadBytes)}</strong>
                    </div>
                    <div>
                      <small>Weight shards</small>
                      <strong>{prepared.manifest.shards.length}</strong>
                    </div>
                    <div>
                      <small>Verified shards</small>
                      <strong>
                        {Object.values(verified).filter(Boolean).length}
                      </strong>
                    </div>
                  </div>
                  <p className="mono">Deployment: {deployment}</p>
                  <p className="mono">Manifest SHA-256: {prepared.id}</p>
                  {!readyToVerify && (
                    <p className="notice">
                      {registry || sessionStarted
                        ? "Upload unfinished. Continue the upload before verifying."
                        : "Manifest prepared locally. Upload it to Solana next."}{" "}
                      Verification becomes available after the upload is sealed
                      on Solana.
                    </p>
                  )}
                  <div className="row">
                    {config?.cluster === "devnet" &&
                      !readyToVerify &&
                      !sessionStarted && (
                        <button
                          className="primary"
                          disabled={busy || !wallet || !config.program}
                          onClick={() =>
                            sessionReview
                              ? sessionReviewElement.current?.focus()
                              : void prepareDelegated()
                          }
                        >
                          {sessionReview
                            ? "View upload budget"
                            : "Review one-approval upload"}
                        </button>
                      )}
                    <button
                      disabled={busy}
                      onClick={() =>
                        downloadJson(
                          `slm-${prepared.id}.json`,
                          prepared.manifest,
                        )
                      }
                    >
                      Export manifest
                    </button>
                    <button
                      disabled={
                        busy || !wallet || !config?.program || !readyToVerify
                      }
                      onClick={() =>
                        void perform(async () => {
                          await verifyDeployment(
                            rpc(),
                            address(config!.program!),
                            address(wallet!.account.address),
                            deployment,
                            prepared.id,
                            prepared.manifest,
                            (index, ok) =>
                              setVerified((v) => ({ ...v, [index]: ok })),
                          );
                          setMessage(
                            "All shards verified at finalized commitment.",
                          );
                        })
                      }
                    >
                      Verify from Solana
                    </button>
                  </div>
                  {Object.keys(verified).length > 0 && (
                    <details>
                      <summary>Per-shard verification</summary>
                      <pre>
                        {Object.entries(verified)
                          .map(
                            ([i, ok]) =>
                              `Shard ${i}: ${ok ? "verified" : "FAILED"}`,
                          )
                          .join("\n")}
                      </pre>
                    </details>
                  )}
                </section>
              )}
            </>
          ) : (
            <section className="panel">
              <div className="row spread">
                <h2>Wallet storage accounts</h2>
                <button
                  disabled={busy || !wallet || !config?.program}
                  onClick={() =>
                    void perform(async () => {
                      await refreshAccounts();
                      setMessage(
                        "Discovery completed from finalized onchain state.",
                      );
                    })
                  }
                >
                  Rescan Solana
                </button>
              </div>
              <p className="muted">
                Recovery needs no model files or manifest and includes partial
                uploads. Close All prepares a refund preview; review it, then
                sign in Phantom. Shards close before their registry, so complete
                each batch until no accounts remain.
              </p>
              <div className="stats">
                <div>
                  <small>Discovered</small>
                  <strong>{accounts.length}</strong>
                </div>
                <div>
                  <small>Selected refundable lamports</small>
                  <strong>{reclaim.toString()}</strong>
                </div>
                <div>
                  <small>Selected SOL</small>
                  <strong>{sol(reclaim)}</strong>
                </div>
              </div>
              <div className="row" style={{ marginBottom: 16 }}>
                <button
                  disabled={busy || !wallet || !config?.program}
                  onClick={() => void prepareBatch(true)}
                >
                  Close All / Reclaim All
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    invalidate();
                    setSelectedAccounts(new Set());
                  }}
                >
                  Clear selection
                </button>
              </div>
              {accounts.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Account / deployment</th>
                        <th>Allocated / state</th>
                        <th>Reclaimable SOL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts.map((a) => (
                        <tr key={a.address}>
                          <td>
                            <label>
                              <input
                                type="checkbox"
                                disabled={busy || !a.recoverable}
                                checked={selectedAccounts.has(a.address)}
                                onChange={(e) => {
                                  invalidate();
                                  setSelectedAccounts((s) => {
                                    const n = new Set(s);
                                    if (e.target.checked) n.add(a.address);
                                    else n.delete(a.address);
                                    return n;
                                  });
                                }}
                              />
                              {a.header.kind === 1
                                ? "Registry"
                                : a.header.kind === 3
                                  ? "Upload session / unused rent budget"
                                  : `Shard ${a.header.index}`}
                            </label>
                            <code>{a.address}</code>
                            <small>Deployment {a.header.id}</small>
                            <small>Owner {a.owner}</small>
                            <small>Authority {a.header.authority}</small>
                          </td>
                          <td>
                            {bytes(a.space)}
                            <small>
                              {a.header.state === 2
                                ? "withdrawing"
                                : a.header.state === 1
                                  ? "finalized"
                                  : "partial"}
                            </small>
                            <small>
                              {a.recoverable ? "Recoverable" : a.reason}
                            </small>
                          </td>
                          <td>
                            {sol(a.lamports)}
                            <small>{a.lamports.toString()} lamports</small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">
                  {wallet
                    ? "No accounts discovered. Rescan to refresh the finalized inventory."
                    : "Connect Phantom to discover your storage accounts."}
                </div>
              )}
            </section>
          )}
        </div>
        <aside>
          <section className="panel">
            <p className="eyebrow">
              {mode === "upload" ? "Upload" : "Withdrawal"} · wallet approval
            </p>
            <h2>Review each signed batch</h2>
            <p className="muted">
              Review the total deposit, fees, and refunds before each wallet
              request. Resume from finalized account state.
            </p>
            {mode === "withdraw" && feedback}
            {config?.cluster === "devnet" &&
              mode === "upload" &&
              prepared &&
              wallet && (
                <section aria-label="Delegated devnet upload">
                  <h3>One approval · devnet trial</h3>
                  <p className="muted">
                    Phantom remains the owner. A temporary browser key uploads
                    within an onchain budget and expiry. Revoke it and reclaim
                    rent in Withdraw, even after closing this tab.
                  </p>
                  <button
                    disabled={busy || !config.program || readyToVerify}
                    onClick={() => void prepareDelegated()}
                  >
                    Prepare one-approval upload
                  </button>
                  {sessionStarted && (
                    <button
                      disabled={busy}
                      onClick={() => void startDelegated(true)}
                    >
                      Resume delegated upload
                    </button>
                  )}
                  {sessionReview && (
                    <div
                      ref={sessionReviewElement}
                      tabIndex={-1}
                      aria-label="Review upload budget"
                    >
                      <p className="notice">
                        Preview ready. Review the amounts, check the box, then
                        click Approve once in Phantom and upload to open your
                        wallet.
                      </p>
                      <Item
                        label="Total funded now"
                        value={`${sol(sessionReview.batch.deposit)} SOL`}
                      />
                      <Item
                        label="Storage rent budget"
                        value={`${sol(sessionReview.budget)} SOL`}
                      />
                      <Item
                        label="Maximum storage/session funds held"
                        value={`${sol(sessionReview.batch.held + sessionReview.batch.deposit - sessionReview.allowance)} SOL`}
                      />
                      <Item
                        label="Owner balance after setup"
                        value={`${sol(sessionReview.batch.balance - sessionReview.batch.deposit - sessionReview.batch.fee)} SOL`}
                      />
                      <Item
                        label="Browser fee allowance · maximum loss if key is lost"
                        value={`${sol(sessionReview.allowance)} SOL`}
                      />
                      <Item
                        label="Setup network fee"
                        value={`${sol(sessionReview.batch.fee)} SOL`}
                      />
                      <Item
                        label="Maximum upload operations"
                        value={String(sessionReview.maxOperations)}
                      />
                      <Item
                        label="Expires at Solana slot"
                        value={String(sessionReview.expires)}
                      />
                      <div className="preview-address">
                        Owner / rent recipient: {sessionReview.owner}
                      </div>
                      <div className="preview-address">
                        Temporary delegate: {sessionReview.delegate}
                      </div>
                      <div className="preview-address">
                        Session / rent vault: {sessionReview.session}
                      </div>
                      <details>
                        <summary>Exact setup instruction</summary>
                        <pre>
                          {JSON.stringify(
                            {
                              program: sessionReview.batch.program,
                              accounts:
                                sessionReview.batch.transactions[0].operation
                                  .instruction.accounts,
                              dataHex: hex(
                                Uint8Array.from(
                                  sessionReview.batch.transactions[0].operation
                                    .instruction.data!,
                                ),
                              ),
                            },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={sessionConfirmed}
                          onChange={(e) =>
                            setSessionConfirmed(e.target.checked)
                          }
                        />
                        I authorize this entire devnet upload budget. The
                        browser key is held only in memory; losing it can lose
                        the fee allowance, but Phantom can recover the storage
                        rent.
                      </label>
                      <button
                        className="primary"
                        disabled={busy || !sessionConfirmed}
                        onClick={() => void startDelegated()}
                      >
                        Approve once in Phantom and upload
                      </button>
                    </div>
                  )}
                  {feedback}
                  <div className="divider" />
                </section>
              )}
            {estimate && mode === "upload" && (
              <>
                <h3>Whole deployment estimate</h3>
                <Item
                  label="Expected recoverable deposit"
                  value={`${sol(estimate.rent)} SOL`}
                />
                <Item
                  label="Nonrefundable fees"
                  value={`≈ ${sol(estimate.fees)} SOL`}
                />
                <Item
                  label="Remaining wallet outlay"
                  value={`${sol(estimate.deposit + estimate.fees)} SOL`}
                />
                <Item
                  label="Balance after full upload"
                  value={`${sol(estimate.balanceAfter)} SOL`}
                />
                <p className="muted">
                  {estimate.transactions} transactions ·{" "}
                  {usd(estimate.deposit + estimate.fees)}. Reflects finalized
                  account state; each batch quotes its exact new deposit.
                </p>
                <details>
                  <summary>Exact derived accounts & allocations</summary>
                  <pre>
                    {estimate.accounts
                      .map(
                        (a) =>
                          `${a.address}\n${a.size} bytes · ${a.rent} lamports`,
                      )
                      .join("\n\n")}
                  </pre>
                </details>
                <div className="divider" />
              </>
            )}
            <Item label="Held in wallet storage" value={`${sol(held)} SOL`} />
            <Item
              label="New-deposit cap / run"
              value={`${config ? sol(BigInt(config.maxDeposit)) : "—"} SOL`}
            />
            <Item
              label="Used / transaction cap"
              value={`${run.transactions} / ${config?.maxTransactions ?? "—"}`}
            />
            <Item
              label="Reserved deposits this run"
              value={`${sol(BigInt(run.deposit))} SOL`}
            />
            <label className="field">
              Transactions per approval
              <select
                aria-label="Transactions per approval"
                disabled={busy}
                value={batchSize}
                onChange={(e) => {
                  setBatchSize(Number(e.target.value));
                  invalidate();
                }}
              >
                {[1, 4, 8, 16].map((n) => (
                  <option key={n} value={n}>
                    Up to {n}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              One wallet request per batch. Phantom may show multiple review
              screens. Transactions expire; unfinished work needs a fresh
              preview and signature.
            </p>
            {batch && (
              <div
                ref={batchReviewElement}
                tabIndex={-1}
                role="region"
                aria-label={
                  mode === "withdraw"
                    ? "Review refund batch"
                    : "Review transaction batch"
                }
              >
                <div className="divider" />
                <h3>
                  {batch.transactions.length === 1
                    ? batch.transactions[0].operation.label
                    : `Review ${batch.transactions.length} transactions`}
                </h3>
                <span className="pill">
                  {batch.transactions.length === 1
                    ? "Simulation passed · prepared"
                    : `All ${batch.transactions.length} simulations passed · prepared`}
                </span>
                <div className="preview-address">Program: {batch.program}</div>
                <div className="preview-address">
                  Fee payer / refund recipient: {batch.authority}
                </div>
                <Item
                  label="New refundable deposit · entire batch"
                  value={`${sol(batch.deposit)} SOL`}
                />
                <Item
                  label="Reclaimable · entire batch"
                  value={`${sol(batch.reclaim)} SOL`}
                />
                <Item
                  label="Nonrefundable fees · entire batch"
                  value={`${sol(batch.fee)} SOL`}
                />
                <Item
                  label="Maximum deposit at risk during batch"
                  value={`${sol(batch.held + batch.deposit)} SOL`}
                />
                <Item
                  label="Expected wallet balance after batch"
                  value={`${sol(batch.balance - batch.deposit - batch.fee + batch.reclaim)} SOL`}
                />
                <details>
                  <summary>Exact transactions, accounts & instructions</summary>
                  {batch.transactions.map((p, i) => (
                    <div key={p.operation.account}>
                      <h4>
                        {i + 1}. {p.operation.label}
                      </h4>
                      <pre>
                        {JSON.stringify(
                          {
                            account: p.operation.account,
                            depositLamports: p.operation.deposit.toString(),
                            reclaimLamports: p.operation.reclaim.toString(),
                            feeLamports: p.fee.toString(),
                            program: p.program,
                            accounts: p.operation.instruction.accounts,
                            dataHex: hex(
                              Uint8Array.from(
                                p.operation.instruction.data || [],
                              ),
                            ),
                            transactionBytes: p.wire.length,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  ))}
                </details>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I reviewed the accounts, receiving wallet, refundable deposit,
                  and spent fee.
                </label>
                {config?.cluster === "mainnet-beta" && (
                  <input
                    aria-label="Mainnet confirmation"
                    placeholder="Type MAINNET"
                    value={mainnet}
                    onChange={(e) => setMainnet(e.target.value)}
                  />
                )}
                <button
                  className={mode === "withdraw" ? "danger" : "primary"}
                  style={{ width: "100%", marginTop: 12 }}
                  disabled={
                    busy ||
                    !confirmed ||
                    (config?.cluster === "mainnet-beta" &&
                      mainnet !== "MAINNET")
                  }
                  onClick={() => void signBatch()}
                >
                  {batch.transactions.length === 1
                    ? "Sign this transaction in Phantom"
                    : `Sign ${batch.transactions.length} transactions in Phantom`}
                </button>
              </div>
            )}
            <button
              style={{ width: "100%", marginTop: 16 }}
              disabled={
                busy ||
                !wallet ||
                !config?.program ||
                (mode === "upload" && !prepared)
              }
              onClick={() => void prepareBatch()}
            >
              {busy ? "Working…" : "Prepare / resume next batch"}
            </button>
            <button
              style={{ width: "100%", marginTop: 10 }}
              disabled={!busy && !batch && !sessionReview && !sessionStarted}
              onClick={() => {
                stopRequested.current = true;
                invalidate();
                setMessage(
                  "Paused. Submitted transactions still settle. Recheck the journal before preparing another batch.",
                );
              }}
            >
              Pause / discard preview
            </button>
            <details>
              <summary>Run limits</summary>
              <p className="muted">
                Pending submissions count toward both limits. Do not reset
                counters to work around an unresolved transaction.
              </p>
              <button
                disabled={busy || !!batch}
                onClick={() =>
                  void perform(async () => {
                    await checkedJournal();
                    const r = { deposit: "0", transactions: 0 };
                    setRun(r);
                    localStorage.setItem(runKey, JSON.stringify(r));
                    setMessage(
                      "New capped run started. Each batch still requires preview and Phantom signing.",
                    );
                  })
                }
              >
                Start a new capped run
              </button>
            </details>
            <div className="divider" />
            <p className="muted" style={{ fontSize: 12 }}>
              RPC lamports are authoritative. USD is informational and never
              promised as a refund.
            </p>
            <small className="muted">
              {quote?.timestamp
                ? `SOL/USD ${quote.stale ? "stale" : "quote"} · ${new Date(quote.timestamp).toLocaleTimeString()}`
                : "USD quote unavailable"}
            </small>
          </section>
          <section className="panel">
            <h3>Transaction journal</h3>
            <button
              disabled={busy || !wallet}
              onClick={() =>
                void perform(async () => {
                  await checkedJournal();
                  await refreshAccounts();
                  setMessage(
                    "Journal reconciled. Rescan and prepare the remaining work.",
                  );
                })
              }
            >
              Recheck pending transactions
            </button>
            <div className="log">
              {logs.length ? (
                logs.map((l, i) => (
                  <div key={i}>
                    <strong>{l.label}</strong>
                    <br />
                    {l.status}
                    {l.signature && (
                      <>
                        <br />
                        {l.signature}
                        <button
                          disabled={busy || !wallet}
                          onClick={() =>
                            void perform(async () => {
                              const r = rpc();
                              const sig = signature(l.signature!);
                              const status = (
                                await r
                                  .getSignatureStatuses([sig], {
                                    searchTransactionHistory: true,
                                  })
                                  .send()
                              ).value[0];
                              if (status?.err)
                                throw new Error(
                                  "Saved transaction failed onchain; rescan before retrying",
                                );
                              if (status?.confirmationStatus !== "finalized")
                                throw new Error(
                                  "Saved transaction is not finalized yet; rescan before retrying",
                                );
                              if (
                                l.operation === "close" &&
                                l.account &&
                                l.reclaim
                              )
                                await verifyClosure(
                                  r,
                                  {
                                    authority: address(wallet!.account.address),
                                    operation: {
                                      account: address(l.account),
                                      reclaim: BigInt(l.reclaim),
                                    },
                                  },
                                  sig,
                                );
                              setMessage(
                                l.operation === "close"
                                  ? "Saved closure receipt and refund verified at finalized commitment."
                                  : "Saved transaction finalized; rescan account state to continue.",
                              );
                            })
                          }
                        >
                          Check saved receipt
                        </button>
                      </>
                    )}
                  </div>
                ))
              ) : (
                <p className="muted">
                  Prepared → signed → submitted → finalized → verified
                </p>
              )}
            </div>
          </section>
        </aside>
      </div>
      <footer className="footer">
        SLM / Internal storage tooling · No custody · Wallet-authorized recovery
      </footer>
    </main>
  );
}
