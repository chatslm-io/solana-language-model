type Quote = {
  usd: number | null;
  timestamp: number | null;
  fetchedAt: number;
  stale: boolean;
};
let cached: Quote = { usd: null, timestamp: null, fetchedAt: 0, stale: true };
let next = 0;
let pending: Promise<Quote> | null = null;
export async function price(): Promise<Quote> {
  if (Date.now() < next)
    return {
      ...cached,
      stale:
        cached.stale ||
        !cached.timestamp ||
        Date.now() - cached.timestamp > 120000,
    };
  if (pending) return pending;
  pending = (async () => {
    next = Date.now() + 60000;
    try {
      const headers: Record<string, string> = {};
      if (process.env.COINGECKO_DEMO_API_KEY)
        headers["x-cg-demo-api-key"] = process.env.COINGECKO_DEMO_API_KEY;
      const r = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_last_updated_at=true",
        { headers, signal: AbortSignal.timeout(8000) },
      );
      if (!r.ok) {
        if (r.status === 429)
          next =
            Date.now() +
            Math.max(60000, Number(r.headers.get("retry-after") || 60) * 1000);
        throw new Error("Price unavailable");
      }
      const q = (await r.json()).solana;
      if (
        !Number.isFinite(q.usd) ||
        q.usd <= 0 ||
        !Number.isFinite(q.last_updated_at)
      )
        throw new Error("Invalid quote");
      cached = {
        usd: q.usd,
        timestamp: q.last_updated_at * 1000,
        fetchedAt: Date.now(),
        stale: false,
      };
    } catch {
      cached = { ...cached, stale: true };
    }
    return {
      ...cached,
      stale:
        cached.stale ||
        !cached.timestamp ||
        Date.now() - cached.timestamp > 120000,
    };
  })().finally(() => {
    pending = null;
  });
  return pending;
}
