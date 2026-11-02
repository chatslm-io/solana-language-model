import {
  configuredPath,
  assertBuildDirectory,
} from "../../lib/config/environment.mjs";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  lstatSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const source = fileURLToPath(new URL("./", import.meta.url));
export const outputDirectory = () =>
  configuredPath("SLM_PRIVATE_CRYPTO_BUILD_DIR");
export const binaryPath = () =>
  join(outputDirectory(), "sbpf-solana-solana/release/slm_private_crypto.so");
export function sourceHash() {
  const h = createHash("sha256");
  function sources(directory) {
    return readdirSync(join(source, directory), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const path = directory + "/" + entry.name;
        if (entry.isSymbolicLink()) throw Error("private_crypto_unsafe_source");
        return entry.isDirectory() ? sources(path) : [path];
      });
  }
  for (const f of [
    "Cargo.toml",
    "Cargo.lock",
    "build.mjs",
    "../../lib/config/environment.mjs",
    ...sources("src"),
  ])
    h.update(f + "\0")
      .update(readFileSync(join(source, f)))
      .update("\0");
  return h.digest("hex");
}
export function verifiedBinary() {
  const b = readFileSync(binaryPath());
  const m = JSON.parse(
    readFileSync(join(outputDirectory(), "build.json"), "utf8"),
  );
  if (
    m.source !== sourceHash() ||
    m.binary !== createHash("sha256").update(b).digest("hex")
  )
    throw Error("private_crypto_stale_binary");
  return b;
}
export async function build() {
  const output = outputDirectory();
  assertBuildDirectory(
    output,
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const si = lstatSync(output);
  if (
    !si.isDirectory() ||
    si.isSymbolicLink() ||
    si.mode & 0o077 ||
    (process.getuid && si.uid !== process.getuid())
  )
    throw Error("private_crypto_unsafe_build_directory");
  rmSync(join(outputDirectory(), "build.json"), { force: true });
  const paths = [configuredPath("SLM_SBF_PLATFORM_TOOLS")];
  const platform = paths.find((p) => {
    try {
      const st = statSync(p);
      return (
        !(st.mode & 0o022) &&
        (!process.getuid || st.uid === process.getuid()) &&
        spawnSync(join(p, "rust/bin/rustc"), ["--version"], {
          encoding: "utf8",
        }).stdout.includes("1.95.0-dev (1e20dd0d5")
      );
    } catch {
      return false;
    }
  });
  if (!platform)
    throw Error(
      "Install reviewed platform-tools v1.58 and set SLM_SBF_PLATFORM_TOOLS; no toolchain downloaded.",
    );
  const before = sourceHash();
  const timeoutMs = 15 * 60 * 1000;
  const started = Date.now();
  process.stderr.write(
    `[private-crypto] compiling SBF; elapsed 0s; timeout ${timeoutMs / 1000}s\n`,
  );
  const child = spawn(
    join(platform, "rust/bin/cargo"),
    [
      "build",
      "--manifest-path",
      join(source, "Cargo.toml"),
      "--target",
      "sbpf-solana-solana",
      "--target-dir",
      output,
      "--release",
      "--locked",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_DNA: "1",
        RUSTC: join(platform, "rust/bin/rustc"),
        CARGO_HOME: configuredPath("CARGO_HOME"),
      },
    },
  );
  let compilerOutput = "";
  let excessiveOutput = false;
  const onOutput = (bytes) => {
    process.stderr.write(bytes);
    compilerOutput += bytes.toString("utf8");
    if (compilerOutput.length > 16 * 1024 * 1024) {
      excessiveOutput = true;
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", onOutput);
  child.stderr.on("data", onOutput);
  const progress = setInterval(
    () =>
      process.stderr.write(
        `[private-crypto] compiling SBF; elapsed ${Math.floor((Date.now() - started) / 1000)}s; timeout ${timeoutMs / 1000}s\n`,
      ),
    10_000,
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  let status;
  try {
    status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearInterval(progress);
    clearTimeout(timeout);
  }
  // SBF LLVM may emit unsafe-stack diagnostics and still exit successfully.
  if (
    status !== 0 ||
    timedOut ||
    excessiveOutput ||
    sourceHash() !== before ||
    /Error:.*(?:overflows|overwrites)/.test(compilerOutput)
  )
    throw Error("private_crypto_build_failed_or_sources_changed");
  const b = readFileSync(binaryPath());
  writeFileSync(
    join(outputDirectory(), "build.json"),
    JSON.stringify({
      source: before,
      binary: createHash("sha256").update(b).digest("hex"),
      compiler: "platform-tools v1.58",
    }) + "\n",
    { mode: 0o600 },
  );
  process.stderr.write(
    `[private-crypto] SBF build complete; elapsed ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
  );
  console.log(
    JSON.stringify({
      scope: "experimental-private-crypto-build",
      binaryBytes: b.length,
      binarySha256: createHash("sha256").update(b).digest("hex"),
      elapsedMs: Date.now() - started,
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  build().catch((error) => {
    process.stderr.write(`[private-crypto] build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
