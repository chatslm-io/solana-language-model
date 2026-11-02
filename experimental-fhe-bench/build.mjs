import { configuredPath } from "../lib/config/environment.mjs";
import {
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
  rename,
} from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  REPOSITORY,
  sourceDigest,
  binaryDigest,
  markerPath,
} from "./build-support.mjs";

const binary = join(
  REPOSITORY,
  "experimental-fhe-bench/target/deploy/slm_fhe_ntt_bench.so",
);
const marker = markerPath(binary);
const compilerVersion = "1.95.0-dev (1e20dd0d5";
function reviewedPlatform(path) {
  try {
    const info = statSync(path);
    if (
      !info.isDirectory() ||
      info.mode & 0o022 ||
      (process.getuid && info.uid !== process.getuid())
    )
      return false;
    const version = spawnSync(join(path, "rust/bin/rustc"), ["--version"], {
      encoding: "utf8",
    });
    return version.status === 0 && version.stdout.includes(compilerVersion);
  } catch {
    return false;
  }
}
function findPlatform() {
  const explicit = process.env.SLM_SBF_PLATFORM_TOOLS;
  if (explicit) {
    if (!reviewedPlatform(explicit))
      throw Error(
        "SLM_SBF_PLATFORM_TOOLS must select the reviewed v1.58 compiler in a user-owned, non-writable-by-others directory.",
      );
    return explicit;
  }
  throw Error("Set SLM_SBF_PLATFORM_TOOLS to the reviewed v1.58 toolchain");
}
function commandSucceeded(result) {
  if (result.error)
    throw Error(
      "SBF build tool could not start. Install the pinned toolchain for this program or set SLM_SBF_PLATFORM_TOOLS to its directory.",
    );
  if (result.status !== 0)
    throw Error(
      "SBF compilation failed; no successful build marker was written. Check the compiler output above.",
    );
}
async function main() {
  // A failed rebuild must never leave the previous binary looking freshly built.
  await rm(marker, { force: true });
  const before = sourceDigest();
  const platform = findPlatform();
  let compilerLabel;
  if (platform) {
    compilerLabel = "platform-tools v1.58 / Rust 1.95.0-dev";
    const env = {
      ...process.env,
      RUSTC: join(platform, "rust/bin/rustc"),
      CARGO_HOME: configuredPath("CARGO_HOME"),
      NO_DNA: "1",
    };
    process.stdout.write(
      "Building with configured pinned platform-tools v1.58.\n",
    );
    commandSucceeded(
      spawnSync(
        join(platform, "rust/bin/cargo"),
        [
          "build",
          "--manifest-path",
          "experimental-fhe-bench/Cargo.toml",
          "--target",
          "sbpf-solana-solana",
          "--target-dir",
          "experimental-fhe-bench/target",
          "--release",
          "--locked",
        ],
        { cwd: REPOSITORY, stdio: "inherit", env },
      ),
    );
    await mkdir(join(REPOSITORY, "experimental-fhe-bench/target/deploy"), {
      recursive: true,
    });
    await copyFile(
      join(
        REPOSITORY,
        "experimental-fhe-bench/target/sbpf-solana-solana/release/slm_fhe_ntt_bench.so",
      ),
      binary,
    );
  }
  if (sourceDigest() !== before)
    throw Error(
      "Build sources changed during compilation; rebuild before running the demo.",
    );
  const evidence = {
    version: 1,
    sourceSha256: before,
    binarySha256: binaryDigest(await readFile(binary)),
    compiler: compilerLabel,
  };
  const staging = marker + ".tmp";
  await writeFile(staging, JSON.stringify(evidence) + "\n");
  await rename(staging, marker);
  process.stdout.write(
    "Public NTT arithmetic benchmark built successfully; source and binary hashes recorded.\n",
  );
}
main().catch((error) => {
  process.stderr.write(
    `NTT arithmetic benchmark build failed: ${error.message}\n`,
  );
  process.exitCode = 1;
});
