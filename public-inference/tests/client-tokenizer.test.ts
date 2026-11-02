import assert from "node:assert/strict";
import test from "node:test";
import { publicTokenizer } from "../client/tokenizer";
import type { PublicModelPlan } from "../compiler/model";
import { canonical } from "../../lib/model/manifest";
import { createHash } from "node:crypto";
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
test("public tokenizer binds inventory and declares local scope", () => {
  const vocabulary = { tokens: ["a"], merges: [], pre: "gpt-2" as const },
    template = "test-only-template",
    plan = {
      tokenizer: {
        vocabularySha256: sha(canonical(vocabulary.tokens)),
        mergesSha256: sha(canonical(vocabulary.merges)),
        templateSha256: sha(template),
        special: { system: 8192, user: 8193, assistant: 8194, end: 8195 },
      },
    } as unknown as PublicModelPlan;
  const tokenizer = publicTokenizer(plan, vocabulary, template);
  assert.equal(tokenizer.scope, "client-tokenization-public-inputs");
  assert.deepEqual(
    tokenizer.encodeMessages([{ role: "user", content: "a" }], 1),
    { tokens: [8193, 0, 8195, 8194], generationTokens: 1 },
  );
  assert.throws(
    () => tokenizer.encodeMessages([{ role: "user", content: "a" }], 13),
    /context_16/,
  );
  assert.throws(
    () => publicTokenizer(plan, { ...vocabulary, tokens: ["b"] }, template),
    /identity/,
  );
});
