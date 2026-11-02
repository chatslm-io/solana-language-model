import assert from "node:assert/strict";
import test from "node:test";
import { gpt2Tokenizer, tokenizerMetadata } from "../reference/tokenizer";
test("byte BPE chooses lowest pair rank and merges repeated pairs", () => {
  const tokenizer = gpt2Tokenizer({
    pre: "gpt-2",
    tokens: ["a", "b", "c", "ab", "abc"],
    merges: ["a b", "ab c"],
  });
  assert.deepEqual(tokenizer.encode("abcabc"), [4, 4]);
  assert.equal(tokenizer.decode([4, 4]), "abcabc");
  assert.throws(() => tokenizer.encode("\ud800"));
  assert.throws(() => tokenizer.encode("z"));
  assert.throws(() => tokenizer.decode([-1]));
});
test("tokenizer rejects unsupported metadata and duplicate vocabulary", () => {
  assert.throws(() => tokenizerMetadata(new Uint8Array(24)));
  assert.throws(() =>
    gpt2Tokenizer({ pre: "gpt-2", tokens: ["a", "a"], merges: [] }),
  );
});
