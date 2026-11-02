import { test } from "node:test";
import assert from "node:assert/strict";
import {
  safetensors,
  gguf,
  strictJson,
  bindDependencies,
  selection,
  GGML,
  type Tensor,
} from "../lib/model/formats";
import { canonical } from "../lib/model/manifest";
const join = (...chunks: Uint8Array[]) => Buffer.concat(chunks);
const n32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const n64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s: string) => join(n64(Buffer.byteLength(s)), Buffer.from(s));
function safe(header: unknown, data: Uint8Array) {
  const h = Buffer.from(
    typeof header === "string" ? header : JSON.stringify(header),
  );
  return join(n64(h.length), h, data);
}
const parseSafe = (b: Buffer) =>
  safetensors("model.safetensors", b.length, async (o, n) =>
    b.subarray(o, o + n),
  );
function gg(type = 2, version = 3, shape = 32) {
  const info = join(
    Buffer.from("GGUF"),
    n32(version),
    n64(1),
    n64(0),
    str("blk.0.attn_q.weight"),
    n32(1),
    n64(shape),
    n32(type),
    n64(0),
  );
  const start = Math.ceil(info.length / 32) * 32;
  return join(
    info,
    Buffer.alloc(start - info.length),
    Buffer.alloc(GGML[type]?.[2] || 18, 0x55),
  );
}
const parseGG = (b: Buffer) =>
  gguf("model.gguf", b.length, async (o, n) => b.subarray(o, o + n));
test("Safetensors reads exact offsets and excludes embeddings by default", async () => {
  const b = safe(
    {
      "model.layers.0.weight": {
        dtype: "F16",
        shape: [2],
        data_offsets: [0, 4],
      },
      "model.embed_tokens.weight": {
        dtype: "F16",
        shape: [1],
        data_offsets: [4, 6],
      },
    },
    new Uint8Array([1, 2, 3, 4, 5, 6]),
  );
  const result = await parseSafe(b);
  assert.equal(result.tensors[0].role, "transformer");
  assert.equal(result.tensors[1].role, "offchain learned weights");
  assert.deepEqual(
    [...b.subarray(result.tensors[0].offset, result.tensors[0].offset + 4)],
    [1, 2, 3, 4],
  );
});
test("Safetensors rejects duplicate keys, unknown dtypes, shape/range mismatch, overlaps and trailing bytes", async () => {
  for (const b of [
    safe(
      '{"x":{"dtype":"F16","shape":[1],"data_offsets":[0,2]},"x":{"dtype":"F16","shape":[1],"data_offsets":[0,2]}}',
      new Uint8Array(2),
    ),
    safe(
      { x: { dtype: "MYSTERY", shape: [1], data_offsets: [0, 2] } },
      new Uint8Array(2),
    ),
    safe(
      { x: { dtype: "F32", shape: [1], data_offsets: [0, 2] } },
      new Uint8Array(2),
    ),
    safe(
      {
        x: { dtype: "F16", shape: [1], data_offsets: [0, 2] },
        y: { dtype: "F16", shape: [1], data_offsets: [0, 2] },
      },
      new Uint8Array(2),
    ),
    safe(
      { x: { dtype: "F16", shape: [1], data_offsets: [0, 2] } },
      new Uint8Array(3),
    ),
  ])
    await assert.rejects(parseSafe(b));
  assert.throws(() => strictJson('{"a":1,"a":2}'));
  assert.throws(() => strictJson('{"a":1,}'));
});
test("GGUF preserves full quantization blocks and validates version/type/block dimensions", async () => {
  const b = gg();
  const result = await parseGG(b);
  assert.equal(result.tensors[0].dtype, "Q4_0");
  assert.equal(result.tensors[0].length, 18);
  assert.equal(b[result.tensors[0].offset], 0x55);
  await assert.rejects(parseGG(gg(99)));
  await assert.rejects(parseGG(gg(2, 2)));
  await assert.rejects(parseGG(gg(2, 3, 31)));
  await assert.rejects(parseGG(b.subarray(0, b.length - 1)));
});
test("quantization group selection retains scales, zeros and group indexes", () => {
  const tensors = ["qweight", "qzeros", "scales", "g_idx"].map(
    (n) =>
      ({
        id: n,
        name: `model.layers.0.q_proj.${n}`,
        dtype: "I32",
        length: 4,
        dependencies: [],
      }) as unknown as Tensor,
  );
  bindDependencies(tensors, { quant_method: "gptq" });
  assert.equal(selection(tensors, ["qweight"]).length, 4);
  assert.throws(() =>
    bindDependencies(tensors, { quant_method: "bitsandbytes" }),
  );
  assert.throws(() =>
    bindDependencies(tensors.slice(0, 1), { quant_method: "gptq" }),
  );
});
test("manifest canonicalization is deterministic and retains exact integer layout", () => {
  assert.equal(
    canonical({ b: [2, 1], a: { z: 3, x: 4 } }),
    canonical({ a: { x: 4, z: 3 }, b: [2, 1] }),
  );
});

test("static FP8 selections retain activation scales and reject missing required scales", () => {
  const tensors = ["weight", "weight_scale", "input_scale"].map(
    (name, i) =>
      ({
        id: name,
        name: `model.layers.0.q_proj.${name}`,
        dtype: i === 0 ? "F8_E4M3" : "F32",
        length: 4,
        dependencies: [],
      }) as unknown as Tensor,
  );
  bindDependencies(tensors, {
    quant_method: "fp8",
    activation_scheme: "static",
  });
  assert.equal(selection(tensors, ["weight"]).length, 3);
  assert.throws(
    () =>
      bindDependencies(tensors.slice(0, 2), {
        quant_method: "fp8",
        activation_scheme: "static",
      }),
    /input_scale/,
  );
});
