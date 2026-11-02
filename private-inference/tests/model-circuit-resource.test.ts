import assert from "node:assert/strict";
import test from "node:test";
import { selectedTargetResourcePlan } from "../compiler/target-plan";
test("target preflight counts complete private expert schedule and exposes actual evaluator gaps", () => {
  const plan = selectedTargetResourcePlan(40);
  assert.equal(plan.exactPublicScheduleCounts.matrixProductsPerToken, 1990144);
  assert.equal(plan.ciphertextStateSizes.hidden128Bytes, 131072);
  assert.equal(plan.ciphertextStateSizes.unstreamedLogitsBytes, 8392704);
  assert.equal(plan.ciphertextStateSizes.compressedKvBytes, 7864320);
  assert.equal(plan.exactBooleanCompilerCounts.argmax8196.gateCount, 4253207);
  assert.equal(
    plan.exactBooleanCompilerCounts.argmax8196.halfGateTableBytes,
    105944960,
  );
  assert(
    plan.exactBooleanCompilerCounts.binary32OrderedCompare.physicalSlots < 256,
  );
  assert(plan.missingKernels.includes("encrypted-byte-template-and-gpt2-bpe"));
  assert(plan.missingKernels.includes("binary32-softmax-masked"));
  assert.throws(() => selectedTargetResourcePlan(1025));
});
