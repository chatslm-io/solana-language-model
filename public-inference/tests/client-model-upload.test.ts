import test from "node:test";
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import { modelUploadOperations } from "../client/model-upload-plan";
import type { PublicModelFixture } from "../harness/model-fixture";

test("upload writes every byte in bounded chunks, seals pages before model, and reserves allocation rent", async () => {
  const key = address("11111111111111111111111111111111");
  const writes: { offset: number; data: Uint8Array }[] = [];
  const ix = { programAddress: key };
  const payload = Uint8Array.from({ length: 1501 }, (_, i) => i % 251);
  const f = {
    binding: {},
    artifacts: { pages: [{ index: 0, payload }] },
    client: {
      model: key,
      createModel: () => ix,
      artifact: async () => key,
      allocateArtifact: async () => ix,
      writeArtifact: async (
        _index: number,
        offset: number,
        data: Uint8Array,
      ) => {
        writes.push({ offset, data });
        return ix;
      },
      sealArtifact: async () => ix,
      sealModel: () => ix,
    },
  } as unknown as PublicModelFixture;
  const ops = await modelUploadOperations(f, () => 123n);
  assert.deepEqual(
    ops.map((o) => o.name),
    [
      "model-create",
      "model-page-0-allocate",
      "model-page-0-write-0",
      "model-page-0-write-700",
      "model-page-0-write-1400",
      "model-page-0-seal",
      "model-seal",
    ],
  );
  assert.deepEqual(
    writes.map((w) => w.offset),
    [0, 700, 1400],
  );
  assert.ok(writes.every((w) => w.data.length <= 700));
  assert.deepEqual(
    Buffer.concat(writes.map((w) => Buffer.from(w.data))),
    Buffer.from(payload),
  );
  assert.equal(
    ops.reduce((n, o) => n + o.rent, 0n),
    246n,
  );
});
