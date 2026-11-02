import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBuilder } from "../compiler/circuit";
import { evaluateClearCircuit, evaluateClearPlan } from "../reference/circuit";
const bits = (value: number) =>
  Array.from({ length: 32 }, (_, i) => Boolean((value >>> i) & 1));
const fromBits = (word: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, word, true);
  return view.getFloat32(0, true);
};
const inputs = [
  0, 0x80000000, 0x3f800000, 0xbf800000, 0x7f800000, 0xff800000, 1, 0x80000001,
  0x7f7fffff, 0xff7fffff, 0x7fc00000, 0xffc00000, 0x7f800001, 0x00800000,
  0x80800000,
];
test("exact compiled IEEE binary32 ordered comparison handles finite,subnormal,infinity,NaN,signedzero", () => {
  const builder = new CircuitBuilder(64, "planning"),
    a = Array.from({ length: 32 }, (_, i) => i),
    b = a.map((i) => i + 32),
    plan = builder.finishPlan([builder.float32OrderedLess(a, b)]);
  for (const left of inputs)
    for (const right of inputs)
      assert.equal(
        evaluateClearPlan(plan, [...bits(left), ...bits(right)])[0],
        fromBits(left) < fromBits(right),
      );
  for (let i = 0; i < 2048; i++) {
    const pair = crypto.getRandomValues(new Uint32Array(2));
    assert.equal(
      evaluateClearPlan(plan, [...bits(pair[0]), ...bits(pair[1])])[0],
      fromBits(pair[0]) < fromBits(pair[1]),
    );
  }
  assert(plan.graph.gates.length > 192);
});
test("bounded binary32 total order compares IEEE ordered keys without pretending NaN numerical order", () => {
  const builder = new CircuitBuilder(64),
    a = Array.from({ length: 32 }, (_, i) => i),
    b = a.map((i) => i + 32),
    graph = builder.finish([builder.float32TotalOrderLess(a, b)]);
  const key = (word: number) =>
    word & 0x80000000 ? ~word >>> 0 : (word ^ 0x80000000) >>> 0;
  for (const left of inputs)
    for (const right of inputs)
      assert.equal(
        evaluateClearCircuit(graph, [...bits(left), ...bits(right)])[0],
        key(left) < key(right),
      );
  assert.equal(graph.gates.length, 190);
});
test("compiled IEEE argmax returns first tie with ordered comparison including NaNs", () => {
  const builder = new CircuitBuilder(128, "planning"),
    values = Array.from({ length: 4 }, (_, i) =>
      Array.from({ length: 32 }, (_, j) => i * 32 + j),
    ),
    result = builder.float32Argmax(values),
    plan = builder.finishPlan(result.index);
  for (const values of [
    [0x80000000, 0, 0, 0],
    [0xbf800000, 0x3f800000, 0x3f800000, 0],
    [0x7fc00000, 0x7f800000, 0, 1],
    [0, 0x7fc00000, 0x7f800000, 0xff800000],
  ]) {
    let expected = 0;
    for (let i = 1; i < values.length; i++)
      if (fromBits(values[i]) > fromBits(values[expected])) expected = i;
    const output = evaluateClearPlan(plan, values.flatMap(bits));
    assert.equal(
      output.reduce((n, bit, i) => n + (bit ? 2 ** i : 0), 0),
      expected,
    );
  }
});
