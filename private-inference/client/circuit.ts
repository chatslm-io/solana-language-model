/** Experimental whole-circuit trusted-client garbler. This compiles labels/tables,
 * never evaluates a model operation on plaintext. Security limitations and the
 * SHA256 random-oracle/CCR assumption remain in crypto-core/SECURITY.md.
 */
import {
  encodeCircuitArtifact,
  validateGraph,
  type CircuitGraph,
} from "../protocol/circuit";
const domain = new TextEncoder().encode("slm:half-gates:sha256:v1\0");
const zero = () => new Uint8Array(32);
const xor = (...labels: Uint8Array[]) =>
  Uint8Array.from({ length: 32 }, (_, i) =>
    labels.reduce((value, label) => value ^ label[i], 0),
  );
const equal = (a: Uint8Array, b: Uint8Array) => {
  let difference = 0;
  if (a.length !== 32 || b.length !== 32) return false;
  for (let i = 0; i < 32; i++) difference |= a[i] ^ b[i];
  return difference === 0;
};
async function hash(
  label: Uint8Array,
  namespace: Uint8Array,
  index: number,
  half: number,
) {
  const bytes = new Uint8Array(domain.length + 73);
  bytes.set(domain);
  bytes.set(namespace, domain.length);
  new DataView(bytes.buffer).setBigUint64(
    domain.length + 32,
    BigInt(index),
    true,
  );
  bytes[domain.length + 40] = half;
  bytes.set(label, domain.length + 41);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  bytes.fill(0);
  return digest;
}
export type PreparedCircuit = {
  /** Exactly once. The artifact contains only public graph/tables and active input labels. */
  encode(input: readonly boolean[]): Uint8Array;
  /** Local only, after independent finalized-session evidence verification. */
  decode(outputLabels: Uint8Array): boolean[];
  destroy(): void;
  readonly resources: {
    readonly inputs: number;
    readonly gates: number;
    readonly wires: number;
    readonly outputs: number;
    readonly garblerHashes: number;
    readonly tableBytes: number;
    readonly recordBytes: number;
  };
};
export async function prepareCircuit(
  source: CircuitGraph,
  namespace: Uint8Array,
): Promise<PreparedCircuit> {
  validateGraph(source);
  if (!(namespace instanceof Uint8Array) || namespace.length !== 32)
    throw Error("garbling_namespace");
  const graph: CircuitGraph = {
      inputCount: source.inputCount,
      gates: source.gates.map((gate) => ({ ...gate })),
      outputs: [...source.outputs],
    },
    ns = Uint8Array.from(namespace);
  const delta = crypto.getRandomValues(zero());
  delta[0] |= 1;
  const labels: Uint8Array[] = Array.from({ length: graph.inputCount }, () =>
    crypto.getRandomValues(zero()),
  );
  const records = new Uint8Array(graph.gates.length * 80),
    view = new DataView(records.buffer);
  let andCount = 0;
  try {
    for (let index = 0; index < graph.gates.length; index++) {
      const gate = graph.gates[index],
        at = index * 80,
        a0 = labels[gate.lhs];
      records[at] = gate.op;
      view.setUint32(at + 4, gate.lhs, true);
      view.setUint32(at + 8, gate.rhs, true);
      if (gate.op === 2) {
        labels.push(xor(a0, delta));
        continue;
      }
      const b0 = labels[gate.rhs];
      if (gate.op === 1) {
        labels.push(xor(a0, b0));
        continue;
      }
      const a1 = xor(a0, delta),
        b1 = xor(b0, delta);
      const [ha0, ha1, hb0, hb1] = await Promise.all([
        hash(a0, ns, index, 0),
        hash(a1, ns, index, 0),
        hash(b0, ns, index, 1),
        hash(b1, ns, index, 1),
      ]);
      const tg = xor(ha0, ha1, b0[0] & 1 ? delta : zero()),
        te = xor(hb0, hb1, a0);
      labels.push(
        xor(
          ha0,
          a0[0] & 1 ? tg : zero(),
          hb0,
          b0[0] & 1 ? xor(hb0, hb1) : zero(),
        ),
      );
      records.set(tg, at + 16);
      records.set(te, at + 48);
      andCount++;
      for (const temporary of [a1, b1, ha0, ha1, hb0, hb1, tg, te])
        temporary.fill(0);
    }
  } catch (error) {
    for (const label of labels) label.fill(0);
    delta.fill(0);
    records.fill(0);
    throw error;
  }
  const outputZeros = graph.outputs.map((wire) => labels[wire].slice()),
    outputOnes = outputZeros.map((label) => xor(label, delta));
  let encoded = false,
    destroyed = false;
  // Best-effort zeroing only: JavaScript/WebCrypto may retain copies; no secure-erasure claim.
  const erase = () => {
    for (const label of labels) label.fill(0);
    delta.fill(0);
  };
  return Object.freeze({
    encode(input: readonly boolean[]) {
      if (destroyed || encoded) throw Error("garbling_single_use");
      if (
        !Array.isArray(input) ||
        input.length !== graph.inputCount ||
        Array.from(input).some((bit) => typeof bit !== "boolean")
      )
        throw Error("garbling_input_shape");
      encoded = true;
      const inputs = new Uint8Array(graph.inputCount * 32);
      try {
        for (let i = 0; i < input.length; i++) {
          const label = input[i] ? xor(labels[i], delta) : labels[i];
          inputs.set(label, i * 32);
          if (input[i]) label.fill(0);
        }
        return encodeCircuitArtifact(graph, ns, inputs, records);
      } finally {
        inputs.fill(0);
        erase();
      }
    },
    decode(outputLabels: Uint8Array) {
      if (destroyed || !encoded) throw Error("garbling_state");
      if (outputLabels.length !== graph.outputs.length * 32)
        throw Error("garbling_output_shape");
      return graph.outputs.map((_, index) => {
        const label = outputLabels.subarray(index * 32, (index + 1) * 32);
        if (equal(label, outputZeros[index])) return false;
        if (equal(label, outputOnes[index])) return true;
        throw Error("garbling_output_authentication");
      });
    },
    destroy() {
      erase();
      for (const label of [...outputZeros, ...outputOnes]) label.fill(0);
      records.fill(0);
      destroyed = true;
    },
    resources: Object.freeze({
      inputs: graph.inputCount,
      gates: graph.gates.length,
      wires: labels.length,
      outputs: graph.outputs.length,
      garblerHashes: andCount * 4,
      tableBytes: andCount * 64,
      recordBytes: records.length,
    }),
  });
}
