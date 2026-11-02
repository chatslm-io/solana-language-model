import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { ristretto255 } from "@noble/curves/ed25519";
import { AccountRole } from "@solana/kit";
import {
  BIAS,
  MODEL_DESCRIPTION,
  MODEL_ID,
  OUTPUT_BYTES,
  REQUEST_BYTES,
  WEIGHTS,
  createPrivateLinearKey,
  decryptOutput,
  parseRequest,
  privateLinearInstruction,
  requestDigest,
  verifyOutput,
  type OutputBinding,
} from "../lib/private-linear";
import { createHash } from "node:crypto";
const Point = ristretto255.Point;
const caller = "11111111111111111111111111111111";
const program = "BPFLoaderUpgradeab1e11111111111111111111111";
const other = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
function binding(request: Uint8Array): OutputBinding {
  return { request, caller, program, returnProgram: program };
}
// Independent clear reference of the homomorphic arithmetic, ONLY a unit-test
// oracle. Production evidence must come from authenticated program execution.
function reference(request: Uint8Array): Uint8Array {
  const inputs = parseRequest(request).inputs;
  let r = Point.ZERO,
    c = Point.BASE.multiply(BigInt(BIAS));
  for (let i = 0; i < inputs.length; i++) {
    let R = Point.fromBytes(inputs[i].r).multiply(BigInt(Math.abs(WEIGHTS[i])));
    let C = Point.fromBytes(inputs[i].c).multiply(BigInt(Math.abs(WEIGHTS[i])));
    if (WEIGHTS[i] < 0) {
      R = R.negate();
      C = C.negate();
    }
    r = r.add(R);
    c = c.add(C);
  }
  return Buffer.concat([
    Buffer.from("SLMHEO01"),
    Buffer.from(MODEL_ID, "hex"),
    Buffer.from(requestDigest(caller, request)),
    r.toBytes(),
    c.toBytes(),
  ]);
}
test("encrypted affine score round-trips signed inputs including extrema", () => {
  const key = createPrivateLinearKey();
  try {
    for (const inputs of [
      [0, 0, 0, 0],
      [1, 2, 3, 4],
      [255, -255, 255, 255],
      [-255, 255, -255, -255],
      [-23, 17, -4, 98],
    ]) {
      const request = key.encrypt(inputs);
      assert.equal(request.length, REQUEST_BYTES);
      const result = reference(request);
      assert.equal(result.length, OUTPUT_BYTES);
      const expected = inputs.reduce((sum, n, i) => sum + n * WEIGHTS[i], BIAS);
      assert.equal(decryptOutput(key, result, binding(request)), expected);
    }
  } finally {
    key.destroy();
  }
});
test("fresh encryption randomizes repeated bounded values", () => {
  const key = createPrivateLinearKey();
  try {
    const id = new Uint8Array(32).fill(17);
    const first = key.encrypt([1, 1, 1, 1], id),
      second = key.encrypt([1, 1, 1, 1], id);
    assert.notDeepEqual(first, second);
    const allR = [
      ...parseRequest(first).inputs,
      ...parseRequest(second).inputs,
    ].map((c) => Buffer.from(c.r).toString("hex"));
    assert.equal(new Set(allR).size, 8);
    assert.deepEqual(parseRequest(first).requestId, id);
    assert.deepEqual(parseRequest(first).publicKey, key.publicKey);
  } finally {
    key.destroy();
  }
});
test("keys cannot serialize or export their secret and destruction disables use", () => {
  const key = createPrivateLinearKey();
  const request = key.encrypt([1, 2, 3, 4]),
    result = reference(request);
  assert.throws(() => JSON.stringify(key), /not_serializable/);
  assert.equal(inspect(key), "[PrivateLinearKey: redacted]");
  const original = key.publicKey;
  const modified = key.publicKey;
  modified.fill(0);
  assert.deepEqual(key.publicKey, original);
  const stranger = createPrivateLinearKey();
  try {
    assert.throws(
      () => decryptOutput(stranger, result, binding(request)),
      /wrong_key/,
    );
  } finally {
    stranger.destroy();
  }
  key.destroy();
  key.destroy();
  assert.throws(() => key.encrypt([1, 2, 3, 4]), /key_unavailable/);
  assert.throws(() => key.publicKey, /key_unavailable/);
  assert.throws(
    () => decryptOutput(key, result, binding(request)),
    /key_unavailable/,
  );
});
test("client rejects malformed, sparse, and out-of-range inputs", () => {
  const key = createPrivateLinearKey();
  try {
    for (const inputs of [
      [],
      [1, 2, 3],
      [1, 2, 3, 4, 5],
      [256, 0, 0, 0],
      [-256, 0, 0, 0],
      [NaN, 0, 0, 0],
      [Infinity, 0, 0, 0],
      [0.5, 0, 0, 0],
      new Array<number>(4),
    ])
      assert.throws(() => key.encrypt(inputs), /input_range/);
    assert.throws(
      () => key.encrypt([1, 2, 3, 4], new Uint8Array(31)),
      /invalid_bytes/,
    );
  } finally {
    key.destroy();
  }
});
test("wire validation rejects noncanonical/identity keys, reused nonces, lengths and magic; C identity is valid", () => {
  const key = createPrivateLinearKey();
  try {
    const request = key.encrypt([1, 2, 3, 4]);
    assert.throws(() => parseRequest(request.slice(1)), /invalid_bytes/);
    assert.throws(
      () => parseRequest(Buffer.concat([request, Buffer.alloc(1)])),
      /invalid_bytes/,
    );
    const magic = Buffer.from(request);
    magic[0] ^= 1;
    assert.throws(() => parseRequest(magic), /request_magic/);
    for (const offset of [8, 72]) {
      const identity = Buffer.from(request);
      identity.fill(0, offset, offset + 32);
      assert.throws(() => parseRequest(identity), /invalid_point/);
      const malformed = Buffer.from(request);
      malformed.fill(255, offset, offset + 32);
      assert.throws(() => parseRequest(malformed), /invalid_point/);
    }
    const reused = Buffer.from(request);
    reused.copy(reused, 136, 72, 104);
    assert.throws(() => parseRequest(reused), /reused_randomness/);
    const identityC = Buffer.from(request);
    identityC.fill(0, 104, 136);
    assert.equal(parseRequest(identityC).inputs.length, 4);
  } finally {
    key.destroy();
  }
});
test("output is bound to model, exact request, signer and returning program before local decryption", () => {
  const key = createPrivateLinearKey();
  try {
    const request = key.encrypt([1, 2, 3, 4]),
      output = reference(request),
      b = binding(request);
    verifyOutput(output, b);
    assert.equal(
      MODEL_ID,
      createHash("sha256").update(MODEL_DESCRIPTION).digest("hex"),
    );
    assert.throws(
      () => verifyOutput(output, { ...b, caller: other }),
      /request_mismatch/,
    );
    assert.throws(
      () => verifyOutput(output, { ...b, returnProgram: other }),
      /wrong_return_program/,
    );
    const changed = Buffer.from(request);
    changed[40] ^= 1;
    assert.throws(
      () => verifyOutput(output, { ...b, request: changed }),
      /request_mismatch/,
    );
    for (const [offset, error] of [
      [0, /output_magic/],
      [8, /model_mismatch/],
      [40, /request_mismatch/],
    ] as const) {
      const tamper = Buffer.from(output);
      tamper[offset] ^= 1;
      assert.throws(() => verifyOutput(tamper, b), error);
    }
    for (const offset of [72, 104]) {
      const invalid = Buffer.from(output);
      invalid.fill(255, offset, offset + 32);
      assert.throws(() => verifyOutput(invalid, b), /invalid_point/);
    }
    const exposed = Buffer.from(output);
    exposed.fill(0, 72, 104);
    assert.throws(() => verifyOutput(exposed, b), /invalid_point/);
    assert.throws(() => verifyOutput(output.slice(1), b), /invalid_bytes/);
    const outOfRange = Buffer.from(output);
    outOfRange.set(
      Point.fromBytes(outOfRange.subarray(104))
        .add(Point.BASE.multiply(10000n))
        .toBytes(),
      104,
    );
    assert.throws(
      () => decryptOutput(key, outOfRange, b),
      /score_out_of_range/,
    );
  } finally {
    key.destroy();
  }
});
test("instruction has only one readonly signer and copies ciphertext bytes", () => {
  const key = createPrivateLinearKey();
  try {
    const request = key.encrypt([1, 2, 3, 4]),
      instruction = privateLinearInstruction(program, caller, request);
    assert.equal(instruction.programAddress, program);
    assert.deepEqual(instruction.accounts, [
      { address: caller, role: AccountRole.READONLY_SIGNER },
    ]);
    const original = Buffer.from(instruction.data!);
    request.fill(0);
    assert.deepEqual(Buffer.from(instruction.data!), original);
  } finally {
    key.destroy();
  }
});

test("aggregate nonce cancellation is rejected before instruction construction", () => {
  const key = createPrivateLinearKey();
  try {
    const request = key.encrypt([1, 2, 3, 4]);
    // Distinct nonzero canonical R values, but 3*1 - 2*2 + 5*3 - 14 = 0.
    for (const [i, n] of [1, 2, 3, -14].entries()) {
      const p = Point.BASE.multiply(BigInt(Math.abs(n)));
      request.set((n < 0 ? p.negate() : p).toBytes(), 72 + i * 64);
    }
    assert.throws(() => parseRequest(request), /zero_aggregate_randomness/);
    assert.throws(
      () => privateLinearInstruction(program, caller, request),
      /zero_aggregate_randomness/,
    );
    assert.throws(
      () => requestDigest(caller, request),
      /zero_aggregate_randomness/,
    );
  } finally {
    key.destroy();
  }
});
