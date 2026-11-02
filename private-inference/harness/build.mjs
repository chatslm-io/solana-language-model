import {
  configuredPath,
  assertBuildDirectory,
} from "../../lib/config/environment.mjs";
import { spawnSync } from "node:child_process";
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
export const outputDirectory = () => configuredPath("SLM_PRIVATE_BUILD_DIR");
const files = [
  "program/Cargo.toml",
  "program/Cargo.lock",

  "crypto-core/Cargo.toml",

  "harness/build.mjs",
  "../lib/config/environment.mjs",
];
export function sourceHash() {
  const h = createHash("sha256");
  const rustFiles = (path) =>
    readdirSync(join(root, "private-inference", path), {
      withFileTypes: true,
    }).flatMap((entry) =>
      entry.isDirectory()
        ? rustFiles(path + "/" + entry.name)
        : [path + "/" + entry.name],
    );
  for (const f of [
    ...files,
    ...rustFiles("program/src"),
    ...rustFiles("crypto-core/src"),
  ].sort())
    h.update(f + "\0")
      .update(readFileSync(join(root, "private-inference", f)))
      .update("\0");
  return h.digest("hex");
}
export function verifiedBinary(flavor) {
  if (
    !["mock", "experimental", "production", "circuit", "stream"].includes(
      flavor,
    )
  )
    throw Error("invalid_build_flavor");
  const directory = join(outputDirectory(), flavor),
    binary = join(
      directory,
      "sbpf-solana-solana/release/slm_private_inference.so",
    );
  const marker = JSON.parse(
    readFileSync(join(directory, "build.json"), "utf8"),
  );
  const bytes = readFileSync(binary);
  if (
    marker.flavor !== flavor ||
    marker.sourceSha256 !== sourceHash() ||
    marker.binarySha256 !== createHash("sha256").update(bytes).digest("hex")
  )
    throw Error("private_inference_stale_binary");
  return bytes;
}
export function build() {
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
  const mock = process.argv.includes("--test-only-mock"),
    experimental = process.argv.includes("--experimental-half-gates"),
    circuit = process.argv.includes("--experimental-circuit"),
    stream = process.argv.includes("--experimental-stream");
  if ([mock, experimental, circuit, stream].filter(Boolean).length > 1)
    throw Error("cannot combine mock and real evaluator");
  const flavor = mock
    ? "mock"
    : experimental
      ? "experimental"
      : circuit
        ? "circuit"
        : stream
          ? "stream"
          : "production";
  const target = join(output, flavor);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (lstatSync(target).isSymbolicLink()) throw Error("unsafe_build_flavor");
  rmSync(join(target, "build.json"), { force: true });
  const before = sourceHash();
  const args = [
    "build",
    "--manifest-path",
    join(root, "private-inference/program/Cargo.toml"),
    "--target",
    "sbpf-solana-solana",
    "--target-dir",
    target,
    "--release",
    "--locked",
  ];
  if (mock) args.push("--features", "test-only-mock-evaluator");
  if (experimental) args.push("--features", "experimental-half-gates");
  if (circuit) args.push("--features", "experimental-circuit");
  if (stream) args.push("--features", "experimental-stream");
  const env = {
    ...process.env,
    NO_DNA: "1",
    RUSTC: join(platform, "rust/bin/rustc"),
    CARGO_HOME: configuredPath("CARGO_HOME"),
  };
  const run = spawnSync(join(platform, "rust/bin/cargo"), args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (run.status !== 0 || sourceHash() !== before)
    throw Error("build_failed_or_sources_changed");
  const binary = join(
    target,
    "sbpf-solana-solana/release/slm_private_inference.so",
  );
  const digest = createHash("sha256")
    .update(readFileSync(binary))
    .digest("hex");
  writeFileSync(
    join(target, "build.json"),
    JSON.stringify({
      flavor,
      scope: mock
        ? "TEST ONLY MOCK lifecycle; not encrypted inference"
        : experimental
          ? "experimental real half-gates AND; not transformer or approved production"
          : circuit
            ? "experimental bounded Boolean circuit; not transformer or production"
            : stream
              ? "experimental Merkle-window streaming gates; not transformer or production"
              : "lifecycle without production evaluator",
      sourceSha256: before,
      compiler: version.stdout.trim(),
      binarySha256: digest,
      binary,
    }) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ binary, binarySha256: digest, flavor }));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  build();
