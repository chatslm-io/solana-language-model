"use client";
import type { Network } from "@/lib/operator/config";
import type { PublicProgramJob } from "@/lib/operator/program-types";
import { sol } from "@/lib/chain/protocol";

export default function ProgramSetup({
  cluster,
  job,
  busy,
  loading,
  balance,
  action,
}: {
  cluster: Network;
  job?: PublicProgramJob | null;
  busy: boolean;
  loading: boolean;
  balance: string;
  action: (
    action: "programPrepare" | "programStart" | "programRecover" | "pause",
    id?: string,
  ) => void;
}) {
  const current = job?.cluster === cluster ? job : null;
  const quote = current && current.phase !== "recovered";
  const outlay = current
    ? BigInt(current.deposit) + BigInt(current.feeBudget)
    : 0n;
  const enough = BigInt(balance) >= outlay;
  const running = current?.phase === "running" && busy;
  return (
    <section
      className="operator-program"
      aria-label="Storage program deployment"
    >
      <h2>Set up the storage program</h2>
      <p>
        Deploy the reviewed SLM program once on this network. Your local wallet
        keeps upgrade authority. Model storage comes afterward.
      </p>
      {!quote ? (
        <>
          {current?.phase === "recovered" && (
            <p role="status">{current.message}</p>
          )}
          <button
            className="operator-primary"
            disabled={busy || loading}
            onClick={() => action("programPrepare")}
          >
            Deploy storage program
          </button>
          <small>First, review the live deposit and fee quote.</small>
        </>
      ) : (
        <>
          <div className="operator-metric">
            <span>Program address</span>
            <code className="operator-address">{current.program}</code>
          </div>
          <div className="operator-metric">
            <span>Program code deposit</span>
            <strong>{sol(BigInt(current.codeRent))} SOL</strong>
          </div>
          <div className="operator-metric">
            <span>Program ID deposit</span>
            <strong>{sol(BigInt(current.programRent))} SOL</strong>
          </div>
          <small>
            The program ID deposit is not reclaimed. Code rent requires retiring
            the program after all model storage is withdrawn.
          </small>
          <div className="operator-metric">
            <span>Temporary buffer deposit</span>
            <strong>{sol(BigInt(current.bufferRent))} SOL</strong>
          </div>
          <small>
            Reused during deployment; an unfinished buffer can be reclaimed
            below.
          </small>
          <div className="operator-metric">
            <span>Estimated network fees</span>
            <strong>{sol(BigInt(current.estimatedFees))} SOL</strong>
          </div>
          <div className="operator-metric">
            <span>Maximum fee budget</span>
            <strong>{sol(BigInt(current.feeBudget))} SOL</strong>
          </div>
          <div className="operator-metric">
            <span>Maximum wallet outlay</span>
            <strong>{sol(outlay)} SOL</strong>
          </div>
          <div className="operator-metric">
            <span>Program bytes verified</span>
            <strong>
              {current.writtenBytes.toLocaleString()} /{" "}
              {current.binaryBytes.toLocaleString()}
            </strong>
          </div>
          <progress
            aria-label="Program deployment progress"
            max={current.totalTransactions}
            value={current.completedTransactions}
          />
          <small>
            {current.completedTransactions} / {current.totalTransactions} steps
            · {current.transactions} transactions signed
          </small>
          <p role="status">{current.message}</p>
          {current.lastSignature && (
            <a
              className="operator-receipt"
              href={`https://explorer.solana.com/tx/${current.lastSignature}?cluster=${cluster}`}
              target="_blank"
              rel="noreferrer"
            >
              Latest program transaction ↗
            </a>
          )}
          {running ? (
            <button
              disabled={loading}
              onClick={() => action("pause", current.id)}
            >
              Pause program deployment
            </button>
          ) : (
            <>
              {!current.approved && !enough && (
                <p>
                  Fund the displayed wallet with at least {sol(outlay)} SOL
                  before deploying.
                </p>
              )}
              <button
                className="operator-primary"
                disabled={busy || loading || (!current.approved && !enough)}
                onClick={() =>
                  action(
                    current.intent === "recover"
                      ? "programRecover"
                      : "programStart",
                    current.id,
                  )
                }
              >
                {current.approved
                  ? current.intent === "recover"
                    ? "Resume buffer recovery"
                    : "Resume program deployment"
                  : cluster === "mainnet-beta"
                    ? "Approve and deploy program on mainnet"
                    : "Approve and deploy program on devnet"}
              </button>
              {(!current.approved || current.intent === "recover") && (
                <button
                  disabled={busy || loading}
                  onClick={() => action("programPrepare")}
                >
                  {current.intent === "recover"
                    ? "Refresh recovery quote"
                    : "Refresh deployment quote"}
                </button>
              )}
              {current.approved && (
                <>
                  <button
                    disabled={busy || loading}
                    onClick={() => action("programRecover", current.id)}
                  >
                    Reclaim unfinished buffer
                  </button>
                  <small>
                    Returns buffer rent to your wallet. Recovery fee limit:{" "}
                    {sol(
                      BigInt(current.recoveryFeeBudget) -
                        BigInt(current.recoveryFeesReserved),
                    )}{" "}
                    SOL remaining.
                  </small>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
