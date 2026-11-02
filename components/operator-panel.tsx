"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import SlmLogo from "./slm-logo";
import RpcSettings from "./rpc-settings";
import ProgramSetup from "./program-setup";
import { api } from "@/lib/chain/client";
import { sol } from "@/lib/chain/protocol";
import type { Network } from "@/lib/operator/config";
import type { Mode, OperatorStatus, PublicJob } from "@/lib/operator/types";
type Catalog = {
  repo: string;
  revision: string;
  files: { name: string; size: number }[];
};
const size = (n: number) =>
  n < 1024
    ? `${n} bytes`
    : `${(n / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`;
const amount = (s: string) => sol(BigInt(s));
const networkKey = "slm:operator:network";
let rememberedNetwork: Network | undefined;
const networkListeners = new Set<() => void>();
function readNetwork() {
  if (!rememberedNetwork) {
    rememberedNetwork = "devnet";
    try {
      if (localStorage.getItem(networkKey) === "mainnet-beta")
        rememberedNetwork = "mainnet-beta";
    } catch {
      /* Storage restrictions must not disable the panel. */
    }
  }
  return rememberedNetwork;
}
function setNetwork(value: Network) {
  rememberedNetwork = value;
  try {
    localStorage.setItem(networkKey, value);
  } catch {
    /* Keep this tab usable. */
  }
  for (const listener of networkListeners) listener();
}
function subscribeNetwork(listener: () => void) {
  networkListeners.add(listener);
  return () => {
    networkListeners.delete(listener);
  };
}
const serverNetwork = () => null;
export default function OperatorPanel() {
  // Read storage only in the browser, before any network-specific request.
  // Other tabs cannot silently switch this tab's active operation/network.
  const savedNetwork = useSyncExternalStore(
    subscribeNetwork,
    readNetwork,
    serverNetwork,
  );
  const cluster = savedNetwork || "devnet";
  const [mode, setMode] = useState<Mode>("test");
  const [repo, setRepo] = useState(""),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [file, setFile] = useState("");
  const [status, setStatus] = useState<OperatorStatus | null>(null),
    [job, setJob] = useState<PublicJob | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [resolving, setResolving] = useState(false);
  const requested = useRef(""),
    hydrated = useRef(false),
    epoch = useRef(0),
    errorRef = useRef<HTMLParagraphElement>(null);
  const active = savedNetwork === null || status?.busy || loading;
  const unfinished =
    job?.approved && ["running", "paused", "failed"].includes(job.phase);
  const matchesSource =
    mode !== "upload" ||
    unfinished ||
    (job?.source?.repo === catalog?.repo &&
      job?.source?.revision === catalog?.revision &&
      job?.source?.file === file);
  const relevant =
    job?.cluster === cluster && job.mode === mode && matchesSource ? job : null;
  const refresh = useCallback(
    async (inventory = false) => {
      const mark = epoch.current;
      const value = await api<OperatorStatus>("operator", {
        action: "status",
        cluster,
        refresh: inventory,
      });
      if (mark !== epoch.current) return;
      setStatus(value);
      if (value.job) setJob(value.job);
      if (!hydrated.current) {
        hydrated.current = true;
        const program = value.programDeployment;
        if (
          program?.approved &&
          !["complete", "recovered"].includes(program.phase)
        ) {
          if (program.cluster !== cluster) {
            epoch.current++;
            setStatus(null);
          }
          setNetwork(program.cluster);
          setMode("test");
          return;
        }
        if (
          value.job?.approved &&
          !["complete", "ready"].includes(value.job.phase)
        ) {
          if (value.job.cluster !== cluster) {
            epoch.current++;
            setStatus(null);
          }
          setNetwork(value.job.cluster);
          setMode(value.job.mode);
          if (value.job.source) {
            setRepo(value.job.source.repo);
            setFile(value.job.source.file);
            setCatalog({
              repo: value.job.source.repo,
              revision: value.job.source.revision,
              files: [{ name: value.job.source.file, size: 0 }],
            });
          }
          requested.current = JSON.stringify([
            value.job.cluster,
            value.job.mode,
            value.owner,
            value.job.source?.revision,
            value.job.source?.file || "",
          ]);
        }
      }
    },
    [cluster],
  );
  useEffect(() => {
    if (savedNetwork === null) return;
    let live = true;
    const tick = () =>
      refresh().catch((e) => {
        if (live) setError(e.message);
      });
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [refresh, savedNetwork]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (mode !== "upload" || unfinished) return;
    let live = true;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo.trim())) return;
    const timer = setTimeout(async () => {
      setResolving(true);
      try {
        const found = await api<Catalog>("model", {
          action: "resolve",
          repo: repo.trim(),
        });
        if (!live) return;
        const files = found.files.filter((f) => f.name.endsWith(".gguf"));
        if (!files.length)
          throw new Error("This repository has no supported GGUF file");
        setCatalog({ ...found, files });
        if (files.length === 1) setFile(files[0].name);
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        if (live) setResolving(false);
      }
    }, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [repo, mode, cluster, unfinished]);
  const prepare = useCallback(async () => {
    const mark = epoch.current;
    requested.current = JSON.stringify([
      cluster,
      mode,
      status?.owner,
      catalog?.revision,
      file,
    ]);
    setError("");
    setLoading(true);
    try {
      const next = await api<PublicJob>("operator", {
        action: "prepare",
        cluster,
        mode,
        ...(mode === "upload"
          ? { repo: catalog!.repo, revision: catalog!.revision, file }
          : {}),
      });
      if (mark === epoch.current) {
        setJob(next);
        await refresh();
      }
    } catch (e) {
      if (mark === epoch.current) setError((e as Error).message);
    } finally {
      if (mark === epoch.current) setLoading(false);
    }
  }, [cluster, mode, catalog, file, refresh, status?.owner]);
  useEffect(() => {
    if (
      !status?.owner ||
      !status.program ||
      status.cluster !== cluster ||
      active ||
      (mode === "upload" && (!catalog || !file))
    )
      return;
    if (
      relevant?.approved &&
      ["paused", "failed", "running"].includes(relevant.phase)
    )
      return;
    const key = JSON.stringify([
      cluster,
      mode,
      status.owner,
      catalog?.revision,
      file,
    ]);
    if (requested.current === key) return;
    requested.current = key;
    void prepare();
  }, [status, cluster, mode, active, catalog, file, relevant, prepare]);
  function change(nextMode: Mode, nextCluster: Network) {
    if (nextMode === mode && nextCluster === cluster) return;
    epoch.current++;
    requested.current = "";
    setError("");
    setJob(null);
    setLoading(false);
    setStatus(null);
    setCatalog(null);
    setFile("");
    setResolving(false);
    setMode(nextMode);
    setNetwork(nextCluster);
  }
  async function primary() {
    if (!relevant) return;
    if (
      relevant.phase === "complete" ||
      (!relevant.approved && ["failed", "paused"].includes(relevant.phase))
    ) {
      await prepare();
      return;
    }
    setLoading(true);
    setError("");
    try {
      setJob(
        await api<PublicJob>("operator", {
          action: "start",
          cluster,
          id: relevant.id,
        }),
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function programAction(
    action: "programPrepare" | "programStart" | "programRecover" | "pause",
    id?: string,
  ) {
    setLoading(true);
    setError("");
    try {
      await api("operator", { action, cluster, ...(id ? { id } : {}) });
      if (action === "programPrepare") {
        setMode("test");
        requested.current = "";
      }
      await refresh(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  const ready =
    relevant &&
    (["ready", "complete"].includes(relevant.phase) ||
      ["paused", "failed"].includes(relevant.phase));
  const progressLabel =
    mode === "test"
      ? "Test progress"
      : mode === "upload"
        ? "Upload progress"
        : "Withdrawal progress";
  return (
    <main className="operator">
      <header className="operator-header">
        <div className="operator-brand">
          <SlmLogo />
          <span>
            SLM <small>onchain</small>
          </span>
        </div>
        <div
          className="operator-network"
          role="group"
          aria-label="Solana network"
        >
          {(["devnet", "mainnet-beta"] as const).map((n) => (
            <button
              key={n}
              aria-pressed={cluster === n}
              disabled={!!active}
              onClick={() => change(mode, n)}
            >
              {n === "devnet" ? "Devnet" : "Mainnet"}
            </button>
          ))}
        </div>
      </header>
      <nav className="operator-tabs" aria-label="Mode">
        {(["test", "upload", "withdraw"] as const).map((m) => (
          <button
            key={m}
            aria-current={mode === m ? "page" : undefined}
            disabled={!!active}
            onClick={() => change(m, cluster)}
          >
            {m === "test" ? "Test" : m === "upload" ? "Upload" : "Withdraw"}
          </button>
        ))}
      </nav>
      <h1>
        {mode === "test"
          ? "Try the full round trip."
          : mode === "upload"
            ? "Put your weights onchain."
            : "Get your rent back."}
      </h1>
      <p className="operator-subtitle">
        {mode === "test"
          ? "Upload 78 bytes, verify them, then reclaim the deposit."
          : mode === "upload"
            ? "Choose a GGUF. Transformer weights go onchain; embeddings stay offchain."
            : "Close your local wallet’s storage accounts and return their SOL."}
      </p>
      {cluster === "mainnet-beta" && (
        <p className="operator-network-note">
          MAINNET · Real SOL. Start with Test before a model upload.
        </p>
      )}
      {status?.rpc && status.owner && (
        <RpcSettings
          key={`${cluster}:${JSON.stringify(status.rpc)}`}
          initial={status.rpc}
          disabled={!!active}
          save={async (policy) => {
            setError("");
            setLoading(true);
            try {
              await api("operator", {
                action: "rpcSettings",
                cluster,
                ...policy,
              });
              await refresh(true);
            } finally {
              setLoading(false);
            }
          }}
        />
      )}
      {mode === "upload" && (
        <section className="operator-inputs">
          <label>
            Hugging Face repository
            <input
              aria-label="Hugging Face repository"
              placeholder="owner/model-GGUF"
              value={
                unfinished && relevant?.source ? relevant.source.repo : repo
              }
              disabled={!!active || !!(unfinished && relevant)}
              onChange={(e) => {
                requested.current = "";
                setJob(null);
                setError("");
                setCatalog(null);
                setFile("");
                setResolving(false);
                setRepo(e.target.value);
              }}
            />
          </label>
          <label>
            GGUF file
            <select
              aria-label="GGUF file"
              value={file}
              disabled={!!active || !catalog || !!(unfinished && relevant)}
              onChange={(e) => {
                requested.current = "";
                setJob(null);
                setFile(e.target.value);
              }}
            >
              <option value="">
                {resolving ? "Finding GGUF files…" : "Choose a quantization"}
              </option>
              {catalog?.files.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} · {size(f.size)}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}
      <section className="operator-info" aria-label="Operation information">
        <div className="operator-info-heading">
          <span>
            {active
              ? "Working"
              : relevant?.phase === "complete"
                ? "Complete"
                : "Information"}
          </span>
          <span>{cluster === "devnet" ? "Devnet" : "Mainnet"}</span>
        </div>
        {!status?.owner ? (
          <p>
            Set up your local signer with <code>npm run operator:setup</code>.
            Set <code>SLM_SIGNER_ENV_FILE</code> to your configuration file and
            configure <code>SLM_KEYPAIR_PATH</code> there, then reload.
          </p>
        ) : (
          <>
            <div className="operator-metric">
              <span>Wallet</span>
              <code className="operator-address">{status.owner}</code>
            </div>
            <div className="operator-metric">
              <span>Balance</span>
              <strong>{amount(status.balance)} SOL</strong>
            </div>
            <div className="operator-metric">
              <span>Recoverable rent</span>
              <strong>
                {amount(status.refundable)} SOL · {status.accounts} accounts
              </strong>
            </div>
            {!status.program && (
              <ProgramSetup
                cluster={cluster}
                job={status.programDeployment}
                busy={status.busy}
                loading={loading}
                balance={status.balance}
                action={(action, id) => void programAction(action, id)}
              />
            )}
            {relevant && (
              <>
                {mode === "withdraw" && (
                  <div className="operator-metric">
                    <span>Refund in this operation</span>
                    <strong>
                      {amount(relevant.expectedRefund)} SOL ·{" "}
                      {relevant.accounts.length} accounts
                    </strong>
                  </div>
                )}
                {mode !== "withdraw" && relevant.bytes > 0 && (
                  <div className="operator-metric">
                    <span>Selected data</span>
                    <strong>
                      {size(relevant.bytes)}
                      {relevant.tensors > 0
                        ? ` · ${relevant.tensors} tensors`
                        : ""}
                    </strong>
                  </div>
                )}
                {relevant.phase !== "preparing" && (
                  <>
                    {mode !== "withdraw" && (
                      <div className="operator-metric">
                        <span>Refundable deposit</span>
                        <strong>{amount(relevant.deposit)} SOL</strong>
                      </div>
                    )}
                    <div className="operator-metric">
                      <span>Estimated network fees</span>
                      <strong>{amount(relevant.estimatedFees)} SOL</strong>
                    </div>
                    <div className="operator-metric">
                      <span>Maximum fee budget</span>
                      <strong>{amount(relevant.feeBudget)} SOL</strong>
                    </div>
                    {mode !== "withdraw" && (
                      <div className="operator-metric">
                        <span>Maximum wallet outlay</span>
                        <strong>
                          {sol(
                            BigInt(relevant.deposit) +
                              BigInt(relevant.feeBudget),
                          )}{" "}
                          SOL
                        </strong>
                      </div>
                    )}
                  </>
                )}
                {relevant.downloadTotal ? (
                  <progress
                    aria-label="Model download"
                    value={relevant.downloadBytes || 0}
                    max={relevant.downloadTotal}
                  />
                ) : null}
                {relevant.operationProgress && (
                  <section
                    className="operator-upload-progress"
                    aria-label={`${progressLabel} details`}
                  >
                    <div className="operator-metric">
                      <span>{progressLabel}</span>
                      <strong>{relevant.operationProgress.percent}%</strong>
                    </div>
                    <progress
                      aria-label={progressLabel}
                      value={relevant.operationProgress.percent}
                      max={100}
                    />
                    {relevant.operationProgress.shards && (
                      <div className="operator-metric">
                        <span>Shards finalized</span>
                        <strong>
                          {relevant.operationProgress.shards.completed.toLocaleString()}{" "}
                          /{" "}
                          {relevant.operationProgress.shards.total.toLocaleString()}
                          <small>
                            {relevant.operationProgress.shards.remaining.toLocaleString()}{" "}
                            left
                          </small>
                        </strong>
                      </div>
                    )}
                    {relevant.operationProgress.accounts && (
                      <div className="operator-metric">
                        <span>Accounts closed</span>
                        <strong>
                          {relevant.operationProgress.accounts.completed.toLocaleString()}{" "}
                          /{" "}
                          {relevant.operationProgress.accounts.total.toLocaleString()}
                          <small>
                            {relevant.operationProgress.accounts.remaining.toLocaleString()}{" "}
                            left
                          </small>
                        </strong>
                      </div>
                    )}
                    <div className="operator-metric">
                      <span>Transactions completed</span>
                      <strong>
                        {relevant.operationProgress.transactions.completed.toLocaleString()}{" "}
                        /{" "}
                        {relevant.operationProgress.transactions.total.toLocaleString()}
                        <small>
                          {relevant.operationProgress.transactions.remaining.toLocaleString()}{" "}
                          left
                        </small>
                      </strong>
                    </div>
                    <small>
                      Counts update after finalization. 100% includes
                      verification.
                    </small>
                  </section>
                )}
                <p className="operator-progress" role="status">
                  {relevant.message}
                </p>
                {relevant.signedTransactions > 0 && (
                  <small>
                    {relevant.signedTransactions} transactions signed ·{" "}
                    {relevant.verifiedBytes} bytes verified ·{" "}
                    {amount(relevant.reclaimed)} SOL reclaimed
                  </small>
                )}
                {relevant.lastSignature && (
                  <a
                    className="operator-receipt"
                    target="_blank"
                    rel="noreferrer"
                    href={`https://explorer.solana.com/tx/${relevant.lastSignature}?cluster=${relevant.cluster}`}
                  >
                    Latest transaction ↗
                  </a>
                )}
              </>
            )}
          </>
        )}
        {(error || status?.error) && (
          <p
            className="operator-error"
            role="alert"
            ref={errorRef}
            tabIndex={-1}
          >
            {error || status?.error}
          </p>
        )}
      </section>
      <div
        className="operator-actions"
        hidden={!!status?.owner && !status.program}
      >
        {active ? (
          <button
            disabled={loading || !relevant}
            onClick={() =>
              void api<PublicJob>("operator", {
                action: "pause",
                cluster,
                id: relevant!.id,
              })
                .then(setJob)
                .catch((e) => setError(e.message))
            }
          >
            Pause
          </button>
        ) : (
          <button
            className="operator-primary"
            disabled={!ready || !status?.owner || !status.program}
            onClick={() => void primary()}
          >
            {relevant?.phase === "complete"
              ? "Prepare another run"
              : relevant?.approved &&
                  ["paused", "failed"].includes(relevant.phase)
                ? "Resume"
                : relevant?.phase === "failed"
                  ? "Retry preparation"
                  : mode === "test"
                    ? "Run test"
                    : mode === "upload"
                      ? "Deploy"
                      : "Withdraw all"}
          </button>
        )}
        {!active && relevant?.phase === "ready" && (
          <small>
            {mode === "withdraw"
              ? "One click closes the previewed accounts. Refunds go to the wallet above."
              : "One click authorizes this operation within the displayed budget."}
          </small>
        )}
      </div>
      <footer className="operator-footer">
        <span>◎_◎ · Local operator</span>
        <a href="http://127.0.0.1:3001">Phantom recovery ↗</a>
        <a href="/advanced">Advanced</a>
      </footer>
    </main>
  );
}
