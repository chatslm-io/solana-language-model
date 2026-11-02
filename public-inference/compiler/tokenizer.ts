/** Public model-specific tokenizer data compilation only. All text splitting,
 * byte encoding, merge selection and role-template application execute in SBF. */
import { createHash } from "node:crypto";
import { gguf } from "../../lib/model/formats";
import { tokenizerMetadata } from "../../private-inference/reference/tokenizer";
import { compileSelectedModel } from "./model";
import unicode from "./unicode17.json";
import { TOKENIZER_PROFILE_ROOT } from "../tokenizer-protocol";
export const TOKENIZER_UNICODE_VERSION = "17.0";
export const TOKENIZER_UNICODE_SHA256 =
  "d2b32b701b7c49dd6c0678b1b71c4f3132b96b790e0b3021d35f9db3db49c499";
export const TOKENIZER_LIMITS = Object.freeze({
  buckets: 32,
  maxBucketEntries: 511,
  maxInputBytes: 512,
  maxMessages: 4,
  descriptorBytes: 1120,
  byteMapOffset: 96,
});
export type TokenizerMerge = {
  left: number;
  right: number;
  result: number;
  rank: number;
};
export function tokenizerBucket(left: number, right: number) {
  const h = (Math.imul(left, 0x9e3779b1) ^ Math.imul(right, 0x85ebca77)) >>> 0;
  return (h ^ (h >>> 16)) & 31;
}
export function unicodeClass(codepoint: number): number {
  if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff)
    throw Error("tokenizer_unicode_scalar");
  let low = 0,
    high = unicode.ranges.length;
  while (low < high) {
    const mid = (low + high) >>> 1,
      [start, end, mask] = unicode.ranges[mid];
    if (codepoint < start) high = mid;
    else if (codepoint > end) low = mid + 1;
    else return mask;
  }
  return 0;
}
export function byteSymbols(): string[] {
  const codes = [
      ...Array.from({ length: 94 }, (_, i) => i + 33),
      ...Array.from({ length: 12 }, (_, i) => i + 161),
      ...Array.from({ length: 82 }, (_, i) => i + 174),
    ],
    characters = [...codes];
  let extra = 0;
  for (let byte = 0; byte < 256; byte++)
    if (!codes.includes(byte)) {
      codes.push(byte);
      characters.push(256 + extra++);
    }
  const out = Array<string>(256);
  codes.forEach((byte, i) => (out[byte] = String.fromCodePoint(characters[i])));
  return out;
}
/** Check every intermediate pair/result against the vocabulary. A missing symbol
 * is a hard unsupported-checkpoint error, never a client-side fallback. */
export function compileMergeBuckets(
  tokens: readonly string[],
  merges: readonly string[],
) {
  const ids = new Map(tokens.map((token, id) => [token, id]));
  if (ids.size !== tokens.length || new Set(merges).size !== merges.length)
    throw Error("tokenizer_duplicate_inventory");
  const lookup = (symbol: string) => {
    const id = ids.get(symbol);
    if (id === undefined) throw Error("tokenizer_intermediate_symbol_missing");
    return id;
  };
  const byteIds = byteSymbols().map(lookup),
    buckets: TokenizerMerge[][] = Array.from({ length: 32 }, () => []);
  merges.forEach((pair, rank) => {
    const parts = pair.split(" ");
    if (parts.length !== 2 || parts.some((v) => v.length === 0))
      throw Error("tokenizer_merge_syntax");
    const left = lookup(parts[0]),
      right = lookup(parts[1]),
      result = lookup(parts[0] + parts[1]);
    buckets[tokenizerBucket(left, right)].push({ left, right, result, rank });
  });
  const pages = buckets.map((bucket, index) => {
    if (bucket.length > 511) throw Error("tokenizer_bucket_capacity");
    bucket.sort((a, b) => a.left - b.left || a.right - b.right);
    const page = Buffer.alloc(16 + bucket.length * 16);
    page.write("SLMPTB01");
    page.writeUInt32LE(index, 8);
    page.writeUInt32LE(bucket.length, 12);
    bucket.forEach((v, i) =>
      [v.left, v.right, v.result, v.rank].forEach((n, j) =>
        page.writeUInt32LE(n, 16 + i * 16 + j * 4),
      ),
    );
    return Uint8Array.from(page);
  });
  return { byteIds, buckets, pages };
}
export async function compileTokenizer(bytes: Uint8Array) {
  const { plan, planRoot, modelBytes } = await compileSelectedModel(bytes);
  if (
    unicode.version !== TOKENIZER_UNICODE_VERSION ||
    createHash("sha256").update(JSON.stringify(unicode)).digest("hex") !==
      TOKENIZER_UNICODE_SHA256
  )
    throw Error("tokenizer_unicode_identity");
  const parsed = await gguf("pinned.gguf", modelBytes.length, async (at, n) =>
      modelBytes.subarray(at, at + n),
    ),
    metadata = tokenizerMetadata(modelBytes.subarray(0, parsed.metadataBytes));
  const { byteIds, buckets, pages } = compileMergeBuckets(
      metadata.vocabulary.tokens,
      metadata.vocabulary.merges,
    ),
    descriptor = Buffer.alloc(1120);
  descriptor.write("SLMPTD01");
  descriptor.writeUInt32LE(1, 8);
  descriptor.writeUInt32LE(32, 12);
  descriptor.writeUInt32LE(8196, 16);
  descriptor.writeUInt32LE(metadata.vocabulary.merges.length, 20);
  descriptor.set(Buffer.from(TOKENIZER_UNICODE_SHA256, "hex"), 24);
  descriptor.writeUInt32LE(512, 56);
  [
    plan.tokenizer.special.system,
    plan.tokenizer.special.user,
    plan.tokenizer.special.assistant,
    plan.tokenizer.special.end,
  ].forEach((id, i) => descriptor.writeUInt32LE(id, 64 + i * 4));
  descriptor.writeUInt32LE(4, 80);
  byteIds.forEach((id, i) => descriptor.writeUInt32LE(id, 96 + i * 4));
  return {
    pages: [Uint8Array.from(descriptor), ...pages],
    descriptor: Uint8Array.from(descriptor),
    profileRoot: TOKENIZER_PROFILE_ROOT,
    modelPlanRoot: planRoot,
    sourceSha: plan.source.sha256,
    profile: {
      version: 1,
      scope: "onchain-gpt2-byte-bpe-and-role-template",
      unicodeVersion: TOKENIZER_UNICODE_VERSION,
      unicodeSha256: TOKENIZER_UNICODE_SHA256,
      vocabularySha256: plan.tokenizer.vocabularySha256,
      mergesSha256: plan.tokenizer.mergesSha256,
      templateSha256: plan.tokenizer.templateSha256,
      maxInputBytes: 512,
      maxMessages: 4,
      merges: metadata.vocabulary.merges.length,
      bucketCount: 32,
      maxBucketEntries: Math.max(...buckets.map((b) => b.length)),
    },
  };
}
