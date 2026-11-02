/** Experimental v2 eager-input streaming profile. No spill/lazy-load opcodes. */
export const STREAMING_LIMITS = Object.freeze({
  inputs: 64,
  slots: 256,
  outputs: 32,
  gates: 1_048_576,
  work: 32,
  recordBytes: 96,
  slotBytes: 40,
});
export const EMPTY_GENERATION = 0xffffffff;
export type StreamingDescriptor = {
  namespace: Uint8Array;
  inputCount: number;
  gateCount: number;
  slotCount: number;
  outputs: readonly { logical: number; slot: number }[];
  recordRoot: Uint8Array;
  inputLabels: Uint8Array;
};
export type StreamingRecord = {
  op: 0 | 1 | 2;
  lhs: number;
  rhs: number;
  lhsSlot: number;
  rhsSlot: number;
  destination: number;
  priorDestination: number;
  tg: Uint8Array;
  te: Uint8Array;
};
const enc = new TextEncoder(),
  magic = enc.encode("SLMGD002");
function check(value: boolean): asserts value {
  if (!value) throw Error("invalid_streaming_encoding");
}
function integer(n: number, min: number, max: number) {
  check(Number.isSafeInteger(n) && n >= min && n <= max);
}
function bytes(b: Uint8Array, length: number) {
  check(b instanceof Uint8Array && b.length === length);
}
function view(b: Uint8Array) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}
function fields(value: object, keys: string[]) {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  const actual = Object.keys(value);
  check(actual.length === keys.length && actual.every((k) => keys.includes(k)));
}
function validate(d: StreamingDescriptor) {
  fields(d, [
    "namespace",
    "inputCount",
    "gateCount",
    "slotCount",
    "outputs",
    "recordRoot",
    "inputLabels",
  ]);
  integer(d.inputCount, 1, STREAMING_LIMITS.inputs);
  integer(d.gateCount, 1, STREAMING_LIMITS.gates);
  integer(d.slotCount, d.inputCount, STREAMING_LIMITS.slots);
  bytes(d.namespace, 32);
  bytes(d.recordRoot, 32);
  bytes(d.inputLabels, d.inputCount * 32);
  check(Array.isArray(d.outputs));
  integer(d.outputs.length, 1, STREAMING_LIMITS.outputs);
  for (const output of d.outputs) {
    fields(output, ["logical", "slot"]);
    integer(output.logical, 0, d.inputCount + d.gateCount - 1);
    integer(output.slot, 0, d.slotCount - 1);
  }
  check(
    new Set(d.outputs.map((o) => o.logical)).size === d.outputs.length &&
      new Set(d.outputs.map((o) => o.slot)).size === d.outputs.length,
  );
}
export function encodeStreamingDescriptor(d: StreamingDescriptor): Uint8Array {
  validate(d);
  const b = new Uint8Array(128 + d.outputs.length * 8 + d.inputLabels.length),
    v = view(b);
  b.set(magic);
  b.set(d.namespace, 8);
  [
    d.inputCount,
    d.gateCount,
    d.slotCount,
    d.outputs.length,
    32,
    Math.ceil(d.gateCount / 32),
  ].forEach((n, i) => v.setUint32(40 + 4 * i, n, true));
  b.set(d.recordRoot, 64);
  d.outputs.forEach((o, i) => {
    v.setUint32(128 + i * 8, o.logical, true);
    v.setUint32(132 + i * 8, o.slot, true);
  });
  b.set(d.inputLabels, 128 + d.outputs.length * 8);
  return b;
}
export function decodeStreamingDescriptor(b: Uint8Array): StreamingDescriptor {
  check(b instanceof Uint8Array && b.length >= 168 && b.length <= 2432);
  const v = view(b),
    inputs = v.getUint32(40, true),
    gates = v.getUint32(44, true),
    count = v.getUint32(52, true);
  check(
    magic.every((x, i) => b[i] === x) &&
      b.subarray(96, 128).every((x) => x === 0),
  );
  integer(count, 1, STREAMING_LIMITS.outputs);
  integer(inputs, 1, STREAMING_LIMITS.inputs);
  check(
    b.length === 128 + count * 8 + inputs * 32 &&
      v.getUint32(56, true) === 32 &&
      v.getUint32(60, true) === Math.ceil(gates / 32),
  );
  const d = {
    namespace: Uint8Array.from(b.subarray(8, 40)),
    inputCount: inputs,
    gateCount: gates,
    slotCount: v.getUint32(48, true),
    outputs: Array.from({ length: count }, (_, i) => ({
      logical: v.getUint32(128 + i * 8, true),
      slot: v.getUint32(132 + i * 8, true),
    })),
    recordRoot: Uint8Array.from(b.subarray(64, 96)),
    inputLabels: Uint8Array.from(b.subarray(128 + count * 8)),
  };
  validate(d);
  return d;
}
export function encodeStreamingRecord(
  r: StreamingRecord,
  absoluteGate: number,
  inputCount: number,
  slotCount: number,
): Uint8Array {
  fields(r, [
    "op",
    "lhs",
    "rhs",
    "lhsSlot",
    "rhsSlot",
    "destination",
    "priorDestination",
    "tg",
    "te",
  ]);
  integer(inputCount, 1, 64);
  integer(slotCount, inputCount, 256);
  integer(absoluteGate, 0, STREAMING_LIMITS.gates - 1);
  integer(r.op, 0, 2);
  integer(r.lhs, 0, inputCount + absoluteGate - 1);
  integer(r.rhs, 0, inputCount + absoluteGate - 1);
  for (const s of [r.lhsSlot, r.rhsSlot, r.destination])
    integer(s, 0, slotCount - 1);
  check(
    r.priorDestination === EMPTY_GENERATION ||
      (Number.isSafeInteger(r.priorDestination) &&
        r.priorDestination >= 0 &&
        r.priorDestination < inputCount + absoluteGate),
  );
  bytes(r.tg, 32);
  bytes(r.te, 32);
  if (r.op === 2) check(r.rhs === 0 && r.rhsSlot === 0);
  if (r.op !== 0)
    check(r.tg.every((x) => x === 0) && r.te.every((x) => x === 0));
  const b = new Uint8Array(96),
    v = view(b);
  b[0] = r.op;
  [
    r.lhs,
    r.rhs,
    r.lhsSlot,
    r.rhsSlot,
    r.destination,
    r.priorDestination,
  ].forEach((n, i) => v.setUint32(4 + 4 * i, n, true));
  b.set(r.tg, 32);
  b.set(r.te, 64);
  return b;
}
async function digest(parts: readonly Uint8Array[]) {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    b.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}
export async function streamingWindowHash(
  index: number,
  records: Uint8Array,
): Promise<Uint8Array> {
  integer(index, 0, Math.ceil(STREAMING_LIMITS.gates / 32) - 1);
  check(
    records instanceof Uint8Array &&
      records.length % 96 === 0 &&
      records.length <= 32 * 96,
  );
  const fields = new Uint8Array(8),
    v = view(fields);
  v.setUint32(0, index, true);
  v.setUint32(4, records.length / 96, true);
  return digest([enc.encode("slm-private:window:v2\n"), fields, records]);
}
async function parent(left: Uint8Array, right: Uint8Array) {
  return digest([enc.encode("slm-private:window-node:v2\n"), left, right]);
}
export type StreamingWindow = {
  index: number;
  records: Uint8Array;
  proof: Uint8Array[];
};
export async function streamingWindows(
  records: Uint8Array,
): Promise<{ root: Uint8Array; windows: StreamingWindow[] }> {
  check(records instanceof Uint8Array && records.length % 96 === 0);
  integer(records.length / 96, 1, STREAMING_LIMITS.gates);
  const snapshot = Uint8Array.from(records),
    count = Math.ceil(snapshot.length / (32 * 96));
  let width = 1;
  while (width < count) width *= 2;
  const chunks = Array.from({ length: width }, (_, i) =>
    snapshot.slice(i * 32 * 96, (i + 1) * 32 * 96),
  );
  const levels: Uint8Array[][] = [
    await Promise.all(chunks.map((c, i) => streamingWindowHash(i, c))),
  ];
  while (levels.at(-1)!.length > 1) {
    const prev = levels.at(-1)!;
    levels.push(
      await Promise.all(
        Array.from({ length: prev.length / 2 }, (_, i) =>
          parent(prev[i * 2], prev[i * 2 + 1]),
        ),
      ),
    );
  }
  return {
    root: levels.at(-1)![0].slice(),
    windows: chunks.slice(0, count).map((records, index) => ({
      index,
      records,
      proof: levels
        .slice(0, -1)
        .map((level, depth) => level[(index >>> depth) ^ 1].slice()),
    })),
  };
}
export async function verifyStreamingWindow(
  d: StreamingDescriptor,
  w: StreamingWindow,
): Promise<void> {
  validate(d);
  fields(w, ["index", "records", "proof"]);
  const count = Math.ceil(d.gateCount / 32),
    windowIndex = w.index;
  integer(windowIndex, 0, count - 1);
  bytes(w.records, Math.min(32, d.gateCount - windowIndex * 32) * 96);
  check(
    Array.isArray(w.proof) && w.proof.length === Math.ceil(Math.log2(count)),
  );
  const root = Uint8Array.from(d.recordRoot),
    records = Uint8Array.from(w.records),
    proof = Array.from(w.proof, (p) => {
      bytes(p, 32);
      return Uint8Array.from(p);
    });
  let h = await streamingWindowHash(windowIndex, records),
    index = windowIndex;
  for (const sibling of proof) {
    h = index & 1 ? await parent(sibling, h) : await parent(h, sibling);
    index >>>= 1;
  }
  check(h.every((x, i) => x === root[i]));
}
