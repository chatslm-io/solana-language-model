import assert from "node:assert/strict";
import test from "node:test";
import vectors from "../reference/binary32-vectors.json";
import { CircuitBuilder } from "../compiler/circuit";
import { evaluateClearPlan } from "../reference/circuit";
const bits = (word: number) =>
  Array.from({ length: 32 }, (_, i) => Boolean((word >>> i) & 1));
const raw = (value: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};
const value = (word: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, word, true);
  return view.getFloat32(0, true);
};
const inputs = [
  0, 0x80000000, 1, 2, 0x7fffff, 0x800000, 0x807fffff, 0x80800000, 0x3f800000,
  0xbf800000, 0x3f800001, 0x33800000, 0x33000000, 0x7f7fffff, 0xff7fffff,
  0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 0xffc00000,
];
test("compiled binary32 add RNE agrees with Math.fround including gradual underflow, signedzeros, infinities and NaNs", () => {
  const compiler = new CircuitBuilder(64, "planning"),
    a = Array.from({ length: 32 }, (_, i) => i),
    b = a.map((i) => i + 32),
    plan = compiler.finishPlan(compiler.float32Add(a, b));
  const check = (left: number, right: number) => {
    const expected = Math.fround(value(left) + value(right)),
      out = evaluateClearPlan(plan, [...bits(left), ...bits(right)]),
      actual = out.reduce(
        (word, bit, i) => (word + (bit ? 2 ** i : 0)) >>> 0,
        0,
      );
    if (Number.isNaN(expected)) assert.equal(actual, 0x7fc00000);
    else
      assert.equal(
        actual,
        raw(expected),
        `left=${left.toString(16)} right=${right.toString(16)}`,
      );
  };
  for (const vector of vectors.vectors) {
    const left = Number.parseInt(vector.a, 16),
      right = Number.parseInt(vector.b, 16);
    const out = evaluateClearPlan(plan, [...bits(left), ...bits(right)]);
    assert.equal(
      out.reduce((word, bit, i) => (word + (bit ? 2 ** i : 0)) >>> 0, 0),
      Number.parseInt(vector.add, 16),
    );
  }
  for (const left of inputs) for (const right of inputs) check(left, right);
  for (let i = 0; i < 4096; i++) {
    const pair = crypto.getRandomValues(new Uint32Array(2));
    check(pair[0], pair[1]);
  }
});
