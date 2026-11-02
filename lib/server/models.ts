import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { modelRoot, localFile, safeError } from "./security";
import {
  safetensors,
  gguf,
  strictJson,
  bindDependencies,
  selection,
  type Tensor,
} from "@/lib/model/formats";
import { canonical, type Manifest } from "@/lib/model/manifest";
import { SHARD_BYTES } from "@/lib/chain/protocol";

const hash = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const repoPattern =
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
type FileInfo = { name: string; size: number; sha256?: string };
type Model = {
  source: { repo: string; revision: string };
  files: FileInfo[];
  tensors: Tensor[];
  headers: { file: string; length: number }[];
};
type Job = {
  id: string;
  done: boolean;
  bytes: number;
  total: number;
  file: string;
  error?: string;
};
const jobs = new Map<string, Job>();
function text(v: unknown, max = 256): string {
  if (typeof v !== "string" || !v || v.length > max)
    throw new Error("Invalid input");
  return v;
}
function names(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 10000)
    throw new Error("Select checkpoint files");
  return [...new Set(v.map((x) => text(x, 1024)))].sort();
}
function source(repo: unknown, revision: unknown, pinned = true) {
  const r = text(repo);
  const rev = text(revision || "main");
  if (
    !repoPattern.test(r) ||
    r.includes("..") ||
    !(pinned ? revisionPattern : /^[a-zA-Z0-9_.\/-]{1,128}$/).test(rev) ||
    rev.includes("..")
  )
    throw new Error("Invalid repository or revision");
  return { repo: r, revision: rev };
}
const fileId = (s: Model["source"], file: string) =>
  hash(`${s.repo}\0${s.revision}\0${file}`);
const checkpoint = (f: string) => /\.(safetensors|gguf)$/.test(f);
const sidecar = (f: string) =>
  /^(config\.json|quantize_config\.json|quant_config\.json|model\.safetensors\.index\.json)$/.test(
    f,
  );
