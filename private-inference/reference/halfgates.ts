/** Independent Node evaluator for browser garbler conformance only; never production inference. */
import { createHash } from "node:crypto";
export function referenceAnd(request: Uint8Array): Uint8Array {
  if (request.length !== 169 || request[0] !== 1)
    throw Error("reference_garbling_wire");
  const gate = new DataView(
    request.buffer,
    request.byteOffset,
    request.byteLength,
  ).getBigUint64(33, true);
  if (gate >= 2n ** 32n) throw Error("reference_garbling_gate");
  const a = request.subarray(41, 73),
    b = request.subarray(73, 105);
  const h = (label: Uint8Array, half: number) =>
    createHash("sha256")
      .update("slm:half-gates:sha256:v1\0")
      .update(request.subarray(1, 41))
      .update(Uint8Array.of(half))
      .update(label)
      .digest();
  const left = h(a, 0),
    right = h(b, 1);
  for (let i = 0; i < 32; i++) {
    if (a[0] % 2) left[i] ^= request[105 + i];
    if (b[0] % 2) right[i] ^= request[137 + i] ^ a[i];
    left[i] ^= right[i];
  }
  return left;
}
