/** Public test stages only. Keep JSON evidence on stdout and progress on stderr.
 * Never pass prompts, labels, keys, transaction bytes or provider errors here.
 */
export function createProgress(scope: string) {
  const started = performance.now();
  const log = (message: string) => {
    process.stderr.write(
      `[${scope} +${((performance.now() - started) / 1000).toFixed(1)}s] ${message}\n`,
    );
  };
  return {
    log,
    async run<T>(stage: string, action: () => Promise<T>): Promise<T> {
      log(stage);
      const since = performance.now();
      const timer = setInterval(() => {
        log(
          `${stage} — still waiting (${Math.floor((performance.now() - since) / 1000)}s)`,
        );
      }, 5000);
      timer.unref();
      try {
        const result = await action();
        log(`${stage} — done`);
        return result;
      } catch (error) {
        log(`${stage} — failed`);
        throw error;
      } finally {
        clearInterval(timer);
      }
    },
  };
}
export type TestProgress = ReturnType<typeof createProgress>;
