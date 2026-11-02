/** Experimental bounded Boolean circuits. Browser-compatible canonical codecs.
 * Artifact authentication is separate from trusted model compilation and cryptographic review.
 */
export const CIRCUIT_LIMITS = Object.freeze({
  inputs: 64,
  gates: 192,
  wires: 256,
  outputs: 32,
  work: 32,
  bytes: 17600,
});
export type CircuitGate = Readonly<{ op: 0 | 1 | 2; lhs: number; rhs: number }>;
export type CircuitGraph = Readonly<{
  inputCount: number;
  gates: readonly CircuitGate[];
  outputs: readonly number[];
}>;
const magic = new TextEncoder().encode("SLMGC001");
function requireCondition(ok: boolean): asserts ok {
  if (!ok) throw Error("invalid_circuit_encoding");
}
function integer(value: number, low: number, high: number) {
  requireCondition(
    Number.isSafeInteger(value) && value >= low && value <= high,
  );
}
function fields(value: object, expected: string[]) {
  requireCondition(value !== null && typeof value === "object");
  const actual = Object.keys(value).sort();
  requireCondition(
    actual.length === expected.length &&
      actual.every((key, i) => key === expected.sort()[i]),
  );
}
export function validateGraph(graph: CircuitGraph): void {
  fields(graph, ["inputCount", "gates", "outputs"]);
  integer(graph.inputCount, 1, CIRCUIT_LIMITS.inputs);
  requireCondition(Array.isArray(graph.gates) && Array.isArray(graph.outputs));
  integer(graph.gates.length, 1, CIRCUIT_LIMITS.gates);
  integer(graph.inputCount + graph.gates.length, 2, CIRCUIT_LIMITS.wires);
  integer(graph.outputs.length, 1, CIRCUIT_LIMITS.outputs);
  Array.from(graph.gates).forEach((gate, index) => {
    fields(gate, ["op", "lhs", "rhs"]);
    integer(gate.op, 0, 2);
    integer(gate.lhs, 0, graph.inputCount + index - 1);
    integer(gate.rhs, 0, graph.inputCount + index - 1);
    requireCondition(gate.op !== 2 || gate.rhs === 0);
  });
  Array.from(graph.outputs).forEach((wire) =>
    integer(wire, 0, graph.inputCount + graph.gates.length - 1),
  );
  requireCondition(new Set(graph.outputs).size === graph.outputs.length);
}
function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function validateRecords(graph: CircuitGraph, records: Uint8Array) {
  requireCondition(
    records instanceof Uint8Array && records.length === graph.gates.length * 80,
  );
  const v = view(records);
  graph.gates.forEach((gate, i) => {
    const at = i * 80;
    requireCondition(
      records[at] === gate.op &&
        records[at + 1] === 0 &&
        records[at + 2] === 0 &&
        records[at + 3] === 0 &&
        v.getUint32(at + 4, true) === gate.lhs &&
        v.getUint32(at + 8, true) === gate.rhs &&
        v.getUint32(at + 12, true) === 0,
    );
    if (gate.op !== 0)
      requireCondition(
        records.subarray(at + 16, at + 80).every((b) => b === 0),
      );
  });
}
export function encodeCircuitArtifact(
  graph: CircuitGraph,
  namespace: Uint8Array,
  inputLabels: Uint8Array,
  records: Uint8Array,
): Uint8Array {
  validateGraph(graph);
  requireCondition(
    namespace instanceof Uint8Array &&
      namespace.length === 32 &&
      inputLabels instanceof Uint8Array &&
      inputLabels.length === graph.inputCount * 32,
  );
  validateRecords(graph, records);
  const bytes = new Uint8Array(
      64 + graph.outputs.length * 4 + inputLabels.length + records.length,
    ),
    v = view(bytes);
  bytes.set(magic);
  bytes.set(namespace, 8);
  v.setUint32(40, graph.inputCount, true);
  v.setUint32(44, graph.gates.length, true);
  v.setUint32(48, graph.outputs.length, true);
  v.setUint32(52, graph.inputCount + graph.gates.length, true);
  graph.outputs.forEach((wire, i) => v.setUint32(64 + i * 4, wire, true));
  bytes.set(inputLabels, 64 + graph.outputs.length * 4);
  bytes.set(records, 64 + graph.outputs.length * 4 + inputLabels.length);
  return bytes;
}
export function decodeCircuitArtifact(bytes: Uint8Array): {
  graph: CircuitGraph;
  namespace: Uint8Array;
  inputLabels: Uint8Array;
  records: Uint8Array;
} {
  requireCondition(
    bytes instanceof Uint8Array &&
      bytes.length >= 64 &&
      bytes.length <= CIRCUIT_LIMITS.bytes,
  );
  // Buffer.slice aliases its backing bytes; own a real Uint8Array before slicing.
  bytes = Uint8Array.from(bytes);
  requireCondition(
    magic.every((b, i) => bytes[i] === b) &&
      bytes.subarray(56, 64).every((b) => b === 0),
  );
  const v = view(bytes),
    inputCount = v.getUint32(40, true),
    gateCount = v.getUint32(44, true),
    outputCount = v.getUint32(48, true);
  integer(inputCount, 1, CIRCUIT_LIMITS.inputs);
  integer(gateCount, 1, CIRCUIT_LIMITS.gates);
  integer(outputCount, 1, CIRCUIT_LIMITS.outputs);
  requireCondition(
    v.getUint32(52, true) === inputCount + gateCount &&
      bytes.length === 64 + outputCount * 4 + inputCount * 32 + gateCount * 80,
  );
  const records = bytes.slice(64 + outputCount * 4 + inputCount * 32),
    rv = view(records);
  const gates = Array.from({ length: gateCount }, (_, i) => ({
    op: records[i * 80] as 0 | 1 | 2,
    lhs: rv.getUint32(i * 80 + 4, true),
    rhs: rv.getUint32(i * 80 + 8, true),
  }));
  const graph = {
    inputCount,
    gates,
    outputs: Array.from({ length: outputCount }, (_, i) =>
      v.getUint32(64 + i * 4, true),
    ),
  };
  validateGraph(graph);
  validateRecords(graph, records);
  return {
    graph,
    namespace: bytes.slice(8, 40),
    inputLabels: bytes.slice(
      64 + outputCount * 4,
      64 + outputCount * 4 + inputCount * 32,
    ),
    records,
  };
}
/** Stable topology bytes, with no garbling namespace, tables or secret input material. */
export function encodeCircuitGraph(graph: CircuitGraph): Uint8Array {
  validateGraph(graph);
  const bytes = new Uint8Array(
      16 + graph.outputs.length * 4 + graph.gates.length * 12,
    ),
    v = view(bytes);
  v.setUint32(0, 1, true);
  v.setUint32(4, graph.inputCount, true);
  v.setUint32(8, graph.gates.length, true);
  v.setUint32(12, graph.outputs.length, true);
  graph.outputs.forEach((wire, i) => v.setUint32(16 + i * 4, wire, true));
  graph.gates.forEach((gate, i) => {
    const at = 16 + graph.outputs.length * 4 + i * 12;
    v.setUint32(at, gate.op, true);
    v.setUint32(at + 4, gate.lhs, true);
    v.setUint32(at + 8, gate.rhs, true);
  });
  return bytes;
}
export async function circuitGraphCommitment(
  graph: CircuitGraph,
): Promise<Uint8Array> {
  const domain = new TextEncoder().encode("slm-private:circuit-graph:v1\n"),
    graphBytes = encodeCircuitGraph(graph);
  const bytes = new Uint8Array(domain.length + graphBytes.length);
  bytes.set(domain);
  bytes.set(graphBytes, domain.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
