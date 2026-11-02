import assert from "node:assert/strict";
import test from "node:test";
import {
  f16,
  decodeQ8_0,
  dot,
  rmsNorm,
  softmax,
  sigmoid,
  silu,
  routeExperts,
  causalAttention,
  toF16Bits,
  quantizeQ8_0Reference,
  dotQ8_0Reference,
} from "../reference/numeric";
test("independent GGML Q8_0 block decoding including signed extrema and FP16 subnormal", () => {
  assert.equal(f16(0x3c00), 1);
  assert.equal(f16(1), 2 ** -24);
  assert.equal(f16(0xc000), -2);
  const bytes = new Uint8Array(34);
  bytes.set([0, 0x38, 0x80, 0x7f, 0xff]);
  assert.deepEqual([...decodeQ8_0(bytes)].slice(0, 4), [-64, 63.5, -0.5, 0]);
  assert.throws(() => decodeQ8_0(bytes.subarray(1)));
  bytes.set([0, 0x7c]);
  assert.throws(() => decodeQ8_0(bytes));
});
test("scalar binary32 normalization, nonlinearities and causal attention", () => {
  assert.equal(dot([1, 2], [3, 4]), 11);
  assert.deepEqual(softmax([1000, 1000]), [0.5, 0.5]);
  assert.equal(sigmoid(0), 0.5);
  assert.equal(silu(0), 0);
  assert.equal(sigmoid(-1000), 0);
  assert.deepEqual(rmsNorm([3, 4], [1, 1], 0.000001), [
    Math.fround(
      3 *
        Math.fround(
          1 / Math.fround(Math.sqrt(Math.fround(12.5 + Math.fround(0.000001)))),
        ),
    ),
    Math.fround(
      4 *
        Math.fround(
          1 / Math.fround(Math.sqrt(Math.fround(12.5 + Math.fround(0.000001)))),
        ),
    ),
  ]);
  assert.deepEqual(
    causalAttention(
      [0, 0],
      [
        [1, 2],
        [3, 4],
      ],
      [
        [2, 4],
        [6, 8],
      ],
    ),
    [4, 6],
  );
  assert.throws(() => softmax([NaN]));
  assert.throws(() => dot([], []));
});
test("MoE routing uses bias only for selection with stable index tie break", () => {
  assert.deepEqual(routeExperts([0, 0, 0], [0, 0, 0], 2), {
    indices: [0, 1],
    weights: [0.5, 0.5],
  });
  assert.deepEqual(routeExperts([0, 0, 0], [0, 2, 1], 2), {
    indices: [1, 2],
    weights: [0.5, 0.5],
  });
  assert.throws(() => routeExperts([0], [0], 2));
});

test("FP16 ties-to-even and complete finite representable roundtrip; scalar Q8 dot", () => {
  assert.equal(toF16Bits(1 + 2 ** -11), 0x3c00);
  assert.equal(toF16Bits(1 + 3 * 2 ** -11), 0x3c02);
  for (let bits = 0; bits < 65536; bits++)
    if ((bits & 0x7c00) !== 0x7c00) assert.equal(toF16Bits(f16(bits)), bits);
  const values = [127, -127, 1, -1, ...Array(28).fill(0)];
  const encoded = quantizeQ8_0Reference(values);
  assert.deepEqual([...decodeQ8_0(encoded)], values);
  assert.equal(dotQ8_0Reference(encoded, encoded), 32260);
  assert.deepEqual(
    [...quantizeQ8_0Reference(Array(32).fill(0))],
    Array(34).fill(0),
  );
});
