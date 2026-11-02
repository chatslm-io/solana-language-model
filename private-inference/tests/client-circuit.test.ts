import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBuilder } from "../compiler/circuit";
import { prepareCircuit } from "../client/circuit";
import { evaluateGarbledCircuit } from "../reference/garbled-circuit";
import { evaluateClearCircuit } from "../reference/circuit";
import { decodeCircuitArtifact } from "../protocol/circuit";
const bits = (value: number) =>
  Array.from({ length: 8 }, (_, i) => Boolean((value >> i) & 1));
test("fresh whole-circuit garblings implement signed compare/add/mux with independent decoder", async () => {
  const builder = new CircuitBuilder(16),
    a = Array.from({ length: 8 }, (_, i) => i),
    b = a.map((i) => i + 8),
    less = builder.signedLess(a, b),
    sum = builder.add(a, b),
    selected = builder.muxWord(less, a, b),
    graph = builder.finish([less, ...sum, ...selected]);
  const cases = [
    [0, 0],
    [128, 127],
    [255, 0],
    [127, 128],
    [0, 255],
    [255, 255],
  ];
  for (let trial = 0; trial < 24; trial++) {
    const pair =
        trial < cases.length
          ? cases[trial]
          : [
              crypto.getRandomValues(new Uint8Array(1))[0],
              crypto.getRandomValues(new Uint8Array(1))[0],
            ],
      input = [...bits(pair[0]), ...bits(pair[1])];
    const prepared = await prepareCircuit(
        graph,
        crypto.getRandomValues(new Uint8Array(32)),
      ),
      artifact = prepared.encode(input),
      output = evaluateGarbledCircuit(artifact);
    assert.deepEqual(
      prepared.decode(output),
      evaluateClearCircuit(graph, input),
    );
    assert.throws(() => prepared.encode(input), /single_use/);
    const modified = output.slice();
    modified[3] ^= 1;
    assert.throws(() => prepared.decode(modified), /authentication/);
    const decoded = decodeCircuitArtifact(artifact);
    assert.equal(decoded.graph.gates.length, graph.gates.length);
    prepared.destroy();
    assert.throws(() => prepared.decode(output), /state/);
  }
});
test("whole-circuit graph is copied before asynchronous hashing, AND/XOR/NOT and constants conform", async () => {
  const builder = new CircuitBuilder(2),
    and = builder.and(0, 1),
    not = builder.not(and),
    xor = builder.xor(0, 1),
    constant = builder.constant(true),
    source = builder.finish([and, not, xor, constant]);
  for (const a of [false, true])
    for (const b of [false, true]) {
      const mutable = {
          inputCount: source.inputCount,
          gates: source.gates.map((g) => ({ ...g })),
          outputs: [...source.outputs],
        },
        promise = prepareCircuit(mutable, new Uint8Array(32));
      mutable.gates[0].op = 1;
      mutable.outputs[0] = 0;
      const prepared = await promise;
      const artifact = prepared.encode([a, b]);
      assert.deepEqual(prepared.decode(evaluateGarbledCircuit(artifact)), [
        a && b,
        !(a && b),
        a !== b,
        true,
      ]);
      prepared.destroy();
    }
});

test("client rejects sparse/malformed inputs and namespaces without consuming valid single use; destroy blocks encoding", async () => {
  const builder = new CircuitBuilder(2),
    graph = builder.finish([builder.and(0, 1)]);
  await assert.rejects(
    prepareCircuit(graph, { length: 32 } as unknown as Uint8Array),
    /namespace/,
  );
  const prepared = await prepareCircuit(graph, new Uint8Array(32));
  assert.throws(() => prepared.encode(Array<boolean>(2)), /input_shape/);
  assert.throws(() => prepared.encode([true]), /input_shape/);
  const artifact = prepared.encode([true, false]);
  assert.deepEqual(prepared.decode(evaluateGarbledCircuit(artifact)), [false]);
  prepared.destroy();
  const unused = await prepareCircuit(graph, new Uint8Array(32));
  unused.destroy();
  assert.throws(() => unused.encode([true, true]), /single_use/);
});

test("caller Buffer namespace mutation cannot change a garbling after preparation starts", async () => {
  const builder = new CircuitBuilder(2),
    first = builder.and(0, 1),
    graph = builder.finish([builder.and(first, 0)]),
    namespace = Buffer.alloc(32),
    promise = prepareCircuit(graph, namespace);
  namespace.fill(0xff);
  const prepared = await promise,
    artifact = prepared.encode([true, true]);
  assert.deepEqual(
    [...decodeCircuitArtifact(artifact).namespace],
    Array(32).fill(0),
  );
  assert.deepEqual(prepared.decode(evaluateGarbledCircuit(artifact)), [true]);
  prepared.destroy();
});
