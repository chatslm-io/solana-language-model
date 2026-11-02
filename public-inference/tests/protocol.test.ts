import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArtifacts,
  verifyArtifact,
  command,
  encodeCommand,
  decodeCommand,
  OP,
} from "../protocol";

test("public artifact proofs reject substituted content, indices, kinds and siblings", () => {
  const tree = buildArtifacts([
    { kind: 1, payload: Uint8Array.of(1, 2, 3) },
    { kind: 1, payload: Uint8Array.of(4) },
    { kind: 2, payload: Uint8Array.of(5, 6) },
  ]);
  for (const page of tree.pages) verifyArtifact(tree.root, 3, page);
  const page = tree.pages[0];
  for (const changed of [
    { ...page, payload: Uint8Array.of(3, 2, 1) },
    { ...page, index: 1 },
    { ...page, kind: 2 as const },
    { ...page, proof: page.proof.slice(1) },
    { ...page, proof: ["00".repeat(32), ...page.proof.slice(1)] },
  ])
    assert.throws(() => verifyArtifact(tree.root, 3, changed));
  assert.throws(() => verifyArtifact(tree.root, 2, tree.pages[2]));
});

test("public commands preserve fused head fields and reject malformed wire encoding", () => {
  const c = command(OP.HEAD_GEMV_ARGMAX, {
    src: 256,
    dst: 736,
    cols: 128,
    rows: 16,
    aux0: 1940,
    aux1: 1941,
    flags: 1,
  });
  const encoded = encodeCommand(c);
  assert.equal(encoded.length, 64);
  assert.equal(encoded.readUInt32LE(0), 19);
  assert.equal(encoded.readUInt32LE(44), 0xffffffff);
  assert.deepEqual(decodeCommand(encoded), c);
  assert.throws(() => decodeCommand(encoded.subarray(1)));
  for (const offset of [0, 60]) {
    const corrupt = Buffer.from(encoded);
    corrupt.writeUInt32LE(0xffffffff, offset);
    assert.throws(() => decodeCommand(corrupt));
  }
});
