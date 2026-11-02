import { execFileSync } from "node:child_process";
try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
} catch {
  console.log(
    "No Git repository; initialize Git and run npm run hooks:install.",
  );
  process.exit(0);
}
let current = "";
try {
  current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {}
if (current && current !== ".githooks") {
  console.error(
    "Existing Git hooks path retained. Add scripts/audit-secrets.mjs to your commit/push hooks.",
  );
  process.exitCode = 1;
} else {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"]);
  console.log("Installed commit and push secret checks.");
}
