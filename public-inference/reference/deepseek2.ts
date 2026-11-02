/** Independent scalar reference for checking on-chain outputs.
 * Supports the validated uncompressed-Q/split-MLA/sigmoid-MoE layout. */
import { gguf } from "../../lib/model/formats";
import { ggufMetadata } from "../../lib/model/gguf-metadata";
import { nativeGGUFInfo } from "../../lib/model/native-gguf";
import {
  decodeQ8_0,
  f16,
  dot,
  rmsNorm,
  softmax,
  silu,
  routeExperts,
  quantizeQ8_0Reference,
  dotQ8_0Reference,
  toF16Bits,
} from "../../private-inference/reference/numeric";
const f = Math.fround;
type Tensor = {
  shape: number[];
  values: number[];
  dtype: string;
  bytes: Uint8Array;
};
export async function loadPublicReference(
  bytes: Uint8Array,
  activationKernel:
    "dequantized-f32" | "ggml-scalar-reference" = "ggml-scalar-reference",
  trace?: (event: {
    position: number;
    layer: number;
    phase: string;
    values: readonly number[];
  }) => void,
) {
  if (bytes.length > 64 * 1024 ** 2) throw Error("reference_model_bound");
  const parsed = await gguf("model.gguf", bytes.length, async (at, n) =>
    bytes.subarray(at, at + n),
  );
  const header = bytes.subarray(0, parsed.metadataBytes);
  if (
    !nativeGGUFInfo(
      "/external-reference-only",
      "model.gguf",
      header,
      parsed.tensors,
    )
  )
    throw Error("reference_architecture");
  const metadata = ggufMetadata(header),
    tensors = new Map<string, Tensor>();
  for (const tensor of parsed.tensors) {
    const data = bytes.subarray(tensor.offset, tensor.offset + tensor.length),
      view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const values =
      tensor.dtype === "Q8_0"
        ? [...decodeQ8_0(data)]
        : Array.from(
            { length: data.length / (tensor.dtype === "F16" ? 2 : 4) },
            (_, i) =>
              tensor.dtype === "F16"
                ? f16(view.getUint16(i * 2, true))
                : view.getFloat32(i * 4, true),
          );
    if (values.some((v) => !Number.isFinite(v)))
      throw Error("reference_nonfinite_weights");
    tensors.set(tensor.name, {
      shape: tensor.shape,
      values,
      dtype: tensor.dtype,
      bytes: data,
    });
  }
  const number = (key: string) => metadata.get("deepseek2." + key) as number;
  if (number("expert_weights_scale") !== 1)
    throw Error("reference_expert_scale_unsupported");
  const layers = number("block_count"),
    dim = number("embedding_length"),
    heads = number("attention.head_count"),
    qdim = number("attention.key_length_mla"),
    vdim = number("attention.value_length_mla"),
    rope = number("rope.dimension_count"),
    rank = number("attention.kv_lora_rank");
  const epsilon = number("attention.layer_norm_rms_epsilon"),
    base = number("rope.freq_base"),
    context = number("context_length");
  if (
    !Number.isFinite(epsilon) ||
    epsilon <= 0 ||
    !Number.isFinite(base) ||
    base <= 0 ||
    rope % 2
  )
    throw Error("reference_rope_norm");
  // Reject scaling/YaRN rather than silently using ordinary RoPE semantics.
  for (const key of metadata.keys())
    if (key.startsWith("deepseek2.rope.scaling"))
      throw Error("reference_rope_scaling_unsupported");
  const caches: { keys: number[][]; values: number[][] }[] = Array.from(
    { length: layers },
    () => ({ keys: [], values: [] }),
  );
  let position = 0;
  const tensor = (name: string) => {
    const t = tensors.get(name);
    if (!t) throw Error("reference_missing_weight");
    return t;
  };
  const matmul = (name: string, input: number[], slice = 0) => {
    const t = tensor(name),
      [cols, rows] = t.shape;
    if (input.length !== cols || slice < 0 || slice >= (t.shape[2] ?? 1))
      throw Error("reference_matmul_shape");
    if (activationKernel === "ggml-scalar-reference" && t.dtype === "Q8_0") {
      const quantized = quantizeQ8_0Reference(input),
        rowBytes = (cols / 32) * 34;
      return Array.from({ length: rows }, (_, row) =>
        dotQ8_0Reference(
          t.bytes.subarray(
            (slice * rows + row) * rowBytes,
            (slice * rows + row + 1) * rowBytes,
          ),
          quantized,
        ),
      );
    }
    if (activationKernel === "ggml-scalar-reference" && t.dtype === "F16")
      input = input.map((value) => f16(toF16Bits(value)));
    return Array.from({ length: rows }, (_, row) =>
      dot(
        input,
        t.values.slice(
          (slice * rows + row) * cols,
          (slice * rows + row + 1) * cols,
        ),
      ),
    );
  };
  const norm = (input: number[], name: string) =>
    rmsNorm(input, tensor(name).values, epsilon);
  const add = (a: number[], b: number[]) => {
    if (a.length !== b.length) throw Error("reference_add_shape");
    return a.map((v, i) => f(v + b[i]));
  };
  const rotary = (input: number[], pos: number) => {
    if (input.length !== rope) throw Error("reference_rope_shape");
    const out = [...input];
    // GGML_ROPE_TYPE_NORM for deepseek2: rotate consecutive coordinate pairs.
    for (let i = 0; i < rope / 2; i++) {
      const angle = f(pos * base ** ((-2 * i) / rope)),
        c = f(Math.cos(angle)),
        s = f(Math.sin(angle));
      out[2 * i] = f(f(input[2 * i] * c) - f(input[2 * i + 1] * s));
      out[2 * i + 1] = f(f(input[2 * i] * s) + f(input[2 * i + 1] * c));
    }
    return out;
  };
  const ffn = (input: number[], prefix: string, suffix = "", expert = 0) => {
    const up = matmul(prefix + "ffn_up" + suffix + ".weight", input, expert),
      gate = matmul(prefix + "ffn_gate" + suffix + ".weight", input, expert);
    return matmul(
      prefix + "ffn_down" + suffix + ".weight",
      up.map((v, i) => f(v * silu(gate[i]))),
      expert,
    );
  };
  return {
    /** Consumes token IDs only for reference testing; public v1 tokenization is explicitly client-side. */
    step(token: number): { token: number; logits: number[] } {
      const embedding = tensor("token_embd.weight");
      if (
        !Number.isInteger(token) ||
        token < 0 ||
        token >= embedding.shape[1] ||
        position >= context
      )
        throw Error("reference_token_bound");
      let hidden = embedding.values.slice(token * dim, (token + 1) * dim);
      for (let layer = 0; layer < layers; layer++) {
        const prefix = `blk.${layer}.`,
          normalized = norm(hidden, prefix + "attn_norm.weight"),
          q = matmul(prefix + "attn_q.weight", normalized),
          kv = matmul(prefix + "attn_kv_a_mqa.weight", normalized);
        const latent = norm(
            kv.slice(0, rank),
            prefix + "attn_kv_a_norm.weight",
          ),
          key = [...latent, ...rotary(kv.slice(rank), position)];
        trace?.({ position, layer, phase: "kv", values: [...key] });
        caches[layer].keys.push(key);
        caches[layer].values.push(latent);
        const attention: number[] = [];
        for (let head = 0; head < heads; head++) {
          const qh = q.slice(head * qdim, (head + 1) * qdim),
            absorbed = matmul(
              prefix + "attn_k_b.weight",
              qh.slice(0, qdim - rope),
              head,
            ),
            query = [...absorbed, ...rotary(qh.slice(qdim - rope), position)];
          const probabilities = softmax(
            caches[layer].keys.map((k) =>
              f(dot(query, k) * f(1 / Math.sqrt(qdim))),
            ),
          );
          const weighted = Array.from({ length: rank }, (_, col) => {
            let sum = 0;
            for (let row = 0; row < probabilities.length; row++)
              sum = f(
                sum + f(probabilities[row] * caches[layer].values[row][col]),
              );
            return sum;
          });
          const decompressed = matmul(
            prefix + "attn_v_b.weight",
            weighted,
            head,
          );
          if (decompressed.length !== vdim)
            throw Error("reference_value_shape");
          attention.push(...decompressed);
        }
        const residual = add(
            hidden,
            matmul(prefix + "attn_output.weight", attention),
          ),
          feed = norm(residual, prefix + "ffn_norm.weight");
        let output: number[];
        if (layer < number("leading_dense_block_count"))
          output = ffn(feed, prefix);
        else {
          const route = routeExperts(
            matmul(prefix + "ffn_gate_inp.weight", feed),
            tensor(prefix + "exp_probs_b.bias").values,
            number("expert_used_count"),
          );
          output = Array(dim).fill(0);
          for (let selected = 0; selected < route.indices.length; selected++) {
            const expert = ffn(feed, prefix, "_exps", route.indices[selected]);
            output = add(
              output,
              expert.map((v) => f(v * route.weights[selected])),
            );
          }
          output = add(output, ffn(feed, prefix, "_shexp"));
        }
        hidden = add(residual, output);
        trace?.({
          position,
          layer,
          phase: "layer-output",
          values: [...hidden],
        });
      }
      const logits = matmul(
        tensors.has("output.weight") ? "output.weight" : "token_embd.weight",
        norm(hidden, "output_norm.weight"),
      );
      trace?.({ position, layer: -1, phase: "logits", values: [...logits] });
      let selected = 0;
      for (let i = 1; i < logits.length; i++)
        if (logits[i] > logits[selected]) selected = i;
      position++;
      return { token: selected, logits };
    },
    reset() {
      position = 0;
      for (const cache of caches) {
        cache.keys.length = 0;
        cache.values.length = 0;
      }
    },
    dimensions: {
      layers,
      dim,
      heads,
      qdim,
      vdim,
      rope,
      rank,
      context,
      vocabulary: number("vocab_size"),
    },
  };
}
