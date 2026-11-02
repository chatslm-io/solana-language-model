// The storage GGUF parser validates tensor/block layout. This bounded pass reads
// the architecture declaration needed to validate the onchain model layout.
export function ggufMetadata(bytes: Uint8Array): Map<string, unknown> {
  const b = Buffer.from(bytes);
  let at = 24;
  const take = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0 || at + n > b.length)
      throw new Error("invalid_gguf_metadata");
    const p = at;
    at += n;
    return p;
  };
  const u32 = () => b.readUInt32LE(take(4));
  const u64 = () => {
    const n = Number(b.readBigUInt64LE(take(8)));
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error("invalid_gguf_metadata");
    return n;
  };
  const string = () => {
    const length = u64();
    return new TextDecoder("utf-8", { fatal: true }).decode(
      b.subarray(take(length), at),
    );
  };
  const value = (type: number, depth = 0): unknown => {
    if (type === 8) return string();
    if (type === 9) {
      if (depth) throw new Error("unsupported_gguf_array");
      const element = u32(),
        count = u64();
      if (count > 1000000) throw new Error("gguf_array_limit");
      for (let i = 0; i < count; i++) value(element, depth + 1);
      return { count };
    }
    const widths: Record<number, number> = {
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
    if (!widths[type]) throw new Error("invalid_gguf_metadata");
    const offset = take(widths[type]);
    if (type === 4) return b.readUInt32LE(offset);
    if (type === 5) return b.readInt32LE(offset);
    if (type === 6) return b.readFloatLE(offset);
    if (type === 7) return b[offset] !== 0;
    if (type === 10) return Number(b.readBigUInt64LE(offset));
    return undefined;
  };
  if (b.length < 24) throw new Error("invalid_gguf_header");
  const count = Number(b.readBigUInt64LE(16));
  if (!Number.isSafeInteger(count) || count > 100000)
    throw new Error("gguf_metadata_limit");
  const metadata = new Map<string, unknown>();
  for (let i = 0; i < count; i++) {
    const key = string(),
      v = value(u32());
    if (metadata.has(key)) throw new Error("duplicate_gguf_metadata");
    metadata.set(key, v);
  }
  return metadata;
}
