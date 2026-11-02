import { basename } from "node:path";
import type { Tensor } from "./formats";
import { ggufMetadata } from "./gguf-metadata";
function filename(name: string) {
  if (
    !name ||
    name !== basename(name) ||
    name === "." ||
    name === ".." ||
    /[\\\x00:*?\[\]]/.test(name)
  )
    throw new Error("unsafe_model_filename");
  return name;
}
export function nativeGGUFInfo(
  root: string,
  file: string,
  header: Uint8Array,
  tensors: Tensor[],
) {
  filename(file);
  if (header.length > 16 * 1024 ** 2) throw Error("gguf_header_limit");
  const metadata = ggufMetadata(header);
  if (metadata.get("general.architecture") !== "deepseek2") return undefined;
  const number = (key: string, min = 1, max = 1000000) => {
    const v = metadata.get("deepseek2." + key);
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
      throw Error("unsupported_deepseek2_metadata");
    return v;
  };
  const context = number("context_length", 32, 131072),
    layers = number("block_count", 1, 256),
    dim = number("embedding_length", 1, 65536),
    vocab = number("vocab_size", 1, 1000000),
    heads = number("attention.head_count", 1, 256),
    kv = number("attention.kv_lora_rank", 1, 65536),
    rope = number("rope.dimension_count", 1, 512),
    qhead = number("attention.key_length_mla", 1, 1024),
    vhead = number("attention.value_length_mla", 1, 1024),
    dense = number("leading_dense_block_count", 0, layers - 1),
    ffn = number("feed_forward_length", 1, 1000000),
    experts = number("expert_count", 1, 1024),
    used = number("expert_used_count", 1, experts),
    shared = number("expert_shared_count", 1, 16),
    moe = number("expert_feed_forward_length", 1, 1000000);
  void used;
  // Reviewed native layout: uncompressed queries, split MLA K/V, sigmoid MoE.
  if (
    number("attention.q_lora_rank", 0, 0) !== 0 ||
    qhead <= rope ||
    metadata.get("deepseek2.expert_gating_func") !== 2 ||
    metadata.get("deepseek2.expert_weights_norm") !== true ||
    number("expert_group_count", 1, 1) !== 1 ||
    number("expert_group_used_count", 1, 1) !== 1 ||
    metadata.get("tokenizer.ggml.model") !== "gpt2" ||
    (metadata.get("tokenizer.ggml.tokens") as { count?: number })?.count !==
      vocab ||
    typeof metadata.get("tokenizer.chat_template") !== "string" ||
    !(metadata.get("tokenizer.chat_template") as string).length ||
    (metadata.get("tokenizer.chat_template") as string).length > 65536
  )
    throw Error("unsupported_deepseek2_metadata");
  const eos = metadata.get("tokenizer.ggml.eos_token_id");
  if (
    typeof eos !== "number" ||
    !Number.isSafeInteger(eos) ||
    eos < 0 ||
    eos >= vocab
  )
    throw Error("invalid_embedded_tokenizer");
  const expected = new Map<string, number[]>([
    ["token_embd.weight", [dim, vocab]],
    ["output_norm.weight", [dim]],
  ]);
  for (let i = 0; i < layers; i++) {
    const prefix = `blk.${i}.`;
    for (const [name, shape] of Object.entries({
      "attn_q.weight": [dim, heads * qhead],
      "attn_kv_a_mqa.weight": [dim, kv + rope],
      "attn_kv_a_norm.weight": [kv],
      "attn_k_b.weight": [qhead - rope, kv, heads],
      "attn_v_b.weight": [kv, vhead, heads],
      "attn_output.weight": [heads * vhead, dim],
      "attn_norm.weight": [dim],
      "ffn_norm.weight": [dim],
    }))
      expected.set(prefix + name, shape);
    const weights =
      i < dense
        ? {
            "ffn_gate.weight": [dim, ffn],
            "ffn_up.weight": [dim, ffn],
            "ffn_down.weight": [ffn, dim],
          }
        : {
            "ffn_gate_inp.weight": [dim, experts],
            "exp_probs_b.bias": [experts],
            "ffn_gate_exps.weight": [dim, moe, experts],
            "ffn_up_exps.weight": [dim, moe, experts],
            "ffn_down_exps.weight": [moe, dim, experts],
            "ffn_gate_shexp.weight": [dim, moe * shared],
            "ffn_up_shexp.weight": [dim, moe * shared],
            "ffn_down_shexp.weight": [moe * shared, dim],
          };
    for (const [name, shape] of Object.entries(weights))
      expected.set(prefix + name, shape!);
  }
  if (tensors.some((t) => t.name === "output.weight"))
    expected.set("output.weight", [dim, vocab]);
  if (
    tensors.length !== expected.size ||
    new Set(tensors.map((t) => t.name)).size !== expected.size ||
    tensors.some(
      (t) =>
        JSON.stringify(t.shape) !== JSON.stringify(expected.get(t.name)) ||
        !["F32", "F16", "Q8_0"].includes(t.dtype),
    )
  )
    throw Error("unsupported_deepseek2_tensor_layout");
  return { root, file, tensors, contextLength: context };
}
