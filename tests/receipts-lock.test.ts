import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { acquireRuntimeLock, runtimeIdentity } from "../runtime/lock";
import type { PrivateDirectory } from "../lib/operator/external";
function fixture() {
  const directory = mkdtempSync(
    join(tmpdir(), "slm-lock-test-"),
  ) as PrivateDirectory;
  return {
    directory,
    path: join(directory, "runtime.lock"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test(
  "runtime identity prevents live takeover but recovers a reused PID; close respects replacement ownership",
  { skip: process.platform !== "linux" },
  () => {
    const f = fixture();
    try {
      const identity = runtimeIdentity();
      writeFileSync(f.path, JSON.stringify(identity), { mode: 0o600 });
      assert.throws(
        () => acquireRuntimeLock(f.directory),
        /runtime_already_running/,
      );
      writeFileSync(f.path, JSON.stringify({ ...identity, startTime: "0" }));
      const release = acquireRuntimeLock(f.directory);
      const current = JSON.parse(readFileSync(f.path, "utf8"));
      assert.equal(current.pid, process.pid);
      assert.equal(current.startTime, identity.startTime);
      assert.throws(
        () => acquireRuntimeLock(f.directory),
        /runtime_already_running/,
      );
      writeFileSync(
        f.path,
        JSON.stringify({ ...current, lockId: "replacement" }),
      );
      release();
      assert.equal(existsSync(f.path), true);
    } finally {
      f.cleanup();
    }
  },
);
test(
  "changed boot or PID namespace and legacy container identities require explicit recovery",
  { skip: process.platform !== "linux" },
  () => {
    const f = fixture();
    try {
      const identity = runtimeIdentity();
      assert.equal(identity.podId, null);
      for (const changed of [
        { pidNamespace: "pid:[1]" },
        { bootId: "00000000-0000-0000-0000-000000000000" },
        { podId: "legacy-container" },
      ]) {
        writeFileSync(f.path, JSON.stringify({ ...identity, ...changed }), {
          mode: 0o600,
        });
        assert.throws(
          () => acquireRuntimeLock(f.directory),
          /runtime_lock_namespace_mismatch/,
        );
        assert.equal(existsSync(f.path), true);
      }
    } finally {
      f.cleanup();
    }
  },
);
test("legacy live PIDs and leftover reclamation guards fail closed", () => {
  const f = fixture();
  try {
    writeFileSync(f.path, String(process.pid), { mode: 0o600 });
    assert.throws(
      () => acquireRuntimeLock(f.directory),
      /runtime_already_running/,
    );
    writeFileSync(f.path, "2147483647");
    const release = acquireRuntimeLock(f.directory);
    release();
    writeFileSync(
      join(f.directory, "runtime.lock.reclaim"),
      "interrupted-reclamation",
      { mode: 0o600 },
    );
    assert.throws(
      () => acquireRuntimeLock(f.directory),
      /runtime_lock_recovery_required/,
    );
    assert.equal(existsSync(join(f.directory, "runtime.lock.reclaim")), true);
  } finally {
    f.cleanup();
  }
});
test(
  "concurrent stale-lock contenders cannot unlink a newly acquired live lock",
  { skip: process.platform !== "linux" },
  async () => {
    const f = fixture();
    const children: ReturnType<typeof spawn>[] = [];
    try {
      writeFileSync(
        f.path,
        JSON.stringify({ ...runtimeIdentity(), startTime: "0" }),
        { mode: 0o600 },
      );
      const moduleURL = pathToFileURL(resolve("runtime/lock.ts")).href;
      const code = `import {acquireRuntimeLock} from ${JSON.stringify(moduleURL)};import {once} from 'node:events';process.stdout.write('ready\\n');await once(process.stdin,'data');let unlock;try{unlock=acquireRuntimeLock(process.argv[1]);process.stdout.write('acquired\\n');}catch{process.stdout.write('blocked\\n');}await once(process.stdin,'data');unlock?.();process.stdin.destroy();`;
      const readers = [];
      for (let i = 0; i < 4; i++) {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", code, f.directory],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        children.push(child);
        readers.push(createInterface({ input: child.stdout! }));
      }
      await Promise.all(readers.map((reader) => once(reader, "line")));
      const results = readers.map((reader) => once(reader, "line"));
      for (const child of children) child.stdin!.write("go\n");
      const statuses = await Promise.all(results);
      assert.equal(statuses.filter(([line]) => line === "acquired").length, 1);
      const exited = children.map((child) => once(child, "exit"));
      for (const child of children) child.stdin!.write("stop\n");
      await Promise.all(exited);
      for (const reader of readers) reader.close();
      assert.equal(existsSync(f.path), false);
    } finally {
      for (const child of children) child.kill("SIGKILL");
      f.cleanup();
    }
  },
);
