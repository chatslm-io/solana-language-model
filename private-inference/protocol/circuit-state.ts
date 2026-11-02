/** Byte-level verification only. Caller must independently verify finalized account
 * ownership, session/scratch PDAs, program code and the selected artifact commitment.
 * This does not turn an untrusted RPC response into a proof of execution.
 */
import { decodeCircuitArtifact } from "./circuit";

const enc = new TextEncoder();
function requireValid(ok: boolean): asserts ok {
  if (!ok) throw Error("invalid_circuit_result");
}
function equal(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
export async function verifyCompletedCircuitBytes(args: {
  scratch: Uint8Array;
  session: Uint8Array;
  sessionAddress: Uint8Array;
  scratchBump: number;
  artifact: Uint8Array;
}): Promise<Uint8Array> {
  // Snapshot before the first await; browser callers may reuse RPC buffers.
  const d = Uint8Array.from(args.scratch),
    s = Uint8Array.from(args.session);
  const address = Uint8Array.from(args.sessionAddress);
  const artifact = decodeCircuitArtifact(Uint8Array.from(args.artifact));
  const { graph } = artifact;
  const wires = graph.inputCount + graph.gates.length;
  requireValid(
    s.length === 256 && d.length === 256 + wires * 32 && address.length === 32,
  );
  const sv = new DataView(s.buffer),
    dv = new DataView(d.buffer);
  requireValid(
    equal(s.subarray(0, 8), enc.encode("SLMPIS01")) &&
      s[8] === 1 &&
      s[9] === 1 &&
      s[10] === 3,
  );
  requireValid(
    equal(d.subarray(0, 8), enc.encode("SLMPIW01")) &&
      d[8] === 1 &&
      d[9] === 3 &&
      d[10] === 3,
  );
  requireValid(
    Number.isInteger(args.scratchBump) &&
      args.scratchBump >= 0 &&
      args.scratchBump <= 255 &&
      d[11] === args.scratchBump,
  );
  requireValid(
    d.subarray(12, 16).every((x) => x === 0) &&
      d.subarray(196, 256).every((x) => x === 0),
  );
  requireValid(
    equal(d.subarray(16, 48), s.subarray(16, 48)) &&
      equal(d.subarray(48, 80), address),
  );
  requireValid(
    equal(d.subarray(80, 112), s.subarray(112, 144)) &&
      equal(d.subarray(112, 144), s.subarray(144, 176)),
  );
  requireValid(equal(artifact.namespace, s.subarray(80, 112)));
  requireValid(
    dv.getUint32(144, true) === wires &&
      dv.getUint32(148, true) === graph.gates.length &&
      dv.getUint32(152, true) === graph.inputCount,
  );
  requireValid(
    dv.getUint32(156, true) === graph.gates.length &&
      dv.getUint32(192, true) === graph.outputs.length,
  );
  const steps = Math.ceil(graph.gates.length / 32);
  requireValid(
    sv.getUint32(208, true) === steps &&
      sv.getUint32(224, true) === steps &&
      sv.getUint32(228, true) === 1,
  );
  const domain = enc.encode("slm-private:wires:v1\n");
  const bytes = new Uint8Array(domain.length + 72 + wires * 32);
  bytes.set(domain);
  bytes.set(d.subarray(80, 144), domain.length);
  const v = new DataView(bytes.buffer);
  v.setUint32(domain.length + 64, graph.gates.length, true);
  v.setUint32(domain.length + 68, wires, true);
  bytes.set(d.subarray(256), domain.length + 72);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  requireValid(
    equal(hash, d.subarray(160, 192)) && equal(hash, s.subarray(176, 208)),
  );
  const result = new Uint8Array(graph.outputs.length * 32);
  graph.outputs.forEach((wire, i) =>
    result.set(d.subarray(256 + wire * 32, 288 + wire * 32), i * 32),
  );
  return result;
}
