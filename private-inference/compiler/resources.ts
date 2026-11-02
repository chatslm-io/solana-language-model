import { selectedTargetResourcePlan } from "./target-plan";
const arg = process.argv[2],
  positions = arg === undefined ? 40 : Number(arg);
try {
  if (process.argv.length > 3) throw Error("usage");
  console.log(JSON.stringify(selectedTargetResourcePlan(positions), null, 2));
} catch {
  console.error(
    "Usage: node --import tsx private-inference/compiler/resources.ts [public-sequence-positions:1..1024]",
  );
  process.exitCode = 1;
}
