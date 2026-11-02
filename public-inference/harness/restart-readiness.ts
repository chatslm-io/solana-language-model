import { rpcSlot } from "./confirmation";
import type { TestProgress } from "./progress";

/** A listening RPC may still be replaying an older snapshot. No signing or
 * uploaded-account verification is permitted until its finalized root catches up. */
export async function waitForFinalizedReplay(
  rpc: { rpc<T>(method: string, params: unknown[]): Promise<T> },
  minimumSlot: number,
  progress: TestProgress,
  options: { timeoutMs?: number; pollMs?: number } = {},
) {
  rpcSlot(minimumSlot);
  const timeout = options.timeoutMs ?? 90000;
  const poll = options.pollMs ?? 500;
  if (
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    !Number.isFinite(poll) ||
    poll <= 0
  )
    throw Error("invalid_restart_wait_options");
  return progress.run(
    `Waiting for restarted validator finalized slot >= ${minimumSlot} (${timeout / 1000}s timeout)`,
    async () => {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        const observed = rpcSlot(
          await rpc.rpc("getSlot", [{ commitment: "finalized" }]),
        );
        if (observed >= BigInt(minimumSlot)) return Number(observed);
        await new Promise((resolve) => setTimeout(resolve, poll));
      }
      throw Error("public_restart_finalized_replay_timeout");
    },
  );
}
