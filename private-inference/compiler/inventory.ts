import { createHash } from "node:crypto";
import { gguf } from "../../lib/model/formats";
import { canonical } from "../../lib/model/manifest";
import { ggufMetadata } from "../../lib/model/gguf-metadata";
import { nativeGGUFInfo } from "../../lib/model/native-gguf";
export const REQUIRED_DEEPSEEK2_OPERATIONS = Object.freeze([
  "utf8-template",
  "gpt2-byte-bpe",
  "embedding-oblivious-lookup",
  "q8_0-dequantize",
  "fp32-matmul",
  "rmsnorm-rsqrt",
  "rope-sin-cos",
  "mla-projections",
  "causal-attention-softmax",
  "kv-cache-oblivious-update",
  "silu",
  "sigmoid",
  "expert-topk-oblivious",
  "expert-weight-normalize",
  "residual-add",
  "logits",
  "argmax-stable",
  "eos-oblivious-padding",
]);
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
/** Complete immutable public artifact inventory, deliberately not an executable ModelPlan. */
export async function inventoryDeepseek2(
  bytes: Uint8Array,
  source: { repo: string; revision: string; file: string },
) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo) ||
    !/^[a-f0-9]{40}$/.test(source.revision) ||
    !/^[A-Za-z0-9_.-]+\.gguf$/.test(source.file)
  )
    throw Error("inventory_source");
  if (!bytes.length || bytes.length > 64 * 1024 ** 2)
    throw Error("inventory_size_limit");
  const parsed = await gguf(source.file, bytes.length, async (at, count) =>
    bytes.subarray(at, at + count),
  );
  const header = bytes.subarray(0, parsed.metadataBytes);
  if (
    !nativeGGUFInfo(
      "/external-inventory-only",
      source.file,
      header,
      parsed.tensors,
    )
  )
    throw Error("inventory_architecture");
  const metadata = ggufMetadata(header);
  const dimensions = Object.fromEntries(
    [...metadata].filter(
      ([key, value]) =>
        key.startsWith("deepseek2.") &&
        (typeof value === "number" || typeof value === "boolean"),
    ),
  );
  const inventory = {
    version: 1 as const,
    kind: "complete-artifact-inventory" as const,
    architecture: "deepseek2-split-mla" as const,
    source: { ...source },
    artifact: { bytes: bytes.length, sha256: hash(bytes) },
    header: {
      bytes: parsed.metadataBytes,
      sha256: hash(header),
      contains: [
        "architecture",
        "quantization-layout",
        "gpt2-vocabulary-merges",
        "chat-template",
      ],
    },
    tensors: parsed.tensors
      .map((tensor) => ({
        name: tensor.name,
        shape: tensor.shape,
        dtype: tensor.dtype,
        offset: tensor.offset,
        bytes: tensor.length,
        sha256: hash(
          bytes.subarray(tensor.offset, tensor.offset + tensor.length),
        ),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    dimensions,
    requiredOperations: [...REQUIRED_DEEPSEEK2_OPERATIONS],
  };
  return {
    inventory,
    inventoryRoot: hash(
      "slm-private:complete-inventory:v1\n" + canonical(inventory),
    ),
  };
}
/** Capability preflight is a pure check and must precede funding or artifact uploads. */
export function missingOperations(
  required: readonly string[],
  implemented: readonly string[],
): string[] {
  return [...new Set(required)].filter((op) => !new Set(implemented).has(op));
}
