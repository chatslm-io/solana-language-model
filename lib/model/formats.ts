import { parseTree, type Node, type ParseError } from "jsonc-parser";
export type Tensor = {
  id: string;
  file: string;
  name: string;
  layer: number | null;
  shape: number[];
  dtype: string;
  format: "safetensors" | "gguf";
  offset: number;
  length: number;
  role: "transformer" | "offchain learned weights" | "other";
  dependencies: string[];
};
export type Parsed = { tensors: Tensor[]; metadataBytes: number };
export type Reader = (offset: number, length: number) => Promise<Uint8Array>;
const MAX_HEADER = 16 * 1024 * 1024;
export function strictJson(text: string): unknown {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (!root || errors.length) throw new Error("Malformed JSON metadata");
  const visit = (n: Node) => {
    if (n.type === "object") {
      const keys = new Set();
      for (const p of n.children || []) {
        const k = p.children![0].value;
        if (keys.has(k)) throw new Error("Duplicate JSON metadata key");
        keys.add(k);
      }
    }
    for (const c of n.children || []) visit(c);
  };
  visit(root);
  return JSON.parse(text);
}
const integer = (n: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > max)
    throw new Error("Invalid metadata integer");
  return n;
};
function descriptor(
  file: string,
  name: string,
  shape: number[],
  dtype: string,
  format: Tensor["format"],
  offset: number,
  length: number,
): Tensor {
  const match = name.match(/(?:layers|h|blocks|blk)\.(\d+)\./);
  const layer = match ? Number(match[1]) : null;
  const embedding =
    /(?:^|\.)(?:embed_tokens|word_embeddings|wte|wpe|lm_head|output|token_embd|position_embd)(?:\.|$)/.test(
      name,
    );
  return {
    id: `${file}:${name}`,
    file,
    name,
    layer,
    shape,
    dtype,
    format,
    offset,
    length,
    role: embedding
      ? "offchain learned weights"
      : layer !== null || /(?:norm|rotary)/.test(name)
        ? "transformer"
        : "other",
    dependencies: [],
  };
}
export async function safetensors(
  file: string,
  size: number,
  read: Reader,
): Promise<Parsed> {
  if (size < 10) throw new Error("Truncated Safetensors file");
  const first = await read(0, 8);
  const n = Number(
    new DataView(first.buffer, first.byteOffset, 8).getBigUint64(0, true),
  );
  integer(n, MAX_HEADER);
  if (n < 2 || 8 + n > size)
    throw new Error("Invalid Safetensors header length");
  const raw = await read(8, n);
  if (raw[0] !== 123) throw new Error("Invalid Safetensors header");
  const header = strictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
  ) as Record<string, unknown>;
  if (!header || typeof header !== "object" || Array.isArray(header))
    throw new Error("Invalid tensor map");
  const widths: Record<string, number> = {
    BOOL: 1,
    U8: 1,
    I8: 1,
    I16: 2,
    U16: 2,
    F16: 2,
    BF16: 2,
    I32: 4,
    U32: 4,
    F32: 4,
    I64: 8,
    U64: 8,
    F64: 8,
    F8_E4M3: 1,
    F8_E5M2: 1,
  };
  const tensors: Tensor[] = [];
  for (const [name, value] of Object.entries(header)) {
    if (name === "__metadata__") {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.values(value).some((v) => typeof v !== "string")
      )
        throw new Error("Invalid Safetensors metadata");
      continue;
    }
    if (!name || name.length > 1024 || !value || typeof value !== "object")
      throw new Error("Invalid tensor descriptor");
    const t = value as {
      dtype: string;
      shape: number[];
      data_offsets: number[];
    };
    if (!widths[t.dtype])
      throw new Error(`Unsupported Safetensors dtype: ${t.dtype}`);
    if (
      !Array.isArray(t.shape) ||
      t.shape.length > 16 ||
      !Array.isArray(t.data_offsets) ||
      t.data_offsets.length !== 2
    )
      throw new Error("Invalid tensor dimensions");
    const shape = t.shape.map((n) => integer(n));
    const [start, end] = t.data_offsets.map((n) => integer(n));
    const expected =
      shape.reduce((p, n) => p * BigInt(n), 1n) * BigInt(widths[t.dtype]);
    if (end < start || BigInt(end - start) !== expected || 8 + n + end > size)
      throw new Error("Tensor byte range does not match shape or file size");
    tensors.push(
      descriptor(
        file,
        name,
        shape,
        t.dtype,
        "safetensors",
        8 + n + start,
        end - start,
      ),
    );
  }
  const sorted = [...tensors].sort(
    (a, b) => a.offset - b.offset || a.length - b.length,
  );
  let end = 8 + n;
  for (const t of sorted) {
    if (t.offset !== end)
      throw new Error("Safetensors data has overlapping ranges or holes");
    end += t.length;
  }
  if (end !== size) throw new Error("Unexpected trailing Safetensors bytes");
  return { tensors, metadataBytes: 8 + n };
}
// Reviewed ggml block layouts. Scales/minima are inside the copied blocks.
export const GGML: Record<number, [string, number, number]> = {
  0: ["F32", 1, 4],
  1: ["F16", 1, 2],
  2: ["Q4_0", 32, 18],
  3: ["Q4_1", 32, 20],
  6: ["Q5_0", 32, 22],
  7: ["Q5_1", 32, 24],
  8: ["Q8_0", 32, 34],
  9: ["Q8_1", 32, 36],
  10: ["Q2_K", 256, 84],
  11: ["Q3_K", 256, 110],
  12: ["Q4_K", 256, 144],
  13: ["Q5_K", 256, 176],
  14: ["Q6_K", 256, 210],
  15: ["Q8_K", 256, 292],
  30: ["BF16", 1, 2],
};
export async function gguf(
  file: string,
  size: number,
  read: Reader,
): Promise<Parsed> {
  const b = await read(0, Math.min(size, MAX_HEADER));
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  const take = (n: number) => {
    if (at + n > b.length)
      throw new Error("GGUF metadata exceeds the 16 MiB limit or is truncated");
    const s = at;
    at += n;
    return s;
  };
  const uint = () => v.getUint32(take(4), true);
  const big = () => integer(Number(v.getBigUint64(take(8), true)));
  const str = () => {
    const n = big();
    integer(n, MAX_HEADER);
    const s = take(n);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      b.subarray(s, s + n),
    );
  };
  if (uint() !== 0x46554747 || uint() !== 3)
    throw new Error("Only GGUF version 3 little-endian files are supported");
  const count = integer(big(), 100000);
  const kv = integer(big(), 100000);
  let alignment = 32;
  const value = (type: number, depth = 0): unknown => {
    if (depth > 1) throw new Error("Nested GGUF arrays are unsupported");
    if (type === 8) return str();
    if (type === 9) {
      const item = uint();
      const count = integer(big(), 1000000);
      if (item === 9) throw new Error("Nested GGUF arrays");
      for (let i = 0; i < count; i++) value(item, depth + 1);
      return null;
    }
    const sizes: Record<number, number> = {
      0: 1,
      1: 1,
      2: 2,
      3: 2,
      4: 4,
      5: 4,
      6: 4,
      7: 1,
      10: 8,
      11: 8,
      12: 8,
    };
    if (!sizes[type]) throw new Error("Unsupported GGUF metadata type");
    const pos = take(sizes[type]);
    return type === 4 ? v.getUint32(pos, true) : null;
  };
  const keys = new Set<string>();
  for (let i = 0; i < kv; i++) {
    const key = str();
    if (keys.has(key)) throw new Error("Duplicate GGUF metadata key");
    keys.add(key);
    const type = uint();
    const val = value(type);
    if (key === "general.alignment") {
      if (type !== 4) throw new Error("Invalid GGUF alignment type");
      alignment = integer(val, 4096);
    }
    if (key.startsWith("split."))
      throw new Error("Split GGUF is not supported; use a single GGUF file");
  }
  if (!alignment || (alignment & (alignment - 1)) !== 0)
    throw new Error("GGUF alignment must be a power of two");
  const tensors: Tensor[] = [];
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    const name = str();
    if (!name || name.length > 1024 || names.has(name))
      throw new Error("Invalid or duplicate GGUF tensor name");
    names.add(name);
    const ndim = integer(uint(), 4);
    if (ndim === 0) throw new Error("Invalid GGUF dimensions");
    const shape = Array.from({ length: ndim }, () => big());
    const type = uint();
    const offset = big();
    const layout = GGML[type];
    if (!layout) throw new Error(`Unsupported GGUF quantization type: ${type}`);
    const [dtype, block, bytes] = layout;
    const elements = shape.reduce((p, n) => p * BigInt(n), 1n);
    if (shape.some((n) => n === 0) || shape[0] % block || offset % alignment)
      throw new Error("Invalid GGUF block dimensions/alignment");
    const length = integer(Number((elements / BigInt(block)) * BigInt(bytes)));
    tensors.push(descriptor(file, name, shape, dtype, "gguf", offset, length));
  }
  const start = Math.ceil(at / alignment) * alignment;
  if (start > size) throw new Error("Truncated GGUF metadata");
  for (const t of tensors) {
    t.offset += start;
    if (t.offset + t.length > size) throw new Error("Truncated GGUF tensor");
  }
  let end = start;
  for (const t of [...tensors].sort((a, b) => a.offset - b.offset)) {
    if (t.offset < end) throw new Error("Overlapping GGUF tensors");
    end = t.offset + t.length;
  }
  return { tensors, metadataBytes: start };
}
export function bindDependencies(tensors: Tensor[], quantization: unknown) {
  const method = (quantization as { quant_method?: string } | undefined)
    ?.quant_method;
  if (method && !["gptq", "awq", "fp8"].includes(method))
    throw new Error(`Unsupported quantization method: ${method}`);
  const byName = new Map(tensors.map((t) => [t.name, t]));
  if (byName.size !== tensors.length)
    throw new Error("Duplicate tensor names across checkpoint shards");
  for (const t of tensors) {
    if (/\.(qweight|qzeros|scales|g_idx)$/.test(t.name)) {
      if (!method || !["gptq", "awq"].includes(method))
        throw new Error("Packed weights need a supported quantization_config");
      const prefix = t.name.replace(/\.[^.]+$/, "");
      const group = ["qweight", "qzeros", "scales", "g_idx"]
        .map((n) => byName.get(`${prefix}.${n}`))
        .filter((v): v is Tensor => !!v);
      if (
        !["qweight", "qzeros", "scales"].every((n) =>
          byName.has(`${prefix}.${n}`),
        )
      )
        throw new Error("Incomplete packed-weight dependency group");
      t.dependencies = group.filter((x) => x.id !== t.id).map((x) => x.id);
    }
    if (
      t.dtype.startsWith("F8_") ||
      /\.(weight_scale(?:_inv)?|input_scale)$/.test(t.name)
    ) {
      const prefix = t.name.replace(
        /\.(weight|weight_scale|weight_scale_inv|input_scale)$/,
        "",
      );
      const weight = byName.get(`${prefix}.weight`);
      const scale =
        byName.get(`${prefix}.weight_scale_inv`) ||
        byName.get(`${prefix}.weight_scale`);
      if (method !== "fp8" || !weight || !scale)
        throw new Error(
          "FP8 weights require an explicit supported scale dependency",
        );
      const inputScale = byName.get(`${prefix}.input_scale`);
      if (
        (quantization as { activation_scheme?: string }).activation_scheme ===
          "static" &&
        !inputScale
      )
        throw new Error(
          "Static FP8 activation quantization requires an input_scale tensor",
        );
      t.dependencies = [
        weight.id,
        scale.id,
        ...(inputScale ? [inputScale.id] : []),
      ].filter((id) => id !== t.id);
    }
  }
}
export function selection(tensors: Tensor[], ids: string[]) {
  const selected = new Set(ids);
  const map = new Map(tensors.map((t) => [t.id, t]));
  for (const id of selected) {
    const t = map.get(id);
    if (!t || !t.length) throw new Error("Unknown or empty tensor selected");
    for (const dep of t.dependencies) selected.add(dep);
  }
  return tensors
    .filter((t) => selected.has(t.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
