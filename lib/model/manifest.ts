import type { Tensor } from "./formats";
export type Manifest = {
  version: 1;
  source: { repo: string; revision: string };
  tensors: (Tensor & { payloadOffset: number; sha256: string })[];
  artifacts: {
    name: string;
    payloadOffset: number;
    length: number;
    sha256: string;
  }[];
  payloadBytes: number;
  shards: { index: number; offset: number; length: number; sha256: string }[];
};
export function validateManifest(m: Manifest) {
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const digest = (s: string) =>
    typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
  if (
    !m ||
    m.version !== 1 ||
    !m.source ||
    typeof m.source.repo !== "string" ||
    !/^[a-f0-9]{40}$/.test(m.source.revision) ||
    !integer(m.payloadBytes) ||
    m.payloadBytes === 0 ||
    !Array.isArray(m.shards) ||
    !m.shards.length ||
    !Array.isArray(m.tensors) ||
    !Array.isArray(m.artifacts)
  )
    throw new Error("Invalid manifest");
  let offset = 0;
  for (const [i, s] of m.shards.entries()) {
    if (
      s.index !== i ||
      s.offset !== offset ||
      !integer(s.length) ||
      s.length < 1 ||
      s.length > 8192 ||
      !digest(s.sha256)
    )
      throw new Error("Invalid manifest shard layout");
    offset += s.length;
  }
  if (offset !== m.payloadBytes)
    throw new Error("Manifest payload length mismatch");
  offset = 0;
  for (const s of [...m.artifacts, ...m.tensors]) {
    if (s.payloadOffset !== offset || !integer(s.length) || !digest(s.sha256))
      throw new Error("Invalid manifest segment layout");
    offset += s.length;
  }
  if (offset !== m.payloadBytes)
    throw new Error("Manifest segments do not cover the payload");
  const ids = new Set(m.tensors.map((t) => t.id));
  if (
    ids.size !== m.tensors.length ||
    m.tensors.some(
      (t) =>
        typeof t.id !== "string" ||
        !Array.isArray(t.dependencies) ||
        t.dependencies.some((id) => !ids.has(id)),
    )
  )
    throw new Error("Invalid manifest tensor dependencies");
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
