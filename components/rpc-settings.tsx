"use client";
import { useState } from "react";
import { rpcPolicy, type RpcPolicy } from "@/lib/chain/rpc-policy";
import type { RpcInfo } from "@/lib/operator/types";

export default function RpcSettings({
  initial,
  disabled,
  save,
}: {
  initial: RpcInfo;
  disabled: boolean;
  save: (policy: RpcPolicy) => Promise<void>;
}) {
  const [mode, setMode] = useState(initial.mode);
  const [rps, setRps] = useState(String(initial.rps));
  const [sendRps, setSendRps] = useState(String(initial.sendRps));
  const [scanRps, setScanRps] = useState(String(initial.scanRps));
  const [error, setError] = useState("");
  const changed =
    mode !== initial.mode ||
    Number(rps) !== initial.rps ||
    Number(sendRps) !== initial.sendRps ||
    Number(scanRps) !== initial.scanRps;
  async function apply() {
    setError("");
    try {
      await save(
        rpcPolicy({
          mode,
          rps: Number(rps),
          sendRps: Number(sendRps),
          scanRps: Number(scanRps),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <details className="operator-rpc">
      <summary>
        RPC ·{" "}
        {initial.mode === "free"
          ? "Free mode"
          : `Paid · ${initial.rps} requests/sec`}
      </summary>
      <fieldset disabled={disabled}>
        <legend>RPC speed</legend>
        <div className="operator-network" role="group" aria-label="RPC mode">
          {(["free", "paid"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
                setError("");
                if (value === "free") {
                  setRps(String(initial.rps));
                  setSendRps(String(initial.sendRps));
                  setScanRps(String(initial.scanRps));
                }
              }}
            >
              {value === "free" ? "Free RPC" : "Paid RPC"}
            </button>
          ))}
        </div>
        {mode === "paid" ? (
          <>
            <div className="operator-rpc-limits">
              <label>
                RPC requests / sec
                <input
                  aria-label="RPC requests per second"
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  value={rps}
                  onChange={(e) => setRps(e.target.value)}
                />
              </label>
              <label>
                Transaction sends / sec
                <input
                  aria-label="Transaction sends per second"
                  type="number"
                  min="1"
                  max={rps || "1000"}
                  step="1"
                  value={sendRps}
                  onChange={(e) => setSendRps(e.target.value)}
                />
              </label>
              <label>
                Account scans / sec
                <input
                  aria-label="Account scans per second"
                  type="number"
                  min="1"
                  max={rps || "1000"}
                  step="1"
                  value={scanRps}
                  onChange={(e) => setScanRps(e.target.value)}
                />
              </label>
            </div>
            <p>
              Helius Developer: 50 requests/sec, 5 sends/sec, 25 scans/sec. Use
              lower limits if other apps share your plan.
            </p>
            {!initial.paidAvailable && (
              <p>
                Set this network’s RPC URL in the external operator.env file to
                your paid provider first. Keep its API key there.
              </p>
            )}
          </>
        ) : (
          <p>Conservative pacing: one RPC request every 300 ms.</p>
        )}
        <p>
          Endpoint: <code>{initial.endpoint}</code>
        </p>
        <button
          disabled={!changed || (mode === "paid" && !initial.paidAvailable)}
          onClick={() => void apply()}
        >
          Apply RPC settings
        </button>
      </fieldset>
      {disabled && (
        <p>Pause the active operation before changing RPC settings.</p>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
