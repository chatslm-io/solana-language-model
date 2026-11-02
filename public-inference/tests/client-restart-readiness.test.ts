import test from "node:test";
import assert from "node:assert/strict";
import { waitForFinalizedReplay } from "../harness/restart-readiness";
const progress = {
  log() {},
  async run<T>(_stage: string, action: () => Promise<T>) {
    return action();
  },
};
test("restart readiness waits for the pre-shutdown finalized root, not RPC availability", async () => {
  const slots = [10911, 10924, 10996, 10997];
  let reads = 0;
  const rpc = {
    async rpc<T>(method: string, params: unknown[]) {
      assert.equal(method, "getSlot");
      assert.deepEqual(params, [{ commitment: "finalized" }]);
      return slots[reads++] as T;
    },
  };
  assert.equal(
    await waitForFinalizedReplay(rpc, 10997, progress, { pollMs: 1 }),
    10997,
  );
  assert.equal(reads, 4);
});
test("stalled replay times out without signing or accepting stale account state", async () => {
  await assert.rejects(
    waitForFinalizedReplay(
      {
        async rpc<T>(method: string) {
          assert.equal(method, "getSlot");
          return 1 as T;
        },
      },
      2,
      progress,
      { timeoutMs: 10, pollMs: 1 },
    ),
    /replay_timeout/,
  );
});
test("invalid replay slots fail closed", async () => {
  await assert.rejects(
    waitForFinalizedReplay(
      {
        async rpc<T>() {
          return -1 as T;
        },
      },
      2,
      progress,
    ),
    /invalid_rpc_slot/,
  );
});
