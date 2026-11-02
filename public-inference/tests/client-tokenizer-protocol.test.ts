import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildTokenizerPages,
  encodeTokenizerBinding,
  tokenizerLeaf,
  type TokenizerBinding,
} from "../tokenizer-protocol";

test("tokenizer binding uses fixed fields, bounds and zero reserved bytes", () => {
  const binding: TokenizerBinding = {
    model: "01".repeat(32),
    modelBinding: "02".repeat(32),
    sourceSha: "03".repeat(32),
    tableRoot: "04".repeat(32),
    profileRoot: "05".repeat(32),
    unicodeSha: "06".repeat(32),
    pageCount: 33,
    maxInputBytes: 512,
    maxMessages: 4,
    vocabulary: 8196,
  };
  const bytes = encodeTokenizerBinding(binding);
  assert.equal(bytes.length, 224);
  assert.equal(bytes.toString("ascii", 0, 8), "SLMPTB01");
  for (let i = 0; i < 6; i++)
    assert.deepEqual(
      bytes.subarray(8 + i * 32, 40 + i * 32),
      Buffer.alloc(32, i + 1),
    );
  assert.deepEqual(
    [...bytes.subarray(200, 216)],
    [33, 0, 0, 0, 0, 2, 0, 0, 4, 0, 0, 0, 4, 32, 0, 0],
  );
  assert.deepEqual(bytes.subarray(216), Buffer.alloc(8));
  assert.throws(() =>
    encodeTokenizerBinding({
      ...binding,
      maxInputBytes: 513,
    } as unknown as TokenizerBinding),
  );
  assert.throws(() => encodeTokenizerBinding({ ...binding, tableRoot: "bad" }));
});

test("all tokenizer proof positions independently reconstruct the domain-separated root", () => {
  const input = Array.from({ length: 33 }, (_, i) => Uint8Array.of(i)),
    tree = buildTokenizerPages(input),
    hash = (...parts: Uint8Array[]) =>
      createHash("sha256").update(Buffer.concat(parts)).digest();
  input[0][0] = 255;
  assert.equal(
    tree.pages[0].payload[0],
    0,
    "builder must snapshot source bytes",
  );
  for (const page of tree.pages) {
    const fields = Buffer.alloc(8);
    fields.writeUInt32LE(page.index);
    fields.writeUInt32LE(page.payload.length, 4);
    let digest = hash(
      Buffer.from("slm-public:tokenizer-page:v1\n"),
      fields,
      hash(page.payload),
    );
    assert.equal(page.proof.length, 6);
    page.proof.forEach((s, level) => {
      const sibling = Buffer.from(s, "hex");
      digest = hash(
        Buffer.from("slm-public:tokenizer-node:v1\n"),
        ...((page.index >>> level) & 1 ? [sibling, digest] : [digest, sibling]),
      );
    });
    assert.equal(digest.toString("hex"), tree.root);
  }
  assert.throws(() => buildTokenizerPages(input.slice(1)));
  assert.throws(() => tokenizerLeaf(0, 0, "00".repeat(32)));
  assert.throws(() => tokenizerLeaf(33, 1, "00".repeat(32)));
  assert.throws(() => tokenizerLeaf(64, 0, "00".repeat(32)));
});
