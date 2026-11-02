import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBuilder } from "../compiler/circuit";
import { evaluateClearCircuit } from "../reference/circuit";
const bits = (value: number, width = 8) =>
  Array.from({ length: width }, (_, i) => Boolean((value >> i) & 1));
const word = (bits: readonly boolean[]) =>
  bits.reduce((value, bit, i) => value + (bit ? 2 ** i : 0), 0);
const signed = (value: number) => (value & 128 ? value - 256 : value);
test("compiled signed8 compare agrees with independent integer oracle for all65536 inputs", () => {
  const builder = new CircuitBuilder(16),
    a = Array.from({ length: 8 }, (_, i) => builder.input(i)),
    b = Array.from({ length: 8 }, (_, i) => builder.input(8 + i)),
    graph = builder.finish([builder.signedLess(a, b)]);
  for (let left = 0; left < 256; left++)
    for (let right = 0; right < 256; right++)
      assert.equal(
        evaluateClearCircuit(graph, [...bits(left), ...bits(right)])[0],
        signed(left) < signed(right),
      );
  assert.equal(graph.gates.length, 32);
});
test("compiled wrapping8 addition, select, and exact LUT", () => {
  const builder = new CircuitBuilder(17),
    a = Array.from({ length: 8 }, (_, i) => builder.input(i)),
    b = Array.from({ length: 8 }, (_, i) => builder.input(8 + i));
  const graph = builder.finish([
    ...builder.add(a, b),
    ...builder.muxWord(16, a, b),
  ]);
  for (const left of [0, 1, 127, 128, 255])
    for (const right of [0, 1, 127, 128, 255])
      for (const select of [false, true]) {
        const out = evaluateClearCircuit(graph, [
          ...bits(left),
          ...bits(right),
          select,
        ]);
        assert.equal(word(out.slice(0, 8)), (left + right) & 255);
        assert.equal(word(out.slice(8)), select ? left : right);
      }
  const lut = new CircuitBuilder(3),
    table = [0n, 1n, 4n, 9n, 16n, 25n, 36n, 49n],
    lookup = lut.finish(lut.lookup([0, 1, 2], table, 6));
  for (let i = 0; i < 8; i++)
    assert.equal(
      BigInt(word(evaluateClearCircuit(lookup, bits(i, 3)))),
      table[i],
    );
});
test("compiler capacity is enforced and count-only cannot produce executable graph", () => {
  const small = new CircuitBuilder(1);
  for (let i = 0; i < 192; i++) small.xor(0, 0);
  assert.throws(() => small.xor(0, 0), /capacity/);
  const counter = new CircuitBuilder(1, "count-only");
  for (let i = 0; i < 10000; i++) counter.xor(0, 0);
  assert.equal(counter.resources.gateCount, 10000);
  assert.throws(() => counter.finish([0]), /not_executable/);
  assert.throws(() => new CircuitBuilder(65));
  assert.throws(() => new CircuitBuilder(1).and(0, 1));
});
