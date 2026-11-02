import {
  configuredPath,
  assertBuildDirectory,
  approvedSigners,
} from "../../lib/config/environment.mjs";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  realpathSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../../", import.meta.url));
export const outputDirectory = () => configuredPath("SLM_PUBLIC_BUILD_DIR");
const files = [
  "program/Cargo.toml",
  "program/Cargo.lock",

  "kernel/Cargo.toml",

  "harness/build.mjs",
  "../lib/config/environment.mjs",
];
export function sourceHash() {
  const h = createHash("sha256");
  h.update(JSON.stringify(approvedSigners()));
  const rustFiles = (path) =>
    readdirSync(join(root, "public-inference", path), {
      withFileTypes: true,
    }).flatMap((entry) =>
      entry.isDirectory()
        ? rustFiles(path + "/" + entry.name)
        : [path + "/" + entry.name],
    );
  for (const f of [
    ...files,
    ...rustFiles("program/src"),
    ...rustFiles("kernel/src"),
  ].sort())
    h.update(f + "\0")
      .update(readFileSync(join(root, "public-inference", f)))
      .update("\0");
  return h.digest("hex");
}
export function verifiedBinary() {
  const directory = outputDirectory(),
    binary = join(
      directory,
      "sbpf-solana-solana/release/slm_public_inference.so",
    );
  const marker = JSON.parse(
    readFileSync(join(directory, "build.json"), "utf8"),
  );
  const bytes = readFileSync(binary);
  if (
    marker.sourceSha256 !== sourceHash() ||
    marker.binarySha256 !== createHash("sha256").update(bytes).digest("hex")
  )
    throw Error("public_inference_stale_binary");
  return bytes;
}
export async function build() {
  const output = outputDirectory();
  const platform = configuredPath("SLM_SBF_PLATFORM_TOOLS");
  assertBuildDirectory(output, root);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const outStat = lstatSync(output);
  if (
    outStat.isSymbolicLink() ||
    realpathSync(output) !== output ||
    outStat.mode & 0o077 ||
    (process.getuid && outStat.uid !== process.getuid())
  )
    throw Error("unsafe_build_output");
  if (!existsSync(join(platform, "rust/bin/rustc")))
    throw Error(
      "Pinned platform-tools v1.58 required; set SLM_SBF_PLATFORM_TOOLS to its installation directory",
    );
  const platformStat = lstatSync(platform);
  if (
    platformStat.isSymbolicLink() ||
    platformStat.mode & 0o022 ||
    (process.getuid && platformStat.uid !== process.getuid())
  )
    throw Error("unsafe_platform");
  const version = spawnSync(join(platform, "rust/bin/rustc"), ["--version"], {
    encoding: "utf8",
  });
  if (version.status !== 0 || !version.stdout.includes("1.95.0-dev (1e20dd0d5"))
    throw Error("unreviewed SBF compiler");
  const target = output;
  rmSync(join(target, "build.json"), { force: true });
  const before = sourceHash();
  const args = [
    "build",
    "--manifest-path",
    join(root, "public-inference/program/Cargo.toml"),
    "--target",
    "sbpf-solana-solana",
    "--target-dir",
    target,
    "--release",
    "--locked",
  ];
  const env = {
    ...process.env,
    NO_DNA: "1",
    RUSTC: join(platform, "rust/bin/rustc"),
    CARGO_HOME: configuredPath("CARGO_HOME"),
  };
  const started = Date.now();
  console.error("[public SBF build] Compiling pinned sources; timeout 900s");
  const status = await new Promise((resolve, reject) => {
    const child = spawn(join(platform, "rust/bin/cargo"), args, {
      cwd: root,
      env,
      stdio: "inherit",
    });
    const heartbeat = setInterval(
      () =>
        console.error(
          `[public SBF build] Compiling; elapsed ${Math.floor((Date.now() - started) / 1000)}s / timeout 900s`,
        ),
      5000,
    );
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 900000);
    child.once("error", (error) => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      resolve(code);
    });
  });
  console.error(
    `[public SBF build] Compiler finished after ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  if (status !== 0 || sourceHash() !== before)
    throw Error("build_failed_or_sources_changed");
  const binary = join(
    target,
    "sbpf-solana-solana/release/slm_public_inference.so",
  );
  const digest = createHash("sha256")
    .update(readFileSync(binary))
    .digest("hex");
  writeFileSync(
    join(target, "build.json"),
    JSON.stringify({
      scope: "public model evaluator; no privacy claim",
      sourceSha256: before,
      compiler: version.stdout.trim(),
      binarySha256: digest,
      binary,
    }) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ binary, binarySha256: digest }));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  build().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
