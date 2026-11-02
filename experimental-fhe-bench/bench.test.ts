import test from "node:test";
import assert from "node:assert/strict";
import { FailedTransactionMetadata } from "litesvm";
import {
  harness,
  schoolbook,
  explicitRequest,
  MODULUS,
  benchmark,
} from "./bench";
test("actual SBF upstream NTT matches independent exact negacyclic convolution", async () => {
  const h = await harness();
  for (const n of [32, 64]) {
    const vectors = [
      [Array<number>(n).fill(0), Array<number>(n).fill(MODULUS - 1)],
      [
        Array.from({ length: n }, (_, i) => (i === n - 1 ? 1 : 0)),
        Array.from({ length: n }, (_, i) => (i === 1 ? 1 : 0)),
      ],
      [
        Array.from(
          { length: n },
          (_, i) => (i * 19007 + MODULUS - 2000000) % MODULUS,
        ),
        Array.from({ length: n }, (_, i) => (i * 33013 + 11) % MODULUS),
      ],
      [Array<number>(n).fill(MODULUS - 1), Array<number>(n).fill(MODULUS - 1)],
    ];
    for (const [a, b] of vectors) {
      const { result } = await h.execute(explicitRequest(a, b));
      if (result instanceof FailedTransactionMetadata)
        assert.fail(String(result.err()));
      assert.deepEqual(
        Buffer.from(result.returnData().data()),
        schoolbook(a, b),
      );
      assert.equal(result.innerInstructions().flat().length, 0);
    }
  }
});
test("SBF rejects malformed sizes, coefficients, modes and trailing data", async () => {
  const h = await harness();
  const a = Array<number>(32).fill(0);
  const valid = explicitRequest(a, a),
    coefficient = Buffer.from(valid);
  coefficient.writeUInt32LE(MODULUS, 3);
  const size = Buffer.from(valid);
  size.writeUInt16LE(31, 1);
  const mode = Buffer.from(valid);
  mode[0] = 2;
  for (const input of [
    new Uint8Array(),
    valid.subarray(1),
    Buffer.concat([valid, Buffer.of(0)]),
    coefficient,
    size,
    mode,
  ]) {
    const { result } = await h.execute(input);
    assert.ok(result instanceof FailedTransactionMetadata);
  }
});
test("benchmark reports real budget limits without claiming full FHE", async () => {
  const result = await benchmark();
  assert.ok(result.measurements.filter((x) => x.success).length >= 2);
  assert.ok(result.measurements.some((x) => !x.success));
});
