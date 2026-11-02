import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { inspectSecrets } from "./secret-rules.mjs";
const git = (...args) =>
  execFileSync("git", args, {
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
const findings = new Set();
const inspect = (name, bytes) =>
  inspectSecrets(name, bytes).forEach((label) =>
    findings.add(`${name}: ${label}`),
  );
const staged = process.argv.includes("--staged");
let hasGit = false;
try {
  hasGit =
    git("rev-parse", "--show-toplevel").toString().trim() === process.cwd();
} catch {}
if (!hasGit) {
  if (staged)
    throw Error("Cannot scan the Git index before repository initialization");
  const excluded = new Set([
    "node_modules",
    ".local",
    ".git",
    ".aws",
    ".agents",
    ".codex",
    ".next",
    "target",
  ]);
  let count = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink())
        findings.add(`${name}: symlink requires review`);
      else if (entry.isDirectory()) walk(name);
      else {
        count++;
        inspect(name, readFileSync(name));
      }
    }
  };
  console.error("Scanning source files; no Git index or history is present.");
  walk(".");
  if (findings.size) console.error([...findings].join("\n"));
  else
    console.log(
      `Secret scan passed (${count} source files; pattern checks only).`,
    );
  process.exit(findings.size ? 1 : 0);
}
const names = git("ls-files", "--cached", "-z")
  .toString()
  .split("\0")
  .filter(Boolean);
// Inspect the actual index; a sanitized working copy must not conceal a secret
// already staged for commit. Files are never echoed on failure.
for (const name of names) inspect(name, git("show", `:${name}`));
if (!staged) {
  for (const name of git(
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .toString()
    .split("\0")
    .filter(Boolean))
    if (existsSync(name)) inspect(name, readFileSync(name));
  let objects = "";
  try {
    objects = git("rev-list", "--objects", "--all").toString();
  } catch {}
  for (const line of objects.split("\n").filter(Boolean)) {
    const at = line.indexOf(" ");
    if (at < 0) continue;
    const hash = line.slice(0, at),
      name = line.slice(at + 1);
    if (git("cat-file", "-t", hash).toString().trim() === "blob")
      inspect(`history/${name}`, git("cat-file", "blob", hash));
  }
}
if (findings.size) {
  process.stderr.write(
    [...findings].join("\n") +
      "\nCommit/push blocked. Remove the secret from the index and history before continuing.\n",
  );
  process.exitCode = 1;
} else
  console.log(
    `Secret scan passed (${staged ? "Git index" : "index, publishable files and reachable history"}). Pattern checks reduce accidental leaks; they cannot guarantee none are possible.`,
  );
