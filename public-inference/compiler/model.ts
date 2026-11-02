/** Complete public checkpoint compilation. Original GGUF tensor bytes and dtype
 * semantics are preserved; no conversation-dependent work occurs here.
 */
import { createHash } from "node:crypto";
import { gguf } from "../../lib/model/formats";
import { canonical } from "../../lib/model/manifest";
import { nativeGGUFInfo } from "../../lib/model/native-gguf";
import { ggufMetadata } from "../../lib/model/gguf-metadata";
import { tokenizerMetadata } from "../../private-inference/reference/tokenizer";
import { selectedTarget } from "../../lib/model/target";
export const SELECTED_TARGET = selectedTarget;
export type PublicTensor = {
  id: number;
  name: string;
  dtype: "Q8_0" | "F16" | "F32";
  shape: readonly number[];
  offset: number;
  bytes: number;
  rowElements: number;
  rows: number;
  slices: number;
  rowBytes: number;
  sha256: string;
};
export type PublicModelPlan = {
  version: 1;
  kind: "public-onchain-model-plan";
  compiler: "slm-public-gguf-v1";
  source: typeof SELECTED_TARGET;
  architecture: "deepseek2-split-mla";
  artifact: { bytes: number; sha256: string };
  dimensions: {
    layers: number;
    hidden: number;
    vocabulary: number;
    heads: number;
    qHead: number;
    vHead: number;
    kvRank: number;
    rotary: number;
    context: number;
    denseLayers: number;
    denseHidden: number;
    experts: number;
    selectedExperts: number;
    expertHidden: number;
    sharedExperts: number;
  };
  numeric: {
    activation: "ggml-scalar-reference";
    accumulation: "binary32-left-to-right";
    rounding: "nearest-ties-even";
    q8IntegerRounding: "nearest-away-from-zero";
    rmsEpsilon: number;
    ropeBase: number;
    expertScale: 1;
    argmaxTies: "lowest-index";
  };
  tensors: readonly PublicTensor[];
  tokenizer: {
    kind: "gpt2-byte-bpe";
    pre: "gpt-2";
    vocabularySha256: string;
    mergesSha256: string;
    templateSha256: string;
    eos: number;
    special: { system: number; user: number; assistant: number; end: number };
  };
};
const sha = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
export async function compileSelectedModel(sourceBytes: Uint8Array): Promise<{
  plan: PublicModelPlan;
  planRoot: string;
  modelBytes: Uint8Array;
}> {
  const bytes = Uint8Array.from(sourceBytes);
  if (
    bytes.length !== SELECTED_TARGET.bytes ||
    sha(bytes) !== SELECTED_TARGET.sha256
  )
    throw Error("public_model_checkpoint_identity");
  const parsed = await gguf(
      SELECTED_TARGET.file,
      bytes.length,
      async (offset, length) => bytes.subarray(offset, offset + length),
    ),
    header = bytes.subarray(0, parsed.metadataBytes);
  if (
    !nativeGGUFInfo(
      "/external-public-model",
      SELECTED_TARGET.file,
      header,
      parsed.tensors,
    )
  )
    throw Error("public_model_architecture");
  const metadata = ggufMetadata(header),
    tokenizer = tokenizerMetadata(header),
    number = (key: string) => {
      const value = metadata.get("deepseek2." + key);
      if (typeof value !== "number" || !Number.isFinite(value))
        throw Error("public_model_metadata");
      return value;
    };
  const tensors: PublicTensor[] = parsed.tensors.map((tensor, id) => {
    if (
      !["Q8_0", "F16", "F32"].includes(tensor.dtype) ||
      tensor.shape.length < 1 ||
      tensor.shape.length > 3
    )
      throw Error("public_model_tensor_format");
    const rowElements = tensor.shape[0],
      rows = tensor.shape[1] ?? 1,
      slices = tensor.shape[2] ?? 1,
      rowBytes =
        tensor.dtype === "Q8_0"
          ? (rowElements / 32) * 34
          : rowElements * (tensor.dtype === "F16" ? 2 : 4);
    if (
      !Number.isInteger(rowBytes) ||
      rowBytes * rows * slices !== tensor.length
    )
      throw Error("public_model_tensor_rows");
    return {
      id,
      name: tensor.name,
      dtype: tensor.dtype as PublicTensor["dtype"],
      shape: [...tensor.shape],
      offset: tensor.offset,
      bytes: tensor.length,
      rowElements,
      rows,
      slices,
      rowBytes,
      sha256: sha(bytes.subarray(tensor.offset, tensor.offset + tensor.length)),
    };
  });
  const token = (value: string) => {
    const id = tokenizer.vocabulary.tokens.indexOf(value);
    if (id < 0) throw Error("public_model_special_token");
    return id;
  };
  if (
    number("expert_weights_scale") !== 1 ||
    tokenizer.vocabulary.pre !== "gpt-2"
  )
    throw Error("public_model_numeric_profile");
  const plan: PublicModelPlan = {
    version: 1,
    kind: "public-onchain-model-plan",
    compiler: "slm-public-gguf-v1",
    source: SELECTED_TARGET,
    architecture: "deepseek2-split-mla",
    artifact: { bytes: bytes.length, sha256: sha(bytes) },
    dimensions: {
      layers: number("block_count"),
      hidden: number("embedding_length"),
      vocabulary: number("vocab_size"),
      heads: number("attention.head_count"),
      qHead: number("attention.key_length_mla"),
      vHead: number("attention.value_length_mla"),
      kvRank: number("attention.kv_lora_rank"),
      rotary: number("rope.dimension_count"),
      context: number("context_length"),
      denseLayers: number("leading_dense_block_count"),
      denseHidden: number("feed_forward_length"),
      experts: number("expert_count"),
      selectedExperts: number("expert_used_count"),
      expertHidden: number("expert_feed_forward_length"),
      sharedExperts: number("expert_shared_count"),
    },
    numeric: {
      activation: "ggml-scalar-reference",
      accumulation: "binary32-left-to-right",
      rounding: "nearest-ties-even",
      q8IntegerRounding: "nearest-away-from-zero",
      rmsEpsilon: number("attention.layer_norm_rms_epsilon"),
      ropeBase: number("rope.freq_base"),
      expertScale: 1,
      argmaxTies: "lowest-index",
    },
    tensors,
    tokenizer: {
      kind: "gpt2-byte-bpe",
      pre: "gpt-2",
      vocabularySha256: sha(canonical(tokenizer.vocabulary.tokens)),
      mergesSha256: sha(canonical(tokenizer.vocabulary.merges)),
      templateSha256: sha(tokenizer.chatTemplate),
      eos: tokenizer.eos,
      special: {
        system: token("<|system|>"),
        user: token("<|user|>"),
        assistant: token("<|assistant|>"),
        end: token("<|end|>"),
      },
    },
  };
  if (
    plan.dimensions.layers !== 4 ||
    plan.dimensions.hidden !== 128 ||
    plan.dimensions.vocabulary !== 8196 ||
    tensors.length !== 62
  )
    throw Error("public_model_target_dimensions");
  return {
    plan,
    planRoot: sha("slm-public:model-plan:v1\n" + canonical(plan)),
    modelBytes: bytes,
  };
}
export function tensorRow(
  plan: PublicModelPlan,
  name: string,
  row: number,
  slice = 0,
): { tensor: PublicTensor; offset: number; bytes: number } {
  const tensor = plan.tensors.find((tensor) => tensor.name === name);
  if (
    !tensor ||
    !Number.isInteger(row) ||
    row < 0 ||
    row >= tensor.rows ||
    !Number.isInteger(slice) ||
    slice < 0 ||
    slice >= tensor.slices
  )
    throw Error("public_model_row");
  return {
    tensor,
    offset: tensor.offset + (slice * tensor.rows + row) * tensor.rowBytes,
    bytes: tensor.rowBytes,
  };
}
