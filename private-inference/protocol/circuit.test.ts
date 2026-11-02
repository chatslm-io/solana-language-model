import test from "node:test";
import assert from "node:assert/strict";
import vector from "./circuit-vectors.json";
import {
  encodeCircuitArtifact,
  decodeCircuitArtifact,
  validateGraph,
  encodeCircuitGraph,
  circuitGraphCommitment,
  type CircuitGraph,
} from "./circuit";
const graph = vector.graph as CircuitGraph;
const fromHex = (s: string) => Buffer.from(s, "hex");
test("circuit artifact and graph commitment match independent fixed Python bytes", async () => {
  const artifact = encodeCircuitArtifact(
    graph,
    fromHex(vector.namespaceHex),
    fromHex(vector.inputLabelsHex),
    fromHex(vector.recordsHex),
  );
  assert.equal(Buffer.from(artifact).toString("hex"), vector.artifactHex);
  const decoded = decodeCircuitArtifact(artifact);
  assert.deepEqual(decoded.graph, graph);
  assert.equal(Buffer.from(decoded.records).toString("hex"), vector.recordsHex);
  assert.equal(
    Buffer.from(encodeCircuitGraph(graph)).toString("hex"),
    vector.graphHex,
  );
  assert.equal(
    Buffer.from(await circuitGraphCommitment(graph)).toString("hex"),
    vector.graphHash,
  );
  artifact.fill(0);
  assert.equal(
    Buffer.from(decoded.namespace).toString("hex"),
    vector.namespaceHex,
  );
});
test("circuit parser rejects malformed lengths, reserved fields, cycles, forward references and noncanonical non-AND records", () => {
  const original = fromHex(vector.artifactHex);
  const recordAt = 64 + 8 + 64;
  for (const mutate of [
    (b: Buffer) => {
      b[0] |= 128;
    },
    (b: Buffer) => {
      b[56] = 1;
    },
    (b: Buffer) => {
      b.writeUInt32LE(0, 40);
    },
    (b: Buffer) => {
      b.writeUInt32LE(193, 44);
    },
    (b: Buffer) => {
      b.writeUInt32LE(6, 52);
    },
    (b: Buffer) => {
      b.writeUInt32LE(4, 68);
    },
    (b: Buffer) => {
      b[recordAt + 1] = 1;
    },
    (b: Buffer) => {
      b[recordAt + 12] = 1;
    },
    (b: Buffer) => {
      b.writeUInt32LE(2, recordAt + 4);
    },
    (b: Buffer) => {
      b.writeUInt32LE(1, recordAt + 80 + 8);
    },
    (b: Buffer) => {
      b[recordAt + 160 + 16] = 1;
    },
  ]) {
    const b = Buffer.from(original);
    mutate(b);
    assert.throws(() => decodeCircuitArtifact(b));
  }
  assert.throws(() => decodeCircuitArtifact(original.subarray(0, -1)));
  assert.throws(() =>
    decodeCircuitArtifact(Buffer.concat([original, Buffer.of(0)])),
  );
  assert.throws(() => validateGraph({ ...graph, gates: Array(1) }));
  assert.throws(() => validateGraph({ ...graph, outputs: Array(1) }));
  assert.throws(() => validateGraph({ ...graph, inputCount: 65 }));
  assert.throws(() => validateGraph({ ...graph, outputs: [999] }));
});
