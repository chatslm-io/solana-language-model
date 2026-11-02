import assert from "node:assert/strict";
import test from "node:test";
import {
  inventoryDeepseek2,
  missingOperations,
  REQUIRED_DEEPSEEK2_OPERATIONS,
} from "../compiler/inventory";
test("operation preflight exposes target nonlinear and oblivious work before funding", () => {
  const missing = missingOperations(REQUIRED_DEEPSEEK2_OPERATIONS, [
    "fp32-matmul",
  ]);
  for (const op of [
    "gpt2-byte-bpe",
    "rmsnorm-rsqrt",
    "causal-attention-softmax",
    "expert-topk-oblivious",
  ])
    assert(missing.includes(op));
  assert(!missing.includes("fp32-matmul"));
});
test("complete inventory rejects missing source pin, path traversal and invalid GGUF", async () => {
  const source = {
    repo: "fixture/public",
    revision: "a".repeat(40),
    file: "fixture.gguf",
  };
  await assert.rejects(
    inventoryDeepseek2(new Uint8Array(24), { ...source, revision: "main" }),
  );
  await assert.rejects(
    inventoryDeepseek2(new Uint8Array(24), {
      ...source,
      file: "../fixture.gguf",
    }),
  );
  await assert.rejects(inventoryDeepseek2(new Uint8Array(24), source));
});
