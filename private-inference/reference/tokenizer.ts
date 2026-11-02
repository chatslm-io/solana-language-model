/** Cleartext GPT-2 byte-BPE reference for tests only. No production tokenization. */
export type Gpt2Vocabulary = {
  tokens: string[];
  merges: string[];
  pre: "gpt-2";
};
/** Read selected public tokenizer metadata after the storage GGUF parser validates the artifact. */
export function tokenizerMetadata(header: Uint8Array): {
  vocabulary: Gpt2Vocabulary;
  chatTemplate: string;
  eos: number;
} {
  const v = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let at = 24;
  const take = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0 || at + n > header.length)
      throw Error("reference_tokenizer_header");
    const start = at;
    at += n;
    return start;
  };
  const u32 = () => v.getUint32(take(4), true),
    u64 = () => {
      const n = Number(v.getBigUint64(take(8), true));
      if (!Number.isSafeInteger(n)) throw Error("reference_tokenizer_integer");
      return n;
    };
  const string = () => {
    const n = u64();
    return new TextDecoder("utf-8", { fatal: true }).decode(
      header.subarray(take(n), at),
    );
  };
  const value = (kind: number, depth = 0): unknown => {
    if (kind === 8) return string();
    if (kind === 9) {
      if (depth) throw Error("reference_tokenizer_nested");
      const type = u32(),
        count = u64();
      if (count > 1_000_000) throw Error("reference_tokenizer_limit");
      return Array.from({ length: count }, () => value(type, 1));
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
    if (!widths[kind]) throw Error("reference_tokenizer_type");
    const p = take(widths[kind]);
    return kind === 4
      ? v.getUint32(p, true)
      : kind === 7
        ? v.getUint8(p) !== 0
        : undefined;
  };
  if (
    header.length < 24 ||
    v.getUint32(0, true) !== 0x46554747 ||
    v.getUint32(4, true) !== 3
  )
    throw Error("reference_tokenizer_gguf");
  const count = Number(v.getBigUint64(16, true));
  if (!Number.isSafeInteger(count) || count > 100000)
    throw Error("reference_tokenizer_limit");
  const values = new Map<string, unknown>();
  for (let i = 0; i < count; i++) {
    const key = string();
    if (values.has(key)) throw Error("reference_tokenizer_duplicate");
    values.set(key, value(u32()));
  }
  const tokens = values.get("tokenizer.ggml.tokens"),
    merges = values.get("tokenizer.ggml.merges"),
    pre = values.get("tokenizer.ggml.pre"),
    chatTemplate = values.get("tokenizer.chat_template"),
    eos = values.get("tokenizer.ggml.eos_token_id");
  if (
    values.get("tokenizer.ggml.model") !== "gpt2" ||
    pre !== "gpt-2" ||
    !Array.isArray(tokens) ||
    !tokens.every((t) => typeof t === "string") ||
    !Array.isArray(merges) ||
    !merges.every((t) => typeof t === "string") ||
    typeof chatTemplate !== "string" ||
    typeof eos !== "number" ||
    eos >= tokens.length
  )
    throw Error("reference_tokenizer_unsupported");
  return { vocabulary: { tokens, merges, pre }, chatTemplate, eos };
}
export function gpt2Tokenizer(vocabulary: Gpt2Vocabulary) {
  if (
    vocabulary.pre !== "gpt-2" ||
    new Set(vocabulary.tokens).size !== vocabulary.tokens.length ||
    new Set(vocabulary.merges).size !== vocabulary.merges.length
  )
    throw Error("reference_tokenizer_vocabulary");
  const bytes = [
    ...Array.from({ length: 94 }, (_, i) => i + 33),
    ...Array.from({ length: 12 }, (_, i) => i + 161),
    ...Array.from({ length: 82 }, (_, i) => i + 174),
  ];
  const characters = [...bytes];
  let extra = 0;
  for (let byte = 0; byte < 256; byte++)
    if (!bytes.includes(byte)) {
      bytes.push(byte);
      characters.push(256 + extra++);
    }
  const encodeByte = new Map(
      bytes.map((byte, i) => [byte, String.fromCodePoint(characters[i])]),
    ),
    decodeByte = new Map(
      bytes.map((byte, i) => [String.fromCodePoint(characters[i]), byte]),
    );
  const ids = new Map(vocabulary.tokens.map((token, i) => [token, i])),
    ranks = new Map(vocabulary.merges.map((pair, i) => [pair, i]));
  return {
    encode(text: string): number[] {
      if (!text.isWellFormed()) throw Error("reference_tokenizer_unicode");
      const output: number[] = [];
      const pieces =
        text.match(
          /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu,
        ) ?? [];
      for (const piece of pieces) {
        let symbols = [...new TextEncoder().encode(piece)].map((byte) =>
          encodeByte.get(byte)!,
        );
        for (;;) {
          let best = Infinity,
            index = -1;
          for (let i = 0; i + 1 < symbols.length; i++) {
            const rank = ranks.get(symbols[i] + " " + symbols[i + 1]);
            if (rank !== undefined && rank < best) {
              best = rank;
              index = i;
            }
          }
          if (index < 0) break;
          const left = symbols[index],
            right = symbols[index + 1],
            next: string[] = [];
          for (let i = 0; i < symbols.length; i++) {
            if (symbols[i] === left && symbols[i + 1] === right) {
              next.push(left + right);
              i++;
            } else next.push(symbols[i]);
          }
          symbols = next;
        }
        for (const symbol of symbols) {
          const id = ids.get(symbol);
          if (id === undefined) throw Error("reference_tokenizer_missing_byte");
          output.push(id);
        }
      }
      return output;
    },
    decode(ids: readonly number[]): string {
      const output: number[] = [];
      for (const id of ids) {
        if (!Number.isInteger(id) || id < 0 || id >= vocabulary.tokens.length)
          throw Error("reference_tokenizer_id");
        for (const character of vocabulary.tokens[id]) {
          const byte = decodeByte.get(character);
          if (byte === undefined)
            throw Error("reference_tokenizer_special_decode");
          output.push(byte);
        }
      }
      return new TextDecoder("utf-8", { fatal: false }).decode(
        new Uint8Array(output),
      );
    },
  };
}
