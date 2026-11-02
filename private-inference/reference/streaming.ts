/** Independent CPU test oracle for v2 slot generations and encrypted evaluation. */
import { createHash } from "node:crypto";
import {
  decodeStreamingDescriptor,
  encodeStreamingRecord,
  verifyStreamingWindow,
  EMPTY_GENERATION,
  type StreamingRecord,
  type StreamingWindow,
} from "../protocol/streaming";
export async function evaluateStreamingReference(
  descriptorBytes: Uint8Array,
  sourceWindows: readonly StreamingWindow[],
): Promise<Uint8Array> {
  const descriptor = decodeStreamingDescriptor(descriptorBytes),
    labels: Uint8Array[] = Array.from(
      { length: descriptor.slotCount },
      () => new Uint8Array(32),
    ),
    generation = Array<number>(descriptor.slotCount).fill(EMPTY_GENERATION);
  for (let i = 0; i < descriptor.inputCount; i++) {
    labels[i] = descriptor.inputLabels.slice(i * 32, (i + 1) * 32);
    generation[i] = i;
  }
  let cursor = 0;
  for (const original of sourceWindows) {
    const window = {
      index: original.index,
      records: Uint8Array.from(original.records),
      proof: original.proof.map((hash) => Uint8Array.from(hash)),
    };
    if (window.index !== cursor / 32) throw Error("reference_stream_sequence");
    await verifyStreamingWindow(descriptor, window);
    const view = new DataView(
      window.records.buffer,
      window.records.byteOffset,
      window.records.byteLength,
    );
    for (let at = 0; at < window.records.length; at += 96) {
      const record: StreamingRecord = {
        op: window.records[at] as 0 | 1 | 2,
        lhs: view.getUint32(at + 4, true),
        rhs: view.getUint32(at + 8, true),
        lhsSlot: view.getUint32(at + 12, true),
        rhsSlot: view.getUint32(at + 16, true),
        destination: view.getUint32(at + 20, true),
        priorDestination: view.getUint32(at + 24, true),
        tg: window.records.slice(at + 32, at + 64),
        te: window.records.slice(at + 64, at + 96),
      };
      const canonical = encodeStreamingRecord(
        record,
        cursor,
        descriptor.inputCount,
        descriptor.slotCount,
      );
      if (!canonical.every((byte, i) => byte === window.records[at + i]))
        throw Error("reference_stream_encoding");
      if (
        generation[record.lhsSlot] !== record.lhs ||
        (record.op !== 2 && generation[record.rhsSlot] !== record.rhs) ||
        generation[record.destination] !== record.priorDestination
      )
        throw Error("reference_stream_generation");
      const a = labels[record.lhsSlot].slice(),
        b = labels[record.rhsSlot].slice();
      let output: Uint8Array;
      if (record.op === 2) output = a;
      else if (record.op === 1)
        output = Uint8Array.from(a, (value, i) => value ^ b[i]);
      else {
        const index = Buffer.alloc(8);
        index.writeBigUInt64LE(BigInt(cursor));
        const hash = (label: Uint8Array, half: number) =>
          createHash("sha256")
            .update("slm:half-gates:sha256:v1\0")
            .update(descriptor.namespace)
            .update(index)
            .update(Uint8Array.of(half))
            .update(label)
            .digest();
        const left = hash(a, 0),
          right = hash(b, 1);
        for (let i = 0; i < 32; i++) {
          if (a[0] & 1) left[i] ^= record.tg[i];
          if (b[0] & 1) right[i] ^= record.te[i] ^ a[i];
          left[i] ^= right[i];
        }
        output = left;
      }
      labels[record.destination] = output;
      generation[record.destination] = descriptor.inputCount + cursor;
      cursor++;
    }
  }
  if (cursor !== descriptor.gateCount)
    throw Error("reference_stream_incomplete");
  const output = new Uint8Array(descriptor.outputs.length * 32);
  descriptor.outputs.forEach((wire, i) => {
    if (generation[wire.slot] !== wire.logical)
      throw Error("reference_stream_output_generation");
    output.set(labels[wire.slot], i * 32);
  });
  return output;
}
