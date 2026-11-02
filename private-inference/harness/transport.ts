import { parseJsonWithBigInts } from "@solana/rpc-spec-types";
/** Upstream accepts only public account identifiers and fixed read options. */
import { type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
export class ReadOnlyCloneRpc {
  constructor(private readonly endpoint: string) {
    const u = new URL(endpoint);
    if (u.protocol !== "https:" || u.username || u.password || u.hash)
      throw Error("invalid_clone_endpoint");
  }
  async read(method: string, params: unknown[] = []): Promise<unknown> {
    if (method !== "getAccountInfo") throw Error("upstream_mutation_forbidden");
    if (
      params.length !== 2 ||
      typeof params[0] !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(params[0]) ||
      JSON.stringify(params[1]) !==
        JSON.stringify({ encoding: "base64", commitment: "finalized" })
    )
      throw Error("invalid_clone_read_parameters");
    const response = await fetch(this.endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error("clone_read_failed");
    const reader = response.body?.getReader();
    if (!reader) throw Error("clone_empty_response");
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16 * 1024 * 1024) {
        await reader.cancel();
        throw Error("clone_response_too_large");
      }
      chunks.push(value);
    }
    const value = parseJsonWithBigInts(
      Buffer.concat(chunks).toString("utf8"),
    ) as {
      jsonrpc?: string;
      id?: bigint;
      error?: unknown;
      result?: { context?: { slot?: bigint } };
    };
    if (
      value.jsonrpc !== "2.0" ||
      value.id !== 1n ||
      value.error ||
      !value.result ||
      typeof value.result.context?.slot !== "bigint" ||
      value.result.context.slot < 0n ||
      value.result.context.slot > 0xffffffffffffffffn
    )
      throw Error("clone_rpc_error");
    return value.result;
  }
}
/** Linux kernel socket ownership prevents an unrelated loopback RPC from being accepted. */
export function assertOwnedListeningPort(pid: number, port: number) {
  const sockets = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m) sockets.add(m[1]);
    } catch {}
  }
  let found = false;
  for (const family of ["tcp", "tcp6"])
    for (const line of readFileSync(`/proc/${pid}/net/${family}`, "utf8")
      .split("\n")
      .slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const p = parseInt(parts[1].split(":")[1], 16);
      if (p === port && parts[3] === "0A" && sockets.has(parts[9]))
        found = true;
    }
  if (!found) throw Error("local_rpc_not_owned_by_validator_process");
}
export class OwnedLocalRpc {
  readonly localOnly = true as const;
  private genesis: string | null = null;
  constructor(
    private readonly child: ChildProcess,
    private readonly port: number,
  ) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !child.pid)
      throw Error("invalid_owned_node");
  }
  private live() {
    if (!this.child.pid || this.child.exitCode !== null || this.child.killed)
      throw Error("owned_node_not_alive");
    process.kill(this.child.pid, 0);
    assertOwnedListeningPort(this.child.pid, this.port);
  }
  async rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    this.live();
    const response = await fetch(`http://127.0.0.1:${this.port}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error("local_rpc_failed");
    const value = await response.json();
    if (value.id !== 1 || value.jsonrpc !== "2.0")
      throw Error("local_rpc_error");
    if (value.error) {
      // Keep provider messages, data and program logs out of public diagnostics.
      const code = Number.isSafeInteger(value.error.code)
        ? value.error.code
        : "unknown";
      const operation = /^[a-zA-Z]{1,48}$/.test(method) ? method : "unknown";
      throw Error(`local_rpc_error:${operation}:${code}`);
    }
    return value.result as T;
  }
  async pin() {
    this.genesis = await this.rpc<string>("getGenesisHash");
    if (typeof this.genesis !== "string") throw Error("invalid_local_genesis");
    return this.genesis;
  }
  async beforeSigning() {
    this.live();
    if (!this.genesis || (await this.rpc("getGenesisHash")) !== this.genesis)
      throw Error("local_genesis_changed");
  }
  async sendExact(wireBase64: string) {
    await this.beforeSigning();
    return this.rpc<string>("sendTransaction", [
      wireBase64,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "finalized",
        maxRetries: 0,
      },
    ]);
  }
  async status(
    signature: string,
  ): Promise<"unknown" | "pending" | "finalized" | "failed"> {
    const v = await this.rpc<{
      value: ({ err: unknown; confirmationStatus: string } | null)[];
    }>("getSignatureStatuses", [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const s = v.value[0];
    return !s
      ? "unknown"
      : s.err
        ? "failed"
        : s.confirmationStatus === "finalized"
          ? "finalized"
          : "pending";
  }
}
