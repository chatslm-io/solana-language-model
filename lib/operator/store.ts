import {
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  existsSync,
  constants,
} from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { readProtectedFile, type PrivateDirectory } from "./external";
import type { Job, RpcSettings } from "./types";
import { rpcPolicy } from "@/lib/chain/rpc-policy";
import { address } from "@solana/kit";
import type { ProgramJob, ProgramPins } from "./program-types";
export interface JobStore {
  rpcSettings: RpcSettings;
  programJobs: ProgramJob[];
  programs: ProgramPins;
  load(): Job[];
  save(jobs: Job[]): void;
  lock(): () => void;
}
export class FileJobStore implements JobStore {
  rpcSettings: RpcSettings = {};
  programJobs: ProgramJob[] = [];
  programs: ProgramPins = {};
  private root: string;
  constructor(root: PrivateDirectory) {
    this.root = root;
  }
  load(): Job[] {
    const path = resolve(this.root, "operations.json");
    if (!existsSync(path)) {
      this.rpcSettings = {};
      this.programJobs = [];
      this.programs = {};
      return [];
    }
    const data = JSON.parse(
      readProtectedFile(path, 32 * 1024 * 1024).toString(),
    );
    if (data.version !== 1 || !Array.isArray(data.jobs))
      throw new Error("Invalid operator journal; preserve it before recovery");
    this.rpcSettings = {};
    this.programJobs = data.programJobs || [];
    if (!Array.isArray(this.programJobs))
      throw new Error("Invalid program deployment journal");
    this.programs = {};
    for (const [cluster, value] of Object.entries(data.programs || {})) {
      if (cluster !== "devnet" && cluster !== "mainnet-beta")
        throw new Error("Invalid program network");
      this.programs[cluster] = address(String(value));
    }
    for (const [cluster, value] of Object.entries(data.rpcSettings || {})) {
      if (cluster !== "devnet" && cluster !== "mainnet-beta")
        throw new Error("Invalid RPC settings network");
      this.rpcSettings[cluster] = rpcPolicy(value);
    }
    return data.jobs;
  }
  save(jobs: Job[]) {
    const temporary = resolve(
      this.root,
      `${randomBytes(16).toString("hex")}.tmp`,
    );
    const fd = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          version: 1,
          jobs,
          rpcSettings: this.rpcSettings,
          programJobs: this.programJobs,
          programs: this.programs,
        }),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, resolve(this.root, "operations.json"));
    const dir = openSync(this.root, constants.O_RDONLY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  lock() {
    // Serialize stale-lock cleanup as well as creation. Otherwise two processes
    // could both remove the same stale lock and accidentally remove a new one.
    const guard = resolve(this.root, "acquiring.lock");
    let guardFd: number;
    try {
      guardFd = openSync(
        guard,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new Error(
        "Another process is acquiring the operator lock. If a crash left acquiring.lock, stop all operator processes before removing that guard.",
      );
    }
    try {
      writeFileSync(guardFd, String(process.pid));
      fsyncSync(guardFd);
      return this.acquireMainLock();
    } finally {
      closeSync(guardFd);
      unlinkSync(guard);
    }
  }
  private acquireMainLock() {
    const path = resolve(this.root, "operator.lock");
    if (existsSync(path)) {
      const owner = Number(readProtectedFile(path, 64).toString());
      if (!Number.isSafeInteger(owner) || owner < 1)
        throw new Error(
          "Invalid operator lock; inspect the external state directory",
        );
      let alive = true;
      try {
        process.kill(owner, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("Another local operator process is active");
      unlinkSync(path);
    }
    const fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, String(process.pid));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return () => unlinkSync(path);
  }
}
