/** Public onchain tokenizer registry and authenticated immutable table pages. */
import { sha256 } from "./protocol";
export const TOKENIZER_PROFILE_ROOT = sha256(
  "slm-public:gpt2-unicode17-messages4-bytes512:v1\n",
);
export const TOKENIZER_LIMITS = Object.freeze({
  pages: 33,
  pageBytes: 8192,
  inputBytes: 512,
  messages: 4,
  vocabulary: 8196,
});
export type TokenizerBinding = {
  model: string;
  modelBinding: string;
  sourceSha: string;
  tableRoot: string;
  profileRoot: string;
  unicodeSha: string;
  pageCount: 33;
  maxInputBytes: 512;
  maxMessages: 4;
  vocabulary: 8196;
};
const hex = (s: string) => {
  if (!/^[0-9a-f]{64}$/.test(s)) throw Error("tokenizer_digest");
  return Buffer.from(s, "hex");
};
export function encodeTokenizerBinding(v: TokenizerBinding) {
  if (
    Object.keys(v).length !== 10 ||
    v.pageCount !== 33 ||
    v.maxInputBytes !== 512 ||
    v.maxMessages !== 4 ||
    v.vocabulary !== 8196
  )
    throw Error("tokenizer_binding");
  const b = Buffer.alloc(224);
  b.write("SLMPTB01");
  [
    v.model,
    v.modelBinding,
    v.sourceSha,
    v.tableRoot,
    v.profileRoot,
    v.unicodeSha,
  ].forEach((s, i) => hex(s).copy(b, 8 + i * 32));
  [v.pageCount, v.maxInputBytes, v.maxMessages, v.vocabulary].forEach((n, i) =>
    b.writeUInt32LE(n, 200 + 4 * i),
  );
  return b;
}
export const tokenizerCommitment = (v: TokenizerBinding) =>
  sha256(
    Buffer.concat([
      Buffer.from("slm-public:tokenizer:v1\n"),
      encodeTokenizerBinding(v),
    ]),
  );
export function tokenizerLeaf(
  index: number,
  length: number,
  payloadHash: string,
) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= 64 ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > 8192 ||
    index < 33 !== length > 0
  )
    throw Error("tokenizer_page");
  const b = Buffer.alloc(8);
  b.writeUInt32LE(index);
  b.writeUInt32LE(length, 4);
  return sha256(
    Buffer.concat([
      Buffer.from("slm-public:tokenizer-page:v1\n"),
      b,
      hex(payloadHash),
    ]),
  );
}
const parent = (a: string, b: string) =>
  sha256(
    Buffer.concat([
      Buffer.from("slm-public:tokenizer-node:v1\n"),
      hex(a),
      hex(b),
    ]),
  );
export function buildTokenizerPages(payloads: readonly Uint8Array[]) {
  if (payloads.length !== 33) throw Error("tokenizer_pages");
  const pages = payloads.map((p, index) => ({
    index,
    payload: Uint8Array.from(p),
    hash: sha256(p),
    proof: [] as string[],
  }));
  const levels = [
    Array.from({ length: 64 }, (_, i) =>
      i < 33
        ? tokenizerLeaf(i, pages[i].payload.length, pages[i].hash)
        : tokenizerLeaf(i, 0, sha256(new Uint8Array())),
    ),
  ];
  while (levels.at(-1)!.length > 1) {
    const last = levels.at(-1)!;
    levels.push(
      Array.from({ length: last.length / 2 }, (_, i) =>
        parent(last[2 * i], last[2 * i + 1]),
      ),
    );
  }
  for (const p of pages)
    for (let level = 0, index = p.index; level < 6; level++, index >>= 1)
      p.proof.push(levels[level][index ^ 1]);
  return { root: levels.at(-1)![0], pages };
}
export type TokenizerPage = ReturnType<
  typeof buildTokenizerPages
>["pages"][number];
