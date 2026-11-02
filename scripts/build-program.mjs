import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  configuredPath,
  assertBuildDirectory,
  approvedSigners,
} from "../lib/config/environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = configuredPath("SLM_STORAGE_BUILD_DIR");
const platform = configuredPath("SLM_SBF_PLATFORM_TOOLS");
approvedSigners();
assertBuildDirectory(output, root);
mkdirSync(output, { recursive: true, mode: 0o700 });
const info = lstatSync(output);
if (
  info.isSymbolicLink() ||
  realpathSync(output) !== output ||
  info.mode & 0o077
)
  throw Error("unsafe_build_output");
const compiler = join(platform, "rust/bin/rustc");
const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
if (version.status !== 0 || !version.stdout.includes("1.95.0-dev (1e20dd0d5"))
  throw Error("Pinned platform-tools v1.58 required");
rmSync(join(output, "build.json"), { force: true });
const result = spawnSync(
  join(platform, "rust/bin/cargo"),
  [
    "build",
    "--manifest-path",
    join(root, "program/Cargo.toml"),
    "--target",
    "sbpf-solana-solana",
    "--target-dir",
    output,
    "--release",
    "--locked",
  ],
  {
    stdio: "inherit",
    cwd: root,
    env: {
      ...process.env,
      NO_DNA: "1",
      RUSTC: compiler,
      CARGO_HOME: configuredPath("CARGO_HOME"),
    },
  },
);
if (result.error || result.status !== 0)
  throw Error("Storage SBF build failed");
const bytes = readFileSync(
  join(output, "sbpf-solana-solana/release/slm_storage.so"),
);
writeFileSync(
  join(output, "build.json"),
  JSON.stringify({
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }) + "\n",
  { mode: 0o600 },
);
