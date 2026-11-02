import type { RpcPolicy } from "@/lib/chain/rpc-policy";
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Serialize admission, not HTTP responses. Delayed timers cannot release a
// burst of previously reserved slots. All clients can share this one limiter.
export function createRpcLimiter({ now = Date.now, wait = pause } = {}) {
  let tail = Promise.resolve(),
    cooldown = 0;
  let last = -Infinity,
    lastSend = -Infinity,
    lastScan = -Infinity;
  return {
    acquire(policy: RpcPolicy | undefined, method: string, deadline: number) {
      const run = tail.then(async () => {
        const interval =
          policy?.mode === "paid"
            ? Math.ceil(1000 / policy.rps)
            : policy
              ? 300
              : 0;
        const sendInterval =
          policy?.mode === "paid" ? Math.ceil(1000 / policy.sendRps) : 0;
        const scanInterval =
          policy?.mode === "paid" ? Math.ceil(1000 / policy.scanRps) : 0;
        for (;;) {
          const start = Math.max(
            now(),
            cooldown,
            last + interval,
            method === "sendTransaction" ? lastSend + sendInterval : 0,
            method === "getProgramAccounts" ? lastScan + scanInterval : 0,
          );
          if (start >= deadline) return false;
          if (start > now()) {
            await wait(start - now());
            continue;
          }
          const at = now();
          last = at;
          if (method === "sendTransaction") lastSend = at;
          if (method === "getProgramAccounts") lastScan = at;
          return true;
        }
      });
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    cooldown(until: number) {
      cooldown = Math.max(cooldown, until);
    },
  };
}
