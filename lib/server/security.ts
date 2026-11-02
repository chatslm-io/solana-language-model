import { isAbsolute, relative, resolve, sep } from "node:path";
import { mkdir, realpath, lstat } from "node:fs/promises";
import { storageProgram } from "../config/programs";
import { address } from "@solana/kit";
import { parseSol } from "@/lib/chain/protocol";

export function protect(
  request: Request,
  origin = process.env.SLM_LOCAL_ORIGIN || "http://127.0.0.1:3000",
) {
  const expected = new URL(origin);
  if (
    !["127.0.0.1", "localhost"].includes(expected.hostname) ||
    expected.protocol !== "http:"
  )
    throw new Error("Local origin must use loopback HTTP");
  if (
    request.headers.get("host") !== expected.host ||
    request.headers.get("origin") !== expected.origin ||
    request.headers.get("x-slm-local") !== "1" ||
    ![null, "same-origin", "none"].includes(
      request.headers.get("sec-fetch-site"),
    )
  )
    throw new Error("Local origin validation failed");
}
export async function body(
  request: Request,
  limit = 32768,
): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("JSON required");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Body required");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Request too large");
    }
    chunks.push(value);
  }
  const b = JSON.parse(Buffer.concat(chunks).toString());
  if (!b || typeof b !== "object" || Array.isArray(b))
    throw new Error("Object required");
  return b;
}
export function configuration() {
  const cluster = process.env.SOLANA_CLUSTER || "devnet";
  if (!["localnet", "devnet", "mainnet-beta"].includes(cluster))
    throw new Error("Unsupported cluster");
  const rpc = new URL(process.env.SOLANA_RPC_URL || "");
  if (
    rpc.protocol !== "https:" &&
    !(
      rpc.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(rpc.hostname)
    )
  )
    throw new Error("RPC must use HTTPS or local HTTP");
  const program = storageProgram(cluster);
  if (program) address(program);
  const maxTransactions = Number(process.env.SLM_MAX_TRANSACTIONS || "100");
  if (
    !Number.isSafeInteger(maxTransactions) ||
    maxTransactions < 1 ||
    maxTransactions > 10000
  )
    throw new Error("Invalid transaction cap");
  return {
    cluster,
    program,
    rpc: rpc.toString(),
    rpcDisplay: `${rpc.protocol}//${rpc.host}/…`,
    maxDeposit: parseSol(process.env.SLM_MAX_DEPOSIT_SOL || "0.01").toString(),
    maxTransactions,
  };
}
export function publicConfig() {
  const { rpc, ...safe } = configuration();
  void rpc;
  return safe;
}
export async function modelRoot() {
  const value = process.env.HF_DOWNLOAD_DIR;
  if (!value?.trim())
    throw new Error("Set HF_DOWNLOAD_DIR to your model directory");
  const configured = resolve(value);
  await mkdir(configured, { recursive: true, mode: 0o700 });
  const stat = await lstat(configured);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("Download directory cannot be a symlink");
  if (
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(
      "Download directory must be owned by this user and not writable by other users",
    );
  const root = await realpath(configured);
  const repo = await realpath(process.cwd());
  const rel = relative(repo, root);
  if (
    rel !== ".local" &&
    !rel.startsWith(`.local${sep}`) &&
    (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))
  )
    throw new Error("Model storage must be outside this repository");
  return root;
}
export function safeError(e: unknown) {
  // Network libraries can include credential-bearing URLs in errors. Return only our bounded messages.
  const message = e instanceof Error ? e.message : "Operation failed";
  if (/https?:\/\/|hf_[a-zA-Z0-9]|token|authorization|api.key/i.test(message))
    return "Upstream request failed. Check server configuration and access.";
  return message.slice(0, 240);
}
export function localFile(root: string, name: string) {
  if (!/^[a-f0-9]{64}(\.(json|part|bytes))?$/.test(name))
    throw new Error("Invalid local artifact ID");
  return resolve(root, name);
}
