/** Public pinned model cache. Production always enforces the external-state guard;
 * cache contents are never trusted without exact size and SHA-256 verification. */
import {
  constants,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  privateDirectory,
  readProtectedFile,
  type PrivateDirectory,
} from "../../lib/operator/external";
import { SELECTED_TARGET } from "../compiler/model";
import { loadTarget } from "./load-target";
export type CachePathPolicy = {
  privateDirectory: (path: string) => PrivateDirectory;
};
const protectedPaths: CachePathPolicy = { privateDirectory };
export async function readOrCreatePinnedCache(
  directory: string,
  identity: { fileName: string; bytes: number; sha256: string },
  download: () => Promise<Uint8Array>,
  paths: CachePathPolicy = protectedPaths,
): Promise<{ bytes: Uint8Array; path: string; cacheHit: boolean }> {
  if (
    !/^[a-zA-Z0-9._-]{1,128}$/.test(identity.fileName) ||
    !Number.isSafeInteger(identity.bytes) ||
    identity.bytes < 1 ||
    identity.bytes > 64 * 1024 * 1024 ||
    !/^([a-f0-9]{64})$/.test(identity.sha256)
  )
    throw Error("public_cache_identity");
  const root = paths.privateDirectory(directory),
    path = join(root, identity.fileName);
  const verify = (bytes: Uint8Array) => {
    if (
      bytes.length !== identity.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== identity.sha256
    )
      throw Error("public_cached_checkpoint_identity");
    return Uint8Array.from(bytes);
  };
  const read = () => verify(readProtectedFile(path, identity.bytes));
  try {
    return { bytes: read(), path, cacheHit: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bytes = verify(await download()),
    temporary = join(root, `.cache-${randomUUID()}.tmp`),
    fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  try {
    try {
      let at = 0;
      while (at < bytes.length)
        at += writeSync(fd, bytes, at, bytes.length - at);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return { bytes: read(), path, cacheHit: true };
    }
  } finally {
    unlinkSync(temporary);
  }
  return { bytes: read(), path, cacheHit: false };
}
export async function loadCachedTarget(
  directory: string,
  progress: (message: string) => void = () => {},
): Promise<Uint8Array> {
  const cached = await readOrCreatePinnedCache(
    directory,
    {
      fileName: SELECTED_TARGET.sha256 + ".gguf",
      bytes: SELECTED_TARGET.bytes,
      sha256: SELECTED_TARGET.sha256,
    },
    () => loadTarget(progress),
  );
  progress(
    `${cached.cacheHit ? "Reused" : "Stored"} verified pinned public checkpoint cache: ${cached.path}`,
  );
  return cached.bytes;
}
