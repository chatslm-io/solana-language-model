import test from "node:test";
import assert from "node:assert/strict";
import { encodeCircuitArtifact } from "./circuit";
import { verifyCompletedCircuitBytes } from "./circuit-state";

// Public synthetic bytes, not a valid garbling. Hash independently calculated
// with Python hashlib and struct.pack('<II', 1, 3).
function fixture() {
  const session = new Uint8Array(256),
    scratch = new Uint8Array(352);
  const sessionAddress = new Uint8Array(32).fill(4);
  session.set(new TextEncoder().encode("SLMPIS01"));
  session.set([1, 1, 3], 8);
  session.fill(5, 16, 48);
  session.fill(6, 80, 112);
  session.fill(7, 112, 144);
  session.fill(9, 144, 176);
  const hash = Buffer.from(
    "0819f44818ae357f8b7354caac487e38fdfeb38457f5af075abfad8002cf69b7",
    "hex",
  );
  session.set(hash, 176);
  const sv = new DataView(session.buffer);
  for (const at of [208, 224, 228]) sv.setUint32(at, 1, true);
  scratch.set(new TextEncoder().encode("SLMPIW01"));
  scratch.set([1, 3, 3, 254], 8);
  scratch.set(session.subarray(16, 48), 16);
  scratch.set(sessionAddress, 48);
  scratch.set(session.subarray(112, 176), 80);
  const dv = new DataView(scratch.buffer);
  for (const [at, value] of [
    [144, 3],
    [148, 1],
    [152, 2],
    [156, 1],
    [192, 1],
  ])
    dv.setUint32(at, value, true);
  scratch.set(hash, 160);
  scratch.fill(11, 256);
  const records = new Uint8Array(80);
  records[0] = 1;
  records[8] = 1;
  const artifact = encodeCircuitArtifact(
    { inputCount: 2, gates: [{ op: 1, lhs: 0, rhs: 1 }], outputs: [2] },
    new Uint8Array(32).fill(6),
    new Uint8Array(64).fill(11),
    records,
  );
  return { session, scratch, sessionAddress, scratchBump: 254, artifact };
}
test("completed circuit state matches independent hash and rejects altered evidence", async () => {
  assert.deepEqual(
    await verifyCompletedCircuitBytes(fixture()),
    new Uint8Array(32).fill(11),
  );
  for (const at of [
    0, 8, 9, 10, 11, 12, 16, 48, 80, 112, 144, 148, 152, 156, 160, 192, 196,
    256,
  ]) {
    const f = fixture();
    f.scratch[at] ^= 1;
    await assert.rejects(
      verifyCompletedCircuitBytes(f),
      /invalid_circuit_result/,
    );
  }
  for (const at of [0, 10, 80, 176, 208, 224, 228]) {
    const f = fixture();
    f.session[at] ^= 1;
    await assert.rejects(
      verifyCompletedCircuitBytes(f),
      /invalid_circuit_result/,
    );
  }
});
