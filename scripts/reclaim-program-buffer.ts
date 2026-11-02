import { network } from "../lib/operator/config";
import { getOperator } from "../lib/operator/runtime";
import { safeError } from "../lib/server/security";

async function main() {
  const [selected = "devnet", flag] = process.argv.slice(2);
  if (process.argv.length > 4 || (flag && flag !== "--execute"))
    throw new Error(
      "Usage: npm run reclaim:buffer -- devnet|mainnet-beta [--execute]",
    );
  const cluster = network(selected),
    engine = getOperator();
  const state = await engine.status(cluster);
  const job = state.programDeployment;
  if (
    !job ||
    job.cluster !== cluster ||
    ["complete", "recovered"].includes(job.phase)
  )
    throw new Error("No unfinished program deployment on this network");
  console.log(
    JSON.stringify(
      {
        cluster,
        owner: job.owner,
        buffer: job.buffer,
        program: job.program,
        maximumRecoveryFee: job.recoveryFeeBudget,
        reservedRecoveryFees: job.recoveryFeesReserved,
      },
      null,
      2,
    ),
  );
  if (!flag) return;
  await engine.startProgram(job.id, cluster, true);
  await engine.wait();
  const result = (await engine.status(cluster, true)).programDeployment;
  console.log(JSON.stringify(result, null, 2));
  if (!result || !["recovered", "complete"].includes(result.phase))
    process.exitCode = 1;
}
main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
