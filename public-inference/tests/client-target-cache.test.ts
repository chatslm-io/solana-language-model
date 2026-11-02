/** Only small synthetic public bytes enter the injected test path, never a model. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  statSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readOrCreatePinnedCache } from "../reference/target-cache";
import type { PrivateDirectory } from "../../lib/operator/external";
test("protected pinned cache verifies first download and reuses public bytes without download", async () => {
  const root = mkdtempSync("/tmp/slm-public-cache-test-"),
    bytes = Buffer.from("synthetic public fixture"),
    identity = {
      fileName: "synthetic.bin",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    paths = {
      privateDirectory(p: string) {
        assert.equal(p, root);
        mkdirSync(p, { recursive: true, mode: 0o700 });
        return p as PrivateDirectory;
      },
    };
  let downloads = 0;
  try {
    const first = await readOrCreatePinnedCache(
      root,
      identity,
      async () => {
        downloads++;
        return bytes;
      },
      paths,
    );
    assert.equal(first.cacheHit, false);
    const second = await readOrCreatePinnedCache(
      root,
      identity,
      async () => {
        throw Error("must not download");
      },
      paths,
    );
    assert.equal(second.cacheHit, true);
    assert.deepEqual(Buffer.from(second.bytes), bytes);
    assert.equal(downloads, 1);
    assert.equal(statSync(first.path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(root), [identity.fileName]);
    writeFileSync(first.path, Buffer.alloc(bytes.length), { mode: 0o600 });
    await assert.rejects(
      readOrCreatePinnedCache(root, identity, async () => bytes, paths),
      /cached_checkpoint_identity/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cache refuses symlinks and rejected protected paths before downloading", async () => {
  const root = mkdtempSync("/tmp/slm-public-cache-test-"),
    bytes = Buffer.from("public"),
    identity = {
      fileName: "cache.bin",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  let download = false;
  try {
    await assert.rejects(
      readOrCreatePinnedCache(
        root,
        identity,
        async () => {
          download = true;
          return bytes;
        },
        {
          privateDirectory() {
            throw Error("outside Git required");
          },
        },
      ),
      /outside Git/,
    );
    assert.equal(download, false);
    writeFileSync(join(root, "source.bin"), bytes, { mode: 0o600 });
    symlinkSync(join(root, "source.bin"), join(root, "cache.bin"));
    await assert.rejects(
      readOrCreatePinnedCache(
        root,
        identity,
        async () => {
          download = true;
          return bytes;
        },
        { privateDirectory: (p) => p as PrivateDirectory },
      ),
    );
    assert.equal(download, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
