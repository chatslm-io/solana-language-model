/** Independent CPU conformance evaluator only. Production evaluation belongs in SBF. */
import { createHash } from "node:crypto";
import { decodeCircuitArtifact } from "../protocol/circuit";
export function evaluateGarbledCircuit(artifact: Uint8Array): Uint8Array {
  const { graph, namespace, inputLabels, records } =
    decodeCircuitArtifact(artifact);
  const wires = Array.from({ length: graph.inputCount }, (_, i) =>
    inputLabels.slice(i * 32, (i + 1) * 32),
  );
  for (let index = 0; index < graph.gates.length; index++) {
    const gate = graph.gates[index],
      a = wires[gate.lhs],
      b = wires[gate.rhs];
    if (gate.op === 2) {
      wires.push(a.slice());
      continue;
    }
    if (gate.op === 1) {
      wires.push(Uint8Array.from(a, (v, i) => v ^ b[i]));
      continue;
    }
    const tweak = Buffer.alloc(8);
    tweak.writeBigUInt64LE(BigInt(index));
    const hash = (label: Uint8Array, half: number) =>
      createHash("sha256")
        .update("slm:half-gates:sha256:v1\0")
        .update(namespace)
        .update(tweak)
        .update(Uint8Array.of(half))
        .update(label)
        .digest();
    const left = hash(a, 0),
      right = hash(b, 1),
      at = index * 80;
    for (let i = 0; i < 32; i++) {
      if (a[0] & 1) left[i] ^= records[at + 16 + i];
      if (b[0] & 1) right[i] ^= records[at + 48 + i] ^ a[i];
      left[i] ^= right[i];
    }
    wires.push(left);
  }
  const output = new Uint8Array(graph.outputs.length * 32);
  graph.outputs.forEach((wire, index) => output.set(wires[wire], index * 32));
  return output;
}