async function safeOpen(root: string, name: string, write = false) {
  return open(
    localFile(root, name),
    constants.O_NOFOLLOW |
      (write
        ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
        : constants.O_RDONLY),
    0o600,
  );
}
async function readBytes(
  root: string,
  id: string,
  offset = 0,
  length?: number,
) {
  const f = await safeOpen(root, id);
  try {
    const st = await f.stat();
    if (!st.isFile()) throw new Error("Artifact is not a regular file");
    const n = length ?? st.size;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(n) ||
      n < 0 ||
      n > 64 * 1024 * 1024 ||
      offset + n > st.size
    )
      throw new Error("Invalid artifact range");
    const b = Buffer.alloc(n);
    let at = 0;
    while (at < n) {
      const { bytesRead } = await f.read(b, at, n - at, offset + at);
      if (!bytesRead) throw new Error("Truncated artifact");
      at += bytesRead;
    }
    return b;
  } finally {
    await f.close();
  }
}
async function json<T>(root: string, id: string): Promise<T> {
  return strictJson((await readBytes(root, `${id}.json`)).toString()) as T;
}
async function save(root: string, id: string, value: unknown) {
  const temp = `${hash(randomBytes(32))}.part`;
  const f = await safeOpen(root, temp, true);
  try {
    await f.writeFile(canonical(value));
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(localFile(root, temp), localFile(root, `${id}.json`));
}
async function hf(url: string, range?: number): Promise<Response> {
  let target = new URL(url);
  for (let redirects = 0; redirects < 6; redirects++) {
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      !(
        target.hostname === "huggingface.co" ||
        target.hostname.endsWith(".huggingface.co") ||
        target.hostname.endsWith(".hf.co")
      )
    )
      throw new Error("Unapproved model download host");
    const headers: Record<string, string> = {};
    if (target.hostname === "huggingface.co" && process.env.HF_TOKEN)
      headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
    if (range) headers.Range = `bytes=${range}-`;
    const r = await fetch(target, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const location = r.headers.get("location");
      await r.body?.cancel();
      if (!location) throw new Error("Invalid download redirect");
      target = new URL(location, target);
      continue;
    }
    if (!r.ok) throw new Error(`Model service request failed (${r.status})`);
    return r;
  }
  throw new Error("Too many model download redirects");
}
async function resolveModel(s: Model["source"]) {
  const r = await hf(
    `https://huggingface.co/api/models/${s.repo}/revision/${encodeURIComponent(s.revision)}?blobs=true`,
  );
  const bytes = await bounded(r, 16 * 1024 * 1024);
  const data = strictJson(bytes.toString()) as {
    sha: string;
    siblings: {
      rfilename: string;
      size?: number;
      lfs?: { size: number; sha256: string };
    }[];
  };
  if (!revisionPattern.test(data.sha) || !Array.isArray(data.siblings))
    throw new Error("Invalid model repository metadata");
  const files = data.siblings
    .filter((f) => checkpoint(f.rfilename) || sidecar(f.rfilename))
    .map((f) => ({
      name: f.rfilename,
      size: f.size ?? f.lfs?.size ?? 0,
      sha256: f.lfs?.sha256,
    }));
  for (const f of files)
    if (
      f.name.startsWith("/") ||
      f.name.split("/").some((p) => !p || p === ".." || p === ".") ||
      f.name.includes("\\") ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0
    )
      throw new Error("Invalid model file metadata");
  if (!files.some((f) => checkpoint(f.name)))
    throw new Error("No supported Safetensors or GGUF files found");
  return { repo: s.repo, revision: data.sha, files };
}
async function bounded(r: Response, max: number) {
  const reader = r.body?.getReader();
  if (!reader) throw new Error("Empty upstream response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("Upstream metadata too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function fileHash(root: string, name: string) {
  const f = await safeOpen(root, name);
  try {
    const h = createHash("sha256");
    for await (const b of f.createReadStream({ autoClose: false })) h.update(b);
    return h.digest("hex");
  } finally {
    await f.close();
  }
}
async function download(
  root: string,
  s: Model["source"],
  files: FileInfo[],
  job: Job,
) {
  try {
    for (const file of files) {
      job.file = file.name;
      const id = fileId(s, file.name);
      let existing = false;
      try {
        const f = await safeOpen(root, `${id}.bytes`);
        const st = await f.stat();
        await f.close();
        existing = st.size === file.size;
      } catch {}
      if (existing) {
        if (
          file.sha256 &&
          (await fileHash(root, `${id}.bytes`)) !== file.sha256
        )
          throw new Error("Cached checkpoint checksum mismatch");
        job.bytes += file.size;
        continue;
      }
      // Resume a partial file only at its pinned immutable revision.
      let start = 0;
      let f;
      try {
        f = await open(
          localFile(root, `${id}.part`),
          constants.O_NOFOLLOW | constants.O_RDWR,
        );
        start = (await f.stat()).size;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        f = await safeOpen(root, `${id}.part`, true);
      }
      try {
        if (start > file.size) {
          await f.truncate(0);
          start = 0;
        }
        let r: Response | undefined;
        if (start < file.size || file.size === 0)
          r = await hf(
            `https://huggingface.co/${s.repo}/resolve/${s.revision}/${file.name.split("/").map(encodeURIComponent).join("/")}`,
            start,
          );
        if (
          r &&
          start &&
          (r.status !== 206 ||
            !r.headers.get("content-range")?.startsWith(`bytes ${start}-`))
        ) {
          await f.truncate(0);
          start = 0;
          if (r.status === 206)
            throw new Error("Invalid resumed download range");
        }
        let written = start;
        job.bytes += start;
        if (r) {
          const reader = r.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (written + value.length > file.size) {
              await reader.cancel();
              throw new Error("Download exceeded declared file size");
            }
            let used = 0;
            while (used < value.length) {
              const result = await f.write(
                value,
                used,
                value.length - used,
                written + used,
              );
              if (!result.bytesWritten)
                throw new Error("Download write failed");
              used += result.bytesWritten;
            }
            written += value.length;
            job.bytes += value.length;
          }
        }
        if (written !== file.size) throw new Error("Incomplete model download");
        await f.sync();
      } finally {
        await f.close();
      }
      if (file.sha256 && (await fileHash(root, `${id}.part`)) !== file.sha256) {
        await unlink(localFile(root, `${id}.part`));
        throw new Error("Model download checksum mismatch");
      }
      await rename(
        localFile(root, `${id}.part`),
        localFile(root, `${id}.bytes`),
      );
    }
    job.done = true;
  } catch (e) {
    job.error = safeError(e);
    job.done = true;
  }
}
async function inspect(root: string, s: Model["source"], selected: string[]) {
  const resolved = await resolveModel(s);
  const files = resolved.files.filter(
    (f) => selected.includes(f.name) || sidecar(f.name),
  );
  if (selected.some((n) => !files.some((f) => f.name === n)))
    throw new Error("Unknown checkpoint file");
  const weights = files.filter((f) => checkpoint(f.name));
  if (weights.some((f) => f.name.endsWith(".gguf")) && weights.length !== 1)
    throw new Error("Select one GGUF checkpoint, or the Safetensors shard set");
  const tensors: Tensor[] = [];
  const headers: Model["headers"] = [];
  let config: Record<string, unknown> = {};
  for (const f of files) {
    const reader = (o: number, n: number) =>
      readBytes(root, `${fileId(s, f.name)}.bytes`, o, n);
    if (checkpoint(f.name)) {
      const parsed = await (f.name.endsWith(".gguf") ? gguf : safetensors)(
        f.name,
        f.size,
        reader,
      );
      tensors.push(...parsed.tensors);
      headers.push({ file: f.name, length: parsed.metadataBytes });
    } else if (f.name === "config.json") {
      config = strictJson((await reader(0, f.size)).toString()) as Record<
        string,
        unknown
      >;
    }
  }
  const index = files.find((f) => f.name === "model.safetensors.index.json");
  if (index && weights.every((f) => f.name.endsWith(".safetensors"))) {
    const parsed = strictJson(
      (await readBytes(root, `${fileId(s, index.name)}.bytes`)).toString(),
    ) as { weight_map: Record<string, string> };
    if (!parsed.weight_map) throw new Error("Invalid Safetensors index");
    const map = new Map(tensors.map((t) => [t.name, t.file]));
    if (
      Object.entries(parsed.weight_map).some(
        ([name, file]) => map.get(name) !== file,
      ) ||
      map.size !== Object.keys(parsed.weight_map).length
    )
      throw new Error(
        "Checkpoint shard set does not match index; select every indexed shard",
      );
  }
  bindDependencies(tensors, config.quantization_config);
  if (!tensors.length) throw new Error("No tensors found");
  const model: Model = { source: s, files, tensors, headers };
  const id = hash(canonical({ source: s, files }));
  await save(root, id, model);
  return { id, ...model };
}
async function prepare(root: string, model: Model, ids: string[]) {
  const tensors = selection(model.tensors, ids);
  if (!tensors.length) throw new Error("Select at least one tensor");
  const temporary = `${hash(randomBytes(32))}.part`;
  const out = await safeOpen(root, temporary, true);
  let offset = 0;
  const manifest: Manifest = {
    version: 1,
    source: model.source,
    tensors: [],
    artifacts: [],
    payloadBytes: 0,
    shards: [],
  };
  try {
    const append = async (file: string, start: number, length: number) => {
      const digest = createHash("sha256");
      for (let at = 0; at < length; at += 1024 * 1024) {
        const b = await readBytes(
          root,
          `${fileId(model.source, file)}.bytes`,
          start + at,
          Math.min(1024 * 1024, length - at),
        );
        digest.update(b);
        await out.writeFile(b);
      }
      const result = {
        payloadOffset: offset,
        length,
        sha256: digest.digest("hex"),
      };
      offset += length;
      if (offset > Number(process.env.SLM_MAX_DOWNLOAD_BYTES || 21474836480))
        throw new Error("Selected payload exceeds configured byte cap");
      return result;
    };
    for (const h of model.headers
      .filter((h) => tensors.some((t) => t.file === h.file))
      .sort((a, b) => (a.file < b.file ? -1 : 1)))
      manifest.artifacts.push({
        name: `${h.file}:original-header`,
        ...(await append(h.file, 0, h.length)),
      });
    for (const f of model.files
      .filter((f) => sidecar(f.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1)))
      manifest.artifacts.push({
        name: f.name,
        ...(await append(f.name, 0, f.size)),
      });
    for (const t of tensors)
      manifest.tensors.push({
        ...t,
        ...(await append(t.file, t.offset, t.length)),
      });
    await out.sync();
  } finally {
    await out.close();
  }
  manifest.payloadBytes = offset;
  for (let at = 0; at < offset; at += SHARD_BYTES) {
    const b = await readBytes(
      root,
      temporary,
      at,
      Math.min(SHARD_BYTES, offset - at),
    );
    manifest.shards.push({
      index: manifest.shards.length,
      offset: at,
      length: b.length,
      sha256: hash(b),
    });
  }
  const id = hash(canonical(manifest));
  await rename(localFile(root, temporary), localFile(root, `${id}.bytes`));
  await save(root, id, manifest);
  return { id, manifest };
}
export async function modelAction(
  input: Record<string, unknown>,
): Promise<unknown> {
  const action = text(input.action);
  if (action === "resolve")
    return resolveModel(source(input.repo, input.revision, false));
  if (action === "job") {
    const job = jobs.get(text(input.id));
    if (!job)
      throw new Error("Download interrupted; retry to resume partial files");
    return job;
  }
  const root = await modelRoot();
  if (action === "download") {
    const s = source(input.repo, input.revision);
    const requested = names(input.files);
    const r = await resolveModel(s);
    const files = r.files.filter(
      (f) => requested.includes(f.name) || sidecar(f.name),
    );
    if (requested.some((n) => !files.some((f) => f.name === n)))
      throw new Error("Unknown file selection");
    const total = files.reduce((n, f) => n + f.size, 0);
    const cap = Number(process.env.SLM_MAX_DOWNLOAD_BYTES || 21474836480);
    if (
      !Number.isSafeInteger(cap) ||
      cap < 1 ||
      total > cap ||
      files.some((f) => f.size === 0)
    )
      throw new Error("Download exceeds byte cap or has unknown sizes");
    const id = hash(canonical({ s, files }));
    const active = jobs.get(id);
    if (active && !active.done) return active;
    if ([...jobs.values()].some((j) => !j.done))
      throw new Error("Wait for the active download to finish");
    const job: Job = { id, done: false, bytes: 0, total, file: "" };
    jobs.set(id, job);
    void download(root, s, files, job);
    return job;
  }
  if (action === "inspect")
    return inspect(
      root,
      source(input.repo, input.revision),
      names(input.files),
    );
  if (action === "prepare")
    return prepare(
      root,
      await json<Model>(root, text(input.id)),
      names(input.tensors),
    );
  if (action === "manifest") {
    const id = text(input.id);
    const manifest = await json<Manifest>(root, id);
    if (hash(canonical(manifest)) !== id)
      throw new Error("Manifest checksum mismatch");
    return { id, manifest };
  }
  if (action === "shard") {
    const id = text(input.id);
    const m = await json<Manifest>(root, id);
    if (hash(canonical(m)) !== id)
      throw new Error("Manifest checksum mismatch");
    const index = Number(input.index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= m.shards.length)
      throw new Error("Invalid shard index");
    const s = m.shards[index];
    const b = await readBytes(root, `${id}.bytes`, s.offset, s.length);
    if (hash(b) !== s.sha256) throw new Error("Local shard checksum mismatch");
    return { bytes: b.toString("base64") };
  }
  if (action === "synthetic") {
    const b = Buffer.from("Solana Language Model: recovery first.\n".repeat(2));
    const m: Manifest = {
      version: 1,
      source: { repo: "synthetic/recovery-proof", revision: "0".repeat(40) },
      tensors: [],
      artifacts: [
        {
          name: "synthetic.txt",
          payloadOffset: 0,
          length: b.length,
          sha256: hash(b),
        },
      ],
      payloadBytes: b.length,
      shards: [{ index: 0, offset: 0, length: b.length, sha256: hash(b) }],
    };
    const id = hash(canonical(m));
    try {
      const f = await safeOpen(root, `${id}.bytes`, true);
      try {
        await f.writeFile(b);
      } finally {
        await f.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    await save(root, id, m);
    return { id, manifest: m };
  }
  throw new Error("Unknown model operation");
}
