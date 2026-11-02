import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBuilder } from "../compiler/circuit";
import { planLiveness } from "../compiler/liveness";
import { evaluateClearPlan } from "../reference/circuit";
const bits = (value: number) =>
  Array.from({ length: 32 }, (_, i) => Boolean((value >>> i) & 1));
test("public liveness schedule preserves ordered binary32 graph with slot reuse and lazy input loading", () => {
  const builder = new CircuitBuilder(64, "planning"),
    a = Array.from({ length: 32 }, (_, i) => i),
    b = a.map((i) => i + 32),
    plan = builder.finishPlan([builder.float32OrderedLess(a, b)]),
    schedule = planLiveness(plan);
  assert(schedule.peakSlots < 256);
  assert(
    schedule.operations.some(
      (operation) =>
        operation.output === operation.lhs ||
        operation.output === operation.rhs,
    ),
  );
  for (let trial = 0; trial < 100; trial++) {
    const values = crypto.getRandomValues(new Uint32Array(2)),
      input = [...bits(values[0]), ...bits(values[1])],
      slots: boolean[] = Array(schedule.peakSlots);
    for (const operation of schedule.operations) {
      for (const load of operation.loads)
        slots[load.slot] = input[load.inputWire];
      const lhs = slots[operation.lhs],
        rhs = slots[operation.rhs];
      slots[operation.output] =
        operation.op === 0
          ? lhs && rhs
          : operation.op === 1
            ? lhs !== rhs
            : !lhs;
    }
    for (const load of schedule.finalLoads)
      slots[load.slot] = input[load.inputWire];
    assert.deepEqual(
      schedule.outputSlots.map((slot) => slots[slot]),
      evaluateClearPlan(plan, input),
    );
  }
});
test("liveness handles repeated source wires and outputs from otherwise-unused original inputs", () => {
  const builder = new CircuitBuilder(4, "planning"),
    zero = builder.xor(0, 0),
    plan = builder.finishPlan([zero, 3]),
    schedule = planLiveness(plan);
  assert.deepEqual(
    schedule.finalLoads.map((load) => load.inputWire),
    [3],
  );
  assert.equal(schedule.operations[0].loads.length, 1);
});

test("liveness rejects sparse public gates and outputs before any ciphertext work", () => {
  assert.throws(
    () =>
      planLiveness({
        kind: "public-circuit-plan",
        graph: { inputCount: 1, gates: Array(1), outputs: [0] },
      }),
    /encoding/,
  );
  assert.throws(
    () =>
      planLiveness({
        kind: "public-circuit-plan",
        graph: {
          inputCount: 1,
          gates: [{ op: 2, lhs: 0, rhs: 0 }],
          outputs: Array(1),
        },
      }),
    /encoding/,
  );
  const builder = new CircuitBuilder(1, "planning");
  builder.not(0);
  assert.throws(() => builder.finishPlan(Array(1)), /wire/);
});
