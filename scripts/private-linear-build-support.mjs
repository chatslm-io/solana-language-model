import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
export const binaryDigest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const markerPath = (binary) => binary + ".build.json";
export function sourceDigest(root = REPOSITORY) {
  const files = [
    "private-linear-program/Cargo.toml",
    "private-linear-program/Cargo.lock",
    "scripts/build-private-linear.mjs",
    "scripts/private-linear-build-support.mjs",
  ];
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        info = lstatSync(path);
      if (info.isSymbolicLink())
        throw Error("private_linear_unsafe_build_source");
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) files.push(relative(root, path));
    }
  }
  walk(join(root, "private-linear-program/src"));
  const hash = createHash("sha256");
  for (const name of files.sort())
    hash
      .update(name + "\0")
      .update(readFileSync(join(root, name)))
      .update("\0");
  return hash.digest("hex");
}
/** Local freshness evidence, not a signature or security attestation. */
export function verifiedBinary(path, root = REPOSITORY) {
  try {
    const bytes = readFileSync(path);
    const marker = JSON.parse(readFileSync(markerPath(path), "utf8"));
    if (
      marker.version !== 1 ||
      marker.sourceSha256 !== sourceDigest(root) ||
      marker.binarySha256 !== binaryDigest(bytes)
    )
      throw Error("mismatch");
    return bytes;
  } catch {
    throw Error("private_linear_build_missing_or_stale");
  }
}
