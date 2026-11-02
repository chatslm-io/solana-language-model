import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBuilder } from "../compiler/circuit";
import { prepareStreamingCircuit } from "../client/streaming";
import { evaluateStreamingReference } from "../reference/streaming";
import { evaluateClearPlan } from "../reference/circuit";
const bits = (value: number) =>
  Array.from({ length: 32 }, (_, i) => Boolean((value >>> i) & 1));
test("whole-garbling v2 streaming evaluates complete ordered binary32 comparison with reuse across twelve windows", async () => {
  const compiler = new CircuitBuilder(64, "planning"),
    a = Array.from({ length: 32 }, (_, i) => i),
    plan = compiler.finishPlan([
      compiler.float32OrderedLess(
        a,
        a.map((i) => i + 32),
      ),
    ]);
  for (const pair of [
    [0x80000000, 0],
    [0x3f800000, 0x40000000],
    [0x7fc00000, 0x7f800000],
    [0xbf800000, 0x3f800000],
  ]) {
    const input = pair.flatMap(bits),
      prepared = await prepareStreamingCircuit(
        plan,
        crypto.getRandomValues(new Uint8Array(32)),
      ),
      encoded = prepared.encode(input),
      output = await evaluateStreamingReference(
        encoded.descriptor,
        encoded.windows,
      );
    assert.deepEqual(prepared.decode(output), evaluateClearPlan(plan, input));
    assert.equal(prepared.resources.physicalSlots, 126);
    assert.equal(encoded.windows.length, 12);
    assert.throws(() => prepared.encode(input), /single_use/);
    const bad = encoded.windows.map((w) => ({
      ...w,
      records: w.records.slice(),
    }));
    bad[0].records[32] ^= 1;
    await assert.rejects(evaluateStreamingReference(encoded.descriptor, bad));
    prepared.destroy();
  }
});
test("whole-garbling v2 streaming binary32 addition executes5252gates with only155slots", async () => {
  const compiler = new CircuitBuilder(64, "planning"),
    a = Array.from({ length: 32 }, (_, i) => i),
    plan = compiler.finishPlan(
      compiler.float32Add(
        a,
        a.map((i) => i + 32),
      ),
    ),
    input = [...bits(0x3f800000), ...bits(0x33800000)],
    prepared = await prepareStreamingCircuit(
      plan,
      crypto.getRandomValues(new Uint8Array(32)),
    ),
    encoded = prepared.encode(input);
  const output = await evaluateStreamingReference(
    encoded.descriptor,
    encoded.windows,
  );
  assert.deepEqual(prepared.decode(output), evaluateClearPlan(plan, input));
  assert.equal(prepared.resources.physicalSlots, 155);
  assert.equal(encoded.windows.length, 165);
  prepared.destroy();
});

test("streaming snapshots Buffer namespaces before asynchronous whole-graph preparation", async () => {
  const compiler = new CircuitBuilder(2, "planning"),
    plan = compiler.finishPlan([compiler.and(compiler.and(0, 1), 0)]),
    namespace = Buffer.alloc(32),
    pending = prepareStreamingCircuit(plan, namespace);
  namespace.fill(0xff);
  const prepared = await pending,
    encoded = prepared.encode([true, true]),
    output = await evaluateStreamingReference(
      encoded.descriptor,
      encoded.windows,
    );
  assert.deepEqual(prepared.decode(output), [true]);
  assert.deepEqual([...encoded.descriptor.subarray(8, 40)], Array(32).fill(0));
  prepared.destroy();
});

test("whole-garbling v2 streaming binary32 multiplication performs gradual underflow", async () => {
  const compiler = new CircuitBuilder(64, "planning"),
    a = Array.from({ length: 32 }, (_, i) => i),
    plan = compiler.finishPlan(
      compiler.float32Multiply(
        a,
        a.map((i) => i + 32),
      ),
    ),
    input = [...bits(3), ...bits(0x3f000000)],
    prepared = await prepareStreamingCircuit(
      plan,
      crypto.getRandomValues(new Uint8Array(32)),
    ),
    encoded = prepared.encode(input),
    output = await evaluateStreamingReference(
      encoded.descriptor,
      encoded.windows,
    );
  assert.deepEqual(prepared.decode(output), bits(2));
  assert.equal(prepared.resources.physicalSlots, 241);
  assert.equal(encoded.windows.length, 233);
  prepared.destroy();
});

test("streaming rejects sparse public plans before random label allocation", async () => {
  await assert.rejects(
    prepareStreamingCircuit(
      {
        kind: "public-circuit-plan",
        graph: { inputCount: 1, gates: Array(1), outputs: [0] },
      },
      new Uint8Array(32),
    ),
    /liveness_plan_encoding/,
  );
});
