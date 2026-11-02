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
  0, 0x80000000, 1, 2, 3, 0x7fffff, 0x800000, 0x807fffff, 0x80800000,
  0x3f000000, 0x3f800000, 0xbf800000, 0x3f800001, 0x3f7fffff, 0x33800000,
  0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001,
];
test("compiled binary32 multiply RNE agrees with independent Python fixtures and Math.fround", () => {
  const compiler = new CircuitBuilder(64, "planning"),
    a = Array.from({ length: 32 }, (_, i) => i),
    plan = compiler.finishPlan(
      compiler.float32Multiply(
        a,
        a.map((i) => i + 32),
      ),
    );
  const evaluate = (left: number, right: number) =>
    evaluateClearPlan(plan, [...bits(left), ...bits(right)]).reduce(
      (word, bit, i) => (word + (bit ? 2 ** i : 0)) >>> 0,
      0,
    );
  for (const vector of vectors.vectors)
    assert.equal(
      evaluate(Number.parseInt(vector.a, 16), Number.parseInt(vector.b, 16)),
      Number.parseInt(vector.multiply, 16),
      `${vector.a}*${vector.b}`,
    );
  const check = (left: number, right: number) => {
    const expected = Math.fround(value(left) * value(right));
    assert.equal(
      evaluate(left, right),
      Number.isNaN(expected) ? 0x7fc00000 : raw(expected),
      `${left.toString(16)}*${right.toString(16)}`,
    );
  };
  for (const left of inputs) for (const right of inputs) check(left, right);
  for (let i = 0; i < 4096; i++) {
    const pair = crypto.getRandomValues(new Uint32Array(2));
    check(pair[0], pair[1]);
  }
});
