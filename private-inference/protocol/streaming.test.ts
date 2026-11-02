import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeStreamingDescriptor,
  encodeStreamingDescriptor,
  encodeStreamingRecord,
  EMPTY_GENERATION,
  streamingWindows,
  verifyStreamingWindow,
} from "./streaming";

test("stream window Merkle root matches independent Python hashes and rejects substitutions", async () => {
  // Synthetic public codec bytes only, not garbling material or valid gate records.
  const records = new Uint8Array(65 * 96);
  records.fill(1, 32 * 96, 64 * 96);
  records.fill(2, 64 * 96);
  const { root, windows } = await streamingWindows(records);
  assert.equal(
    Buffer.from(root).toString("hex"),
    "c2ce10ca6e717db574907f1f7698ae039ec555f716447d80bfeb3526e9a56a8b",
  );
  const d = {
    namespace: new Uint8Array(32),
    inputCount: 2,
    gateCount: 65,
    slotCount: 2,
    outputs: [{ logical: 66, slot: 1 }],
    recordRoot: root,
    inputLabels: new Uint8Array(64),
  };
  const encoded = encodeStreamingDescriptor(d);
  assert.deepEqual(decodeStreamingDescriptor(encoded), d);
  for (const w of windows) await verifyStreamingWindow(d, w);
  const w = windows[0];
  await assert.rejects(verifyStreamingWindow(d, { ...w, index: 1 }));
  await assert.rejects(
    verifyStreamingWindow(d, { ...w, proof: w.proof.slice(1) }),
  );
  const altered = w.records.slice();
  altered[64] ^= 1;
  await assert.rejects(verifyStreamingWindow(d, { ...w, records: altered }));
  for (const at of [0, 7, 56, 60, 96]) {
    const bad = encoded.slice();
    bad[at] ^= 128;
    assert.throws(() => decodeStreamingDescriptor(bad));
  }
  assert.throws(() =>
    decodeStreamingDescriptor(encoded.subarray(0, encoded.length - 1)),
  );
  assert.throws(() =>
    encodeStreamingDescriptor({
      ...d,
      outputs: [
        { logical: 65, slot: 1 },
        { logical: 66, slot: 1 },
      ],
    }),
  );
});

test("stream gate records enforce logical bounds and canonical generation/slot fields", () => {
  const r = {
    op: 1 as const,
    lhs: 0,
    rhs: 1,
    lhsSlot: 0,
    rhsSlot: 1,
    destination: 2,
    priorDestination: EMPTY_GENERATION,
    tg: new Uint8Array(32),
    te: new Uint8Array(32),
  };
  const b = encodeStreamingRecord(r, 0, 2, 3),
    v = new DataView(b.buffer);
  assert.equal(b.length, 96);
  assert.equal(v.getUint32(20, true), 2);
  assert.equal(v.getUint32(24, true), EMPTY_GENERATION);
  assert.throws(() => encodeStreamingRecord({ ...r, lhs: 2 }, 0, 2, 3));
  assert.throws(() =>
    encodeStreamingRecord({ ...r, priorDestination: 2 }, 0, 2, 3),
  );
  assert.throws(() => encodeStreamingRecord({ ...r, destination: 3 }, 0, 2, 3));
  assert.throws(() => encodeStreamingRecord({ ...r, op: 2 }, 0, 2, 3));
  assert.throws(() =>
    encodeStreamingRecord({ ...r, te: new Uint8Array(32).fill(1) }, 0, 2, 3),
  );
});

test("streaming snapshots Buffer inputs, roots and proofs across asynchronous hashing", async () => {
  const original = Buffer.alloc(33 * 96, 7);
  const pending = streamingWindows(original);
  original.fill(9);
  const result = await pending;
  assert.equal(result.windows[0].records[0], 7);
  const root = Buffer.from(result.root);
  const d = {
    namespace: Buffer.alloc(32),
    inputCount: 1,
    gateCount: 33,
    slotCount: 1,
    outputs: [{ logical: 33, slot: 0 }],
    recordRoot: root,
    inputLabels: Buffer.alloc(32),
  };
  const records = Buffer.from(result.windows[0].records),
    proof = result.windows[0].proof.map((p) => Buffer.from(p));
  const verification = verifyStreamingWindow(d, { index: 0, records, proof });
  root.fill(1);
  records.fill(2);
  proof.forEach((p) => p.fill(3));
  await verification;
  const encoded = Buffer.from(encodeStreamingDescriptor(d)),
    decoded = decodeStreamingDescriptor(encoded);
  encoded.fill(0);
  assert.equal(decoded.recordRoot[0], 1);
  await assert.rejects(
    verifyStreamingWindow(
      { ...d, unexpected: 1 } as typeof d,
      result.windows[0],
    ),
  );
});
