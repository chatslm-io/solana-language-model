import assert from "node:assert/strict";
import test from "node:test";
import { packWeights, packedRows } from "../compiler/weights";
import type { PublicModelPlan, PublicTensor } from "../compiler/model";
test("whole-row pages preserve all bytes and isolate expert slices", () => {
  const tensor: PublicTensor = {
    id: 0,
    name: "experts",
    dtype: "Q8_0",
    shape: [352, 25, 3],
    offset: 7,
    bytes: 374 * 25 * 3,
    rowElements: 352,
    rows: 25,
    slices: 3,
    rowBytes: 374,
    sha256: "",
  };
  const source = Uint8Array.from(
      { length: tensor.offset + tensor.bytes },
      (_, i) => i % 251,
    ),
    plan = { tensors: [tensor] } as unknown as PublicModelPlan;
  const packed = packWeights(plan, source),
    t = packed.tensors.get("experts")!;
  assert.equal(t.pagesPerSlice, 2);
  assert.equal(packed.pages.length, 6);
  for (let slice = 0; slice < 3; slice++) {
    const joined = Buffer.concat(packed.pages.slice(slice * 2, slice * 2 + 2));
    assert.deepEqual(
      joined,
      Buffer.from(
        source.subarray(7 + slice * 25 * 374, 7 + (slice + 1) * 25 * 374),
      ),
    );
  }
  const rows = packedRows(t, 2048);
  assert.equal(
    rows.reduce((n, c) => n + c.count, 0),
    25,
  );
  for (const c of rows) {
    assert.ok(c.count * 352 <= 2048);
    assert.ok(c.offset + c.count * 374 <= packed.pages[c.page].length);
  }
  source.fill(0);
  assert.notEqual(packed.pages[0][0], 0);
});
test("oversized rows reject instead of crossing weight accounts", () => {
  const plan = {
    tensors: [
      {
        name: "bad",
        rowBytes: 8193,
        offset: 0,
        bytes: 8193,
        rows: 1,
        slices: 1,
      },
    ],
  } as unknown as PublicModelPlan;
  assert.throws(() => packWeights(plan, new Uint8Array(8193)), /row_bounds/);
});
