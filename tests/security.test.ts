import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  protect,
  body,
  localFile,
  modelRoot,
  safeError,
} from "../lib/server/security";
const request = (headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3000/api/model", {
    method: "POST",
    headers: {
      Host: "127.0.0.1:3000",
      Origin: "http://127.0.0.1:3000",
      "X-SLM-Local": "1",
      "Content-Type": "application/json",
      ...headers,
    },
    body: "{}",
  });
test("local routes reject CSRF, missing origins/custom headers and DNS rebinding", () => {
  assert.doesNotThrow(() => protect(request()));
  const cases: Record<string, string>[] = [
    { Origin: "https://evil.example" },
    { Host: "evil.example:3000" },
    { Origin: "null" },
    { "X-SLM-Local": "" },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  for (const h of cases) assert.throws(() => protect(request(h)));
});
test("request body limits and flat artifact paths reject hostile input", async () => {
  await assert.rejects(
    body(
      new Request("http://localhost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"large":"abcdefgh"}',
      }),
      4,
    ),
  );
  assert.throws(() => localFile("/tmp", "../../secret"));
  assert.throws(() => localFile("/tmp", "x/abc"));
  assert.throws(() => localFile("/tmp", "a".repeat(64) + ".key"));
});
test("model root must be outside repository and may not be a symlink", async () => {
  const old = process.env.HF_DOWNLOAD_DIR;
  const root = await mkdtemp(join(tmpdir(), "slm-security-"));
  try {
    process.env.HF_DOWNLOAD_DIR = process.cwd();
    await assert.rejects(modelRoot());
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    process.env.HF_DOWNLOAD_DIR = join(root, "link");
    await assert.rejects(modelRoot());
    process.env.HF_DOWNLOAD_DIR = join(root, "real");
    assert.equal(await modelRoot(), join(root, "real"));
  } finally {
    if (old === undefined) delete process.env.HF_DOWNLOAD_DIR;
    else process.env.HF_DOWNLOAD_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
});
test("credential-bearing upstream errors are redacted", () => {
  const error = safeError(
    new Error("Failed https://service.example/private?credential=secret"),
  );
  assert.ok(!error.includes("secret"));
  assert.ok(!error.includes("https://"));
});
