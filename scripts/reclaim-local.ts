import { network } from "../lib/operator/config";
import { getOperator } from "../lib/operator/runtime";
import { safeError } from "../lib/server/security";
async function main() {
  const args = process.argv.slice(2);
  const cluster = network(args[0] || "devnet");
  if (args.some((a, i) => i > 0 && a !== "--execute"))
    throw new Error(
      "Usage: npm run reclaim:local -- devnet|mainnet-beta [--execute]",
    );
  const engine = getOperator();
  const preview = await engine.prepare(cluster, "withdraw");
  await engine.wait();
  let state = await engine.status(cluster);
  console.log(JSON.stringify(state, null, 2));
  if (!args.includes("--execute")) return;
  if (state.job?.phase !== "ready")
    throw new Error(state.job?.message || "Withdrawal preview unavailable");
  await engine.start(preview.id, cluster);
  await engine.wait();
  state = await engine.status(cluster, true);
  console.log(JSON.stringify(state, null, 2));
  if (state.job?.phase !== "complete") process.exitCode = 1;
}
main().catch((e) => {
  console.error(safeError(e));
  process.exitCode = 1;
});
