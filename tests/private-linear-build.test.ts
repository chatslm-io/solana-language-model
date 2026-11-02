import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  binaryDigest,
  sourceDigest,
  markerPath,
  verifiedBinary,
} from "../scripts/private-linear-build-support.mjs";

test("demo requires successful matching source and binary build evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "slm-build-evidence-"));
  try {
    for (const dir of ["scripts", "private-linear-program/src"])
      mkdirSync(join(root, dir), { recursive: true });
    for (const file of [
      "scripts/build-private-linear.mjs",
      "scripts/private-linear-build-support.mjs",
      "private-linear-program/Cargo.toml",
      "private-linear-program/Cargo.lock",
      "private-linear-program/src/lib.rs",
    ])
      writeFileSync(join(root, file), "synthetic build input");
    const binary = join(root, "synthetic.so"),
      bytes = Buffer.from("synthetic executable bytes");
    writeFileSync(binary, bytes);
    const save = () =>
      writeFileSync(
        markerPath(binary),
        JSON.stringify({
          version: 1,
          sourceSha256: sourceDigest(root),
          binarySha256: binaryDigest(bytes),
        }),
      );
    assert.throws(() => verifiedBinary(binary, root), /missing_or_stale/);
    save();
    assert.deepEqual(verifiedBinary(binary, root), bytes);
    writeFileSync(
      join(root, "private-linear-program/src/lib.rs"),
      "changed source",
    );
    assert.throws(() => verifiedBinary(binary, root), /missing_or_stale/);
    save();
    assert.deepEqual(verifiedBinary(binary, root), bytes);
    writeFileSync(binary, "changed executable");
    assert.throws(() => verifiedBinary(binary, root), /missing_or_stale/);
    writeFileSync(binary, bytes);
    save();
    rmSync(markerPath(binary));
    assert.throws(() => verifiedBinary(binary, root), /missing_or_stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
