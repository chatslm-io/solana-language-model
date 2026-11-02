// Stop scheduling new reads on failure, then settle every in-flight read.
export async function mapConcurrent<T, U>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<U>,
): Promise<U[]> {
  const result = new Array<U>(items.length);
  let cursor = 0,
    stopped = false;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!stopped && cursor < items.length) {
        const index = cursor++;
        try {
          result[index] = await work(items[index]);
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    }),
  );
  const failed = workers.find((worker) => worker.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return result;
}
