import { resolve } from "node:path";
import { privateRead } from "../operator/external";

type TargetIdentity = Readonly<{
  repo: string;
  revision: string;
  file: string;
  sha256: string;
  bytes: number;
}>;

export function parseTargetIdentity(input: unknown): TargetIdentity {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("invalid_model_identity");
  const value = input as Record<string, unknown>;
  if (
    typeof value.repo !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(
      value.repo,
    ) ||
    value.repo.includes("..") ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.revision) ||
    typeof value.file !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}\.gguf$/.test(value.file) ||
    value.file.includes("..") ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 64 * 1024 * 1024
  )
    throw Error("invalid_model_identity");
  return Object.freeze({
    repo: value.repo,
    revision: value.revision,
    file: value.file,
    sha256: value.sha256,
    bytes: value.bytes,
  });
}

let cached: TargetIdentity | undefined;
function identity(): TargetIdentity {
  if (cached) return cached;
  try {
    const path = process.env.SLM_MODEL_IDENTITY_FILE;
    if (!path) throw Error();
    const value = JSON.parse(privateRead(resolve(path)).toString("utf8"));
    cached = parseTargetIdentity(value);
    return cached;
  } catch {
    throw Error(
      "Configure SLM_MODEL_IDENTITY_FILE with a protected external JSON file containing repo, revision, file, sha256 and bytes",
    );
  }
}

// Resolve only when model-dependent work starts; never during module loading.
export const selectedTarget: TargetIdentity = Object.freeze({
  get repo() {
    return identity().repo;
  },
  get revision() {
    return identity().revision;
  },
  get file() {
    return identity().file;
  },
  get sha256() {
    return identity().sha256;
  },
  get bytes() {
    return identity().bytes;
  },
});
