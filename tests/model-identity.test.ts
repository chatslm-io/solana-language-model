import test from "node:test";
import { parseTargetIdentity } from "../lib/model/target";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("model identity requires protected external pins and rejects invalid or exposed configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "slm-model-identity-"));
  const path = join(root, "identity.json");
  const pins = {
    repo: "example/model",
    revision: "a".repeat(40),
    file: "model.gguf",
    sha256: "b".repeat(64),
    bytes: 1024,
  };
  const run = (file: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'import { selectedTarget } from "./lib/model/target.ts"; console.log(JSON.stringify(selectedTarget));',
      ],
      {
        encoding: "utf8",
        env: { ...process.env, SLM_MODEL_IDENTITY_FILE: file },
      },
    );
  try {
    assert.notEqual(run("").status, 0);
    writeFileSync(path, JSON.stringify(pins), { mode: 0o600 });
    assert.deepEqual(parseTargetIdentity(pins), pins);
    chmodSync(path, 0o644);
    assert.notEqual(run(path).status, 0);
    chmodSync(path, 0o600);
    const link = join(root, "link.json");
    symlinkSync(path, link);
    assert.notEqual(run(link).status, 0);
    for (const invalid of [
      { revision: "main" },
      { sha256: "bad" },
      { file: "../model.gguf" },
      { bytes: 0 },
      { repo: "https://example.invalid/model" },
    ]) {
      assert.throws(
        () => parseTargetIdentity({ ...pins, ...invalid }),
        /invalid_model_identity/,
      );
      writeFileSync(path, JSON.stringify({ ...pins, ...invalid }));
      const result = run(path);
      assert.notEqual(result.status, 0);
      assert.equal(result.stderr.includes("example.invalid"), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
