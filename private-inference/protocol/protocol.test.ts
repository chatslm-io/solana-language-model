import test from "node:test";
import assert from "node:assert/strict";
import vectors from "./vectors.json";
import {
  commitment,
  encodeSession,
  decodeSession,
  sessionCommitment,
  pageCommitment,
  pagesCommitment,
  encodeStep,
  decodeStep,
} from "./index";
const session = {
  ...vectors.session,
  expirySlot: BigInt(vectors.session.expirySlot),
};
test("canonical session/page/step match independently fixed Python vectors", () => {
  assert.equal(encodeSession(session).toString("hex"), vectors.sessionHex);
  assert.equal(sessionCommitment(session), vectors.sessionHash);
  assert.deepEqual(
    decodeSession(Buffer.from(vectors.sessionHex, "hex")),
    session,
  );
  const p = vectors.page;
  assert.equal(
    pageCommitment(p.index, p.purpose, Buffer.from(p.payloadHex, "hex")),
    p.hash,
  );
  assert.equal(pagesCommitment([p.hash]), vectors.pagesRoot);
  const bytes = Buffer.from(vectors.stepHex, "hex");
  assert.deepEqual(encodeStep(decodeStep(bytes)), bytes);
  assert.equal(commitment("step", bytes), vectors.stepHash);
  assert.notEqual(commitment("result", bytes), vectors.stepHash);
  assert.throws(() => commitment("unknown" as "session", bytes));
});
test("noncanonical, truncated, oversized, zero-bound and unknown-version contracts fail", () => {
  const b = encodeSession(session);
  const highBitMagic = Buffer.from(b);
  highBitMagic[0] |= 128;
  assert.throws(() => decodeSession(highBitMagic));
  const highBitStep = Buffer.from(vectors.stepHex, "hex");
  highBitStep[0] |= 128;
  assert.throws(() => decodeStep(highBitStep));
  for (const bad of [
    b.subarray(1),
    Buffer.concat([b, Buffer.of(0)]),
    Buffer.from(b).fill(0, 0, 8),
    Buffer.from(b).fill(0, 392, 396),
  ])
    assert.throws(() => decodeSession(bad));
  assert.throws(() => encodeSession({ ...session, owner: "AF".repeat(32) }));
  assert.throws(() => encodeSession({ ...session, inputBound: -1 }));
  assert.throws(() => encodeSession({ ...session, expirySlot: 1n << 64n }));
  assert.throws(() =>
    encodeSession({ ...session, extra: true } as typeof session),
  );
  assert.throws(() => pageCommitment(64, 0, Buffer.of(1)));
  assert.throws(() => pageCommitment(0, 4, Buffer.of(1)));
  assert.throws(() => pageCommitment(0, 0, Buffer.alloc(8193)));
  assert.throws(() => pagesCommitment([]));
  const step = decodeStep(Buffer.from(vectors.stepHex, "hex"));
  assert.throws(() => encodeStep({ ...step, workUnits: 0 }));
  assert.throws(() => decodeStep(Buffer.from(vectors.stepHex + "00", "hex")));
});
