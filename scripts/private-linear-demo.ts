import { runLocalDemo } from "../lib/private-linear/local";
runLocalDemo().then(
  (evidence) => process.stdout.write(JSON.stringify(evidence, null, 2) + "\n"),
  (error: unknown) => {
    if (
      error instanceof Error &&
      error.message === "private_linear_build_missing_or_stale"
    ) {
      process.stderr.write(
        "No successful build matching the current source and binary. Run node scripts/build-private-linear.mjs successfully before the demo.\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      "Encrypted linear-model demo failed. Build the separate SBF program first with node scripts/build-private-linear.mjs. No private diagnostics are printed.\n",
    );
    process.exitCode = 1;
  },
);
