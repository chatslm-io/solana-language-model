import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  readProtectedFile,
  type PrivateDirectory,
} from "../lib/operator/external";
export type RuntimeIdentity = {
  version: 1;
  pid: number;
  startTime: string;
  bootId: string;
  pidNamespace: string;
  podId: string | null;
};
/** Kernel process identity; no credential or signing material is included. */
export function runtimeIdentity(pid = process.pid): RuntimeIdentity {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(") ");
  const startTime = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/)[19];
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const pidNamespace = readlinkSync(`/proc/${pid}/ns/pid`);
  const podId = null;
  if (
    end < 0 ||
    !/^\d+$/.test(startTime || "") ||
    !/^[a-f0-9-]{36}$/.test(bootId) ||
    !/^pid:\[\d+\]$/.test(pidNamespace)
  )
    throw Error("runtime_lock_identity_unavailable");
  return { version: 1, pid, startTime, bootId, pidNamespace, podId };
}
function valid(record: RuntimeIdentity) {
  return (
    record &&
    record.version === 1 &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.startTime === "string" &&
    /^\d+$/.test(record.startTime) &&
    typeof record.bootId === "string" &&
    /^[a-f0-9-]{36}$/.test(record.bootId) &&
    typeof record.pidNamespace === "string" &&
    /^pid:\[\d+\]$/.test(record.pidNamespace) &&
    (record.podId === null ||
      (typeof record.podId === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(record.podId)))
  );
}
function dead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw Error("runtime_lock_identity_unavailable");
  }
}
function stale(text: string, ours: RuntimeIdentity | null) {
  // Old numeric locks cannot prove that a live PID has been reused.
  if (/^[1-9]\d*$/.test(text)) {
    const pid = Number(text);
    if (!Number.isSafeInteger(pid)) throw Error("runtime_lock_invalid");
    return dead(pid);
  }
  let record: RuntimeIdentity;
  try {
    record = JSON.parse(text);
  } catch {
    throw Error("runtime_lock_invalid");
  }
  if (!valid(record) || !ours) throw Error("runtime_lock_invalid");
  if (record.podId !== ours.podId)
    throw Error("runtime_lock_namespace_mismatch");
  if (
    record.bootId !== ours.bootId ||
    record.pidNamespace !== ours.pidNamespace
  ) {
    // Cross-namespace locks require explicit recovery.
    throw Error("runtime_lock_namespace_mismatch");
  }
  if (dead(record.pid)) return true;
  let current: RuntimeIdentity;
  try {
    current = runtimeIdentity(record.pid);
  } catch {
    throw Error("runtime_lock_identity_unavailable");
  }
  return current.startTime !== record.startTime;
}
/** A crash while holding the reclamation guard deliberately requires operator recovery. */
export function acquireRuntimeLock(directory: PrivateDirectory): () => void {
  const path = join(directory, "runtime.lock"),
    guard = join(directory, "runtime.lock.reclaim");
  const identity = process.platform === "linux" ? runtimeIdentity() : null;
  const text = identity
    ? JSON.stringify({ ...identity, lockId: randomBytes(16).toString("hex") })
    : String(process.pid);
  let guardFd: number;
  try {
    guardFd = openSync(guard, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw Error("runtime_lock_recovery_required");
    throw error;
  }
  try {
    writeFileSync(guardFd, text);
    fsyncSync(guardFd);
    if (existsSync(path)) {
      const previous = readProtectedFile(path, 4096).toString("utf8").trim();
      if (!stale(previous, identity)) throw Error("runtime_already_running");
      unlinkSync(path);
    }
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(guardFd);
    unlinkSync(guard);
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      if (readProtectedFile(path, 4096).toString("utf8") === text)
        unlinkSync(path);
    } catch {
      /* Never remove another owner's or an unreadable lock. */
    }
  };
}
