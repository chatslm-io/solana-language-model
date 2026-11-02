/** Public v1 profile. All numbers are u32LE; model bytes remain outside Git. */
import { createHash } from "node:crypto";
export const LIMITS = Object.freeze({
  context: 16,
  vocabulary: 8196,
  layers: 4,
  dim: 128,
  stateBytes: 8192,
  kvBytes: 3072,
  pageBytes: 8192,
  commandBytes: 64,
  commandsPerPage: 128,
  pages: 4096,
  commands: 65536,
  cacheOffset: 7808,
});
export const OP = Object.freeze({
  EMBED: 1,
  QUANTIZE_Q8: 2,
  GEMV: 3,
  RMS_GAIN: 4,
  RMS_APPLY: 5,
  COPY: 6,
  ADD: 7,
  SILU_MUL: 8,
  ROPE: 9,
  KV_APPEND: 10,
  SCORES: 11,
  SOFTMAX: 12,
  WEIGHTED: 13,
  ROUTE: 14,
  SCALE_ADD: 15,
  ARGMAX: 16,
  TOKEN_END: 17,
  ZERO: 18,
  HEAD_GEMV_ARGMAX: 19,
});
export const STATE = Object.freeze({
  H: 0,
  RES: 128,
  NORM: 256,
  Q: 384,
  KV: 512,
  ATT: 560,
  QUERY: 624,
  SCORES: 672,
  PROBS: 688,
  WEIGHTED: 704,
  UP: 736,
  GATE: 1088,
  ACT: 1440,
  ROUTED: 1792,
  ROUTER: 1920,
  RPROBS: 1928,
  SELWEIGHTS: 1936,
  SELIDS: 1938,
  BEST: 1940,
  INDEX: 1941,
  GAIN: 1942,
});
export const NONE = 0xffffffff;
/** A standard compute-budget request, not a disabled runtime limit. */
export const BATCH = Object.freeze({
  tag: 26,
  maxCommands: 8,
  maxAccounts: 20,
  computeUnitLimit: 1_200_000,
  baselineComputeUnitLimit: 200_000,
});
export const COMMAND_FIELDS = [
  "op",
  "src",
  "dst",
  "len",
  "aux0",
  "aux1",
  "weightPage",
  "weightOffset",
  "cols",
  "rows",
  "rowStart",
  "selector",
  "expertStride",
  "format",
  "flags",
  "reserved",
] as const;
export type Command = Record<(typeof COMMAND_FIELDS)[number], number>;
export function command(
  op: number,
  fields: Partial<Omit<Command, "op">> = {},
): Command {
  return Object.assign(
    Object.fromEntries(
      COMMAND_FIELDS.map((k) => [k, k === "selector" ? NONE : 0]),
    ),
    { op },
    fields,
  ) as Command;
}
function check(ok: boolean): asserts ok {
  if (!ok) throw Error("invalid_public_protocol");
}
function integer(n: number, min = 0, max = 0xffffffff) {
  check(Number.isSafeInteger(n) && n >= min && n <= max);
}
function digest(s: string) {
  check(typeof s === "string" && /^[0-9a-f]{64}$/.test(s));
  return Buffer.from(s, "hex");
}
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function encodeCommand(c: Command): Buffer {
  check(
    Object.keys(c).length === 16 &&
      Object.keys(c).every((k) =>
        (COMMAND_FIELDS as readonly string[]).includes(k),
      ),
  );
  integer(c.op, 1, 19);
  check(c.reserved === 0);
  const b = Buffer.alloc(64);
  COMMAND_FIELDS.forEach((k, i) => {
    integer(c[k]);
    b.writeUInt32LE(c[k], i * 4);
  });
  return b;
}
export function decodeCommand(bytes: Uint8Array): Command {
  check(bytes.length === 64);
  const b = Buffer.from(bytes);
  const c = Object.fromEntries(
    COMMAND_FIELDS.map((k, i) => [k, b.readUInt32LE(i * 4)]),
  ) as Command;
  encodeCommand(c);
  return c;
}
export type ModelBinding = {
  nonce: string;
  sourceSha: string;
  inventoryRoot: string;
  artifactRoot: string;
  numericRoot: string;
  totalPages: number;
  weightPages: number;
  planPageStart: number;
  planPages: number;
  commandCount: number;
  context: number;
  vocab: number;
  layers: number;
  dim: number;
  maxTokens: number;
};
const modelKeys = [
  "nonce",
  "sourceSha",
  "inventoryRoot",
  "artifactRoot",
  "numericRoot",
] as const;
const modelInts = [
  "totalPages",
  "weightPages",
  "planPageStart",
  "planPages",
  "commandCount",
  "context",
  "vocab",
  "layers",
  "dim",
  "maxTokens",
] as const;
export function encodeModelBinding(m: ModelBinding): Buffer {
  check(
    Object.keys(m).length === 15 &&
      Object.keys(m).every((k) =>
        [...modelKeys, ...modelInts].includes(k as (typeof modelKeys)[number]),
      ),
  );
  integer(m.weightPages, 1, 4095);
  integer(m.commandCount, 1, 65536);
  integer(m.totalPages, 2, 4096);
  check(
    m.planPages === Math.ceil(m.commandCount / 128) &&
      m.planPageStart === m.weightPages &&
      m.totalPages === m.weightPages + m.planPages,
  );
  check(
    m.context === 16 &&
      m.maxTokens === 16 &&
      m.vocab === 8196 &&
      m.layers === 4 &&
      m.dim === 128,
  );
  const b = Buffer.alloc(224);
  b.write("SLMPUB01");
  modelKeys.forEach((k, i) => digest(m[k]).copy(b, 8 + 32 * i));
  modelInts.forEach((k, i) => {
    integer(m[k]);
    b.writeUInt32LE(m[k], 168 + 4 * i);
  });
  return b;
}
export function decodeModelBinding(bytes: Uint8Array): ModelBinding {
  const b = Buffer.from(bytes);
  check(
    b.length === 224 &&
      b.subarray(0, 8).equals(Buffer.from("SLMPUB01")) &&
      b.subarray(208).every((v) => v === 0),
  );
  const m = Object.assign(
    Object.fromEntries(
      modelKeys.map((k, i) => [
        k,
        b.subarray(8 + 32 * i, 40 + 32 * i).toString("hex"),
      ]),
    ),
    Object.fromEntries(
      modelInts.map((k, i) => [k, b.readUInt32LE(168 + 4 * i)]),
    ),
  ) as unknown as ModelBinding;
  encodeModelBinding(m);
  return m;
}
export function modelCommitment(m: ModelBinding): string {
  return sha256(
    Buffer.concat([
      Buffer.from("slm-public:model:v1\n"),
      encodeModelBinding(m),
    ]),
  );
}
export function artifactLeaf(
  index: number,
  kind: number,
  length: number,
  payloadHash: string,
): string {
  integer(index, 0, 4095);
  integer(kind, 0, 2);
  integer(length, 0, 8192);
  check(kind === 0 ? length === 0 : length > 0);
  const b = Buffer.alloc(12);
  b.writeUInt32LE(index);
  b.writeUInt32LE(kind, 4);
  b.writeUInt32LE(length, 8);
  return sha256(
    Buffer.concat([
      Buffer.from("slm-public:artifact:v1\n"),
      b,
      digest(payloadHash),
    ]),
  );
}
function parent(left: string, right: string) {
  return sha256(
    Buffer.concat([
      Buffer.from("slm-public:artifact-node:v1\n"),
      digest(left),
      digest(right),
    ]),
  );
}
export type ArtifactPage = {
  index: number;
  kind: 1 | 2;
  payload: Uint8Array;
  hash: string;
  proof: string[];
};
export function buildArtifacts(
  source: readonly { kind: 1 | 2; payload: Uint8Array }[],
): { root: string; pages: ArtifactPage[] } {
  integer(source.length, 1, 4096);
  const pages = Array.from(source, (p, index) => {
    check(
      p !== undefined &&
        [1, 2].includes(p.kind) &&
        p.payload instanceof Uint8Array,
    );
    integer(p.payload.length, 1, 8192);
    const payload = Uint8Array.from(p.payload);
    return {
      index,
      kind: p.kind,
      payload,
      hash: sha256(payload),
      proof: [] as string[],
    };
  });
  let width = 1;
  while (width < pages.length) width *= 2;
  const levels: string[][] = [
    Array.from({ length: width }, (_, i) =>
      i < pages.length
        ? artifactLeaf(i, pages[i].kind, pages[i].payload.length, pages[i].hash)
        : artifactLeaf(i, 0, 0, sha256(new Uint8Array())),
    ),
  ];
  while (levels.at(-1)!.length > 1) {
    const prev = levels.at(-1)!;
    levels.push(
      Array.from({ length: prev.length / 2 }, (_, i) =>
        parent(prev[i * 2], prev[i * 2 + 1]),
      ),
    );
  }
  pages.forEach(
    (p) =>
      (p.proof = levels
        .slice(0, -1)
        .map((level, depth) => level[(p.index >>> depth) ^ 1])),
  );
  return { root: levels.at(-1)![0], pages };
}
export function verifyArtifact(
  root: string,
  totalPages: number,
  page: ArtifactPage,
): void {
  digest(root);
  integer(totalPages, 1, 4096);
  integer(page.index, 0, totalPages - 1);
  check(
    page.proof.length === Math.ceil(Math.log2(totalPages)) &&
      sha256(page.payload) === page.hash,
  );
  let h = artifactLeaf(page.index, page.kind, page.payload.length, page.hash),
    i = page.index;
  for (const sibling of page.proof) {
    h = i & 1 ? parent(sibling, h) : parent(h, sibling);
    i >>>= 1;
  }
  check(h === root);
}
