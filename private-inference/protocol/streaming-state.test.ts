import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyCompletedStreamingBytes } from "./streaming-state";

const vector = JSON.parse(
  readFileSync(
    new URL("./streaming-state-vectors.json", import.meta.url),
    "utf8",
  ),
);
const bytes = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
function fixture() {
  return {
    session: bytes(vector.session),
    sessionAddress: bytes(vector.sessionAddress),
    slots: vector.slots.map(bytes) as [Uint8Array, Uint8Array],
    slotBumps: vector.slotBumps as [number, number],
    descriptor: bytes(vector.descriptor),
  };
}
test("streaming result validates independent Python descriptor/state hashes and rejects altered accounts", async () => {
  assert.deepEqual(
    await verifyCompletedStreamingBytes(fixture()),
    bytes(vector.output),
  );
  for (const page of [0, 1]) {
    for (const at of [
      0, 8, 9, 10, 11, 12, 16, 48, 80, 112, 144, 148, 152, 156, 160, 164, 168,
      172, 176, 208, 212,
    ]) {
      const f = fixture();
      f.slots[page][at] ^= 1;
      await assert.rejects(
        verifyCompletedStreamingBytes(f),
        /invalid_streaming_result/,
      );
    }
  }
  for (const at of [256, 260, 264]) {
    const f = fixture();
    f.slots[0][at] ^= 1;
    await assert.rejects(
      verifyCompletedStreamingBytes(f),
      /invalid_streaming_result/,
    );
  }
  const changed = fixture();
  changed.descriptor[136] ^= 1;
  await assert.rejects(
    verifyCompletedStreamingBytes(changed),
    /invalid_streaming_result/,
  );
});
