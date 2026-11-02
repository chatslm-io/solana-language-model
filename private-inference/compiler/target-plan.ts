/** Public fixed-shape operation/resource plan for the inventoried selected target.
 * Not an executable ModelPlan: missing numeric/tokenizer kernels are explicit.
 */
import { CircuitBuilder } from "./circuit";
import { planLiveness } from "./liveness";
import { selectedTarget } from "../../lib/model/target";
export const TARGET_IDENTITY = selectedTarget;
export type TargetOperation = {
  stage: string;
  kind: string;
  instancesPerToken: number;
  shape: readonly number[];
  compilerStatus: "missing" | "public-plan-only";
};
export function selectedTargetResourcePlan(sequencePositions = 40) {
  if (
    !Number.isInteger(sequencePositions) ||
    sequencePositions < 1 ||
    sequencePositions > 1024
  )
    throw Error("target_sequence_bound");
  const dimension = 128,
    vocabulary = 8196,
    layers = 4,
    heads = 4,
    rank = 32,
    rotary = 16,
    valueHead = 16,
    keyHead = 32,
    experts = 8,
    topK = 2,
    expertHidden = 64,
    denseHidden = 352;
  const operations: TargetOperation[] = [];
  const op = (
    stage: string,
    kind: string,
    instancesPerToken: number,
    shape: readonly number[],
    compilerStatus: TargetOperation["compilerStatus"] = "missing",
  ) =>
    operations.push({ stage, kind, instancesPerToken, shape, compilerStatus });
  op("input", "encrypted-byte-template-and-gpt2-bpe", 1, [sequencePositions]);
  op("embedding", "oblivious-public-weight-lookup", 1, [vocabulary, dimension]);
  for (let layer = 0; layer < layers; layer++) {
    const stage = `layer${layer}`;
    op(stage, "binary32-rmsnorm", 2, [dimension]);
    op(stage, "q8_0-matmul", 1, [dimension, heads * keyHead]);
    op(stage, "q8_0-matmul", 1, [dimension, rank + rotary]);
    op(stage, "binary32-rmsnorm", 1, [rank]);
    op(stage, "f16-matmul", heads, [keyHead - rotary, rank]);
    op(stage, "oblivious-encrypted-position-rope", heads + 1, [rotary]);
    op(stage, "authenticated-masked-kv-update", 1, [
      sequencePositions,
      rank + rotary,
    ]);
    op(stage, "binary32-attention-score", heads, [
      sequencePositions,
      rank + rotary,
    ]);
    op(stage, "binary32-softmax-masked", heads, [sequencePositions]);
    op(stage, "binary32-attention-weighted-value", heads, [
      sequencePositions,
      rank,
    ]);
    op(stage, "f16-matmul", heads, [rank, valueHead]);
    op(stage, "q8_0-matmul", 1, [heads * valueHead, dimension]);
    if (layer === 0) {
      op(stage, "q8_0-matmul", 2, [dimension, denseHidden]);
      op(stage, "binary32-silu-and-product", 1, [denseHidden]);
      op(stage, "q8_0-matmul", 1, [denseHidden, dimension]);
    } else {
      op(stage, "f32-router-matmul", 1, [dimension, experts]);
      op(stage, "binary32-sigmoid-routing", 1, [experts]);
      op(stage, "oblivious-stable-top2-and-normalize", 1, [experts, topK]);
      // Evaluate every expert with a fixed schedule. Selection of the two exact
      // outputs is oblivious and retains reference rank order; no masked sum
      // shortcut that silently changes NaN/signed-zero/reduction semantics.
      op(stage, "q8_0-all-experts-matmul", 2 * experts, [
        dimension,
        expertHidden,
      ]);
      op(stage, "binary32-silu-and-product", experts, [expertHidden]);
      op(stage, "q8_0-all-experts-matmul", experts, [expertHidden, dimension]);
      op(stage, "oblivious-gather-selected-expert-outputs", 1, [
        experts,
        topK,
        dimension,
      ]);
      op(stage, "q8_0-shared-expert-matmul", 2, [dimension, expertHidden]);
      op(stage, "binary32-silu-and-product", 1, [expertHidden]);
      op(stage, "q8_0-shared-expert-matmul", 1, [expertHidden, dimension]);
    }
    op(stage, "binary32-residual-add", 2, [dimension], "public-plan-only");
  }
  op("head", "binary32-rmsnorm", 1, [dimension]);
  op("head", "q8_0-matmul", 1, [dimension, vocabulary]);
  op(
    "selection",
    "binary32-ordered-argmax",
    1,
    [vocabulary],
    "public-plan-only",
  );
  op("output", "oblivious-eos-and-dummy-token-padding", 1, [sequencePositions]);
  const matrixProductsPerToken = operations
    .filter((operation) => operation.kind.includes("matmul"))
    .reduce(
      (sum, operation) =>
        sum +
        operation.instancesPerToken * operation.shape[0] * operation.shape[1],
      0,
    );
  const compare = new CircuitBuilder(64, "planning"),
    a = Array.from({ length: 32 }, (_, i) => i),
    b = a.map((i) => i + 32),
    comparePlan = compare.finishPlan([compare.float32OrderedLess(a, b)]),
    liveness = planLiveness(comparePlan);
  const numericKernel = (operation: "float32Add" | "float32Multiply") => {
    const compiler = new CircuitBuilder(64, "planning"),
      left = Array.from({ length: 32 }, (_, i) => i);
    const plan = compiler.finishPlan(
      compiler[operation](
        left,
        left.map((i) => i + 32),
      ),
    );
    const allocation = planLiveness(plan, { eagerInputs: true });
    return {
      ...compiler.resources,
      physicalSlots: allocation.peakSlots,
      physicalLabelBytes: allocation.labelBytes,
      physicalStateBytes: allocation.peakSlots * 40,
      streamingRecordBytes: compiler.gateCount * 96,
      halfGateTableBytes: compiler.resources.and * 64,
    };
  };
  const argmax = new CircuitBuilder(vocabulary * 32, "count-only");
  argmax.float32Argmax(
    Array.from({ length: vocabulary }, (_, i) =>
      Array.from({ length: 32 }, (_, j) => i * 32 + j),
    ),
  );
  return {
    label: "non-executable-target-compilation-preflight",
    target: TARGET_IDENTITY,
    bounds: { sequencePositions, checkpointContextLimit: 1024, batch: 1 },
    operations,
    exactPublicScheduleCounts: {
      matrixProductsPerToken,
      matrixProductsAtPositionBound: matrixProductsPerToken * sequencePositions,
      normsPerToken: layers * 3 + 1,
      expertEvaluationsPerToken: 1 + 3 * (experts + 1),
    },
    exactBooleanCompilerCounts: {
      binary32OrderedCompare: {
        ...compare.resources,
        physicalSlots: liveness.peakSlots,
        physicalLabelBytes: liveness.labelBytes,
      },
      binary32Addition: numericKernel("float32Add"),
      binary32Multiplication: numericKernel("float32Multiply"),
      argmax8196: {
        ...argmax.resources,
        halfGateTableBytes: argmax.resources.and * 64,
        streamingRecordBytes: argmax.gateCount * 96,
      },
    },
    ciphertextStateSizes: {
      labelBytes: 32,
      binary32ScalarBytes: 1024,
      hidden128Bytes: dimension * 1024,
      unstreamedLogitsBytes: vocabulary * 1024,
      compressedKvBytes: layers * (rank + rotary) * sequencePositions * 1024,
    },
    currentV1Limits: {
      inputs: 64,
      wires: 256,
      gates: 192,
      outputs: 32,
      artifactBytes: 17600,
    },
    missingKernels: [
      ...new Set(
        operations
          .filter((operation) => operation.compilerStatus === "missing")
          .map((operation) => operation.kind),
      ),
    ],
    currentV2Limits: {
      inputs: 64,
      slots: 256,
      gates: 1048576,
      outputs: 32,
      workPerWindow: 32,
      profile: "eager-inputs; no lazy page loads",
    },
    requiredEvaluatorExtension:
      "Current v2 executes eager-input bounded numeric kernels with authenticated physical slot reuse. Full target needs authenticated lazy input/model/continuation pages and larger graph commitments; no client intermediate reencoding.",
    numericScope:
      "IEEE754 ordered comparison and RNE add/multiply are implemented as Boolean graphs, with explicit canonical quiet NaN primitive policy. Binary32 divide/sqrt/transcendentals, target quantized activation arithmetic and encrypted tokenizer are not yet compiled. Scalar operation counts are NOT Boolean gate estimates or measured transformer CU.",
  };
}
