import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import unicode from "../compiler/unicode17.json";
import {
  unicodeClass,
  TOKENIZER_UNICODE_SHA256,
  TOKENIZER_UNICODE_VERSION,
  byteSymbols,
  compileMergeBuckets,
  tokenizerBucket,
} from "../compiler/tokenizer";
test("pinned Unicode17 table matches all codepoints against independent regex properties", () => {
  assert.equal(
    process.versions.unicode,
    TOKENIZER_UNICODE_VERSION,
    "regenerate/review under a different Unicode engine; do not silently change semantics",
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(unicode)).digest("hex"),
    TOKENIZER_UNICODE_SHA256,
  );
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const c = String.fromCodePoint(cp),
      expected =
        (/\p{L}/u.test(c) ? 1 : 0) |
        (/\p{N}/u.test(c) ? 2 : 0) |
        (/\s/u.test(c) ? 4 : 0);
    assert.equal(unicodeClass(cp), expected, `U+${cp.toString(16)}`);
  }
  assert.equal(unicodeClass(0x85), 0);
  assert.equal(unicodeClass(0xa0), 4);
  assert.equal(unicodeClass(0xfeff), 4);
  assert.equal(unicodeClass(0x301), 0);
});
test("merge compiler authenticates absent pairs and preserves rank/result IDs", () => {
  const tokens = [...byteSymbols(), "ab", "aa", "aaa"],
    merges = ["a b", "a a", "aa a"],
    compiled = compileMergeBuckets(tokens, merges);
  assert.equal(new Set(compiled.byteIds).size, 256);
  const ids = new Map(tokens.map((t, i) => [t, i]));
  merges.forEach((m, rank) => {
    const [a, b] = m.split(" "),
      left = ids.get(a)!,
      right = ids.get(b)!,
      bucket = tokenizerBucket(left, right),
      page = Buffer.from(compiled.pages[bucket]);
    assert.equal(page.toString("ascii", 0, 8), "SLMPTB01");
    assert.equal(page.readUInt32LE(8), bucket);
    const entry = compiled.buckets[bucket].find(
      (v) => v.left === left && v.right === right,
    )!;
    assert.equal(entry.rank, rank);
    assert.equal(entry.result, ids.get(a + b));
  });
  assert.throws(
    () => compileMergeBuckets(byteSymbols(), ["a b"]),
    /intermediate_symbol_missing/,
  );
  assert.throws(() => compileMergeBuckets(tokens, ["a b", "a b"]), /duplicate/);
});
