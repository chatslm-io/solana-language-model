/** Public fixture pins only. Signing keys never enter retained ledger manifests. */
import {
  constants,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  lstatSync,
  fstatSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import {
  privateDirectory,
  readProtectedFile,
  type PrivateDirectory,
} from "../../lib/operator/external";
import { modelCommitment } from "../protocol";
import type {
  PublicModelFixture,
  PublicFixtureIdentity,
} from "./model-fixture";
const sha = (v: Uint8Array | string) =>
  createHash("sha256").update(v).digest("hex");
export type ClonePin = {
  sourceAccount: string;
  sourceOwner: string;
  sourceSlots: string[];
  sourceSha256: string;
  atomicHistoricalSnapshot: false;
};
export type ProgramPin = {
  address: Address;
  owner: Address;
  executable: boolean;
  sha256: string;
};
export type RetainedManifest = {
  version: 1;
  identity: PublicFixtureIdentity;
  genesis: string;
  program: Address;
  binarySha256: string;
  sourceSha256: string;
  modelBinding: string;
  fixtureRoot: string;
  programAccounts: ProgramPin[];
  clone: ClonePin;
};
const keys = (v: object, names: string[]) =>
  Object.keys(v).sort().join(",") === names.sort().join(",");
const digest = (s: unknown) =>
  typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
export function validateManifest(value: unknown): RetainedManifest {
  const m = value as RetainedManifest;
  if (
    !m ||
    typeof m !== "object" ||
    !keys(m, [
      "version",
      "identity",
      "genesis",
      "program",
      "binarySha256",
      "sourceSha256",
      "modelBinding",
      "fixtureRoot",
      "programAccounts",
      "clone",
    ]) ||
    m.version !== 1 ||
    !m.identity ||
    !keys(m.identity, ["modelOwner", "modelNonce"]) ||
    !digest(m.identity.modelNonce) ||
    ![m.binarySha256, m.sourceSha256, m.modelBinding, m.fixtureRoot].every(
      digest,
    ) ||
    !Array.isArray(m.programAccounts) ||
    m.programAccounts.length < 1 ||
    m.programAccounts.length > 2
  )
    throw Error("retained_manifest_schema");
  address(m.identity.modelOwner);
  address(m.genesis);
  address(m.program);
  for (const p of m.programAccounts) {
    if (
      !p ||
      !keys(p, ["address", "owner", "executable", "sha256"]) ||
      typeof p.executable !== "boolean" ||
      !digest(p.sha256)
    )
      throw Error("retained_manifest_program");
    address(p.address);
    address(p.owner);
  }
  const c = m.clone;
  if (
    !c ||
    !keys(c, [
      "sourceAccount",
      "sourceOwner",
      "sourceSlots",
      "sourceSha256",
      "atomicHistoricalSnapshot",
    ]) ||
    c.sourceAccount !== "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" ||
    c.sourceOwner !== "BPFLoader2111111111111111111111111111111111" ||
    c.atomicHistoricalSnapshot !== false ||
    !digest(c.sourceSha256) ||
    !Array.isArray(c.sourceSlots) ||
    c.sourceSlots.length !== 2 ||
    c.sourceSlots.some((v) => typeof v !== "string" || !/^\d{1,20}$/.test(v))
  )
    throw Error("retained_manifest_clone");
  return m;
}
export function fixtureCommitment(f: PublicModelFixture) {
  const h = createHash("sha256");
  for (const a of [...f.accounts].sort((a, b) =>
    a.address.localeCompare(b.address),
  ))
    h.update(a.address + "\n" + sha(a.data) + "\n" + a.lamports + "\n");
  return h.digest("hex");
}
export function openRetainedLedger(
  ledgerPath: string,
  statePath: string,
  paths: { privateDirectory: (p: string) => PrivateDirectory } = {
    privateDirectory,
  },
) {
  const directory = realpathSync(
      paths.privateDirectory(resolve(ledgerPath)),
    ) as PrivateDirectory,
    state = realpathSync(
      paths.privateDirectory(resolve(statePath)),
    ) as PrivateDirectory;
  if (
    directory === state ||
    directory.startsWith(state + sep) ||
    state.startsWith(directory + sep)
  )
    throw Error("retained_ledger_state_overlap");
  const lock = join(directory, "retained.lock"),
    manifestPath = join(directory, "fixture-manifest.json");
  let fd: number;
  try {
    fd = openSync(
      lock,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw Error(
      "retained_ledger_locked: another run or stale lock exists; verify its validator has stopped before removing retained.lock",
    );
  }
  const held = fstatSync(fd);
  try {
    writeSync(
      fd,
      JSON.stringify({ pid: process.pid, created: new Date().toISOString() }) +
        "\n",
    );
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(lock);
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      const now = lstatSync(lock);
      if (now.ino !== held.ino || now.dev !== held.dev)
        throw Error("retained_lock_identity_changed");
      unlinkSync(lock);
    } finally {
      closeSync(fd);
    }
  };
  let manifest: RetainedManifest | undefined;
  try {
    if (existsSync(manifestPath))
      manifest = validateManifest(
        JSON.parse(readProtectedFile(manifestPath).toString("utf8")),
      );
    else if (existsSync(join(directory, "ledger")))
      throw Error("retained_ledger_missing_manifest_no_reset");
    if (manifest && !existsSync(join(directory, "ledger", "genesis.bin")))
      throw Error("retained_ledger_genesis_missing");
    if (existsSync(join(directory, "ledger")))
      paths.privateDirectory(join(directory, "ledger"));
  } catch (error) {
    close();
    throw error;
  }
  return {
    directory,
    get manifest() {
      return manifest;
    },
    save(value: RetainedManifest) {
      if (manifest) throw Error("retained_manifest_already_exists");
      validateManifest(value);
      const file = openSync(
        manifestPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(file, JSON.stringify(value, null, 2) + "\n");
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      const parent = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
      manifest = value;
    },
    close,
  };
}
export function checkRetainedPins(
  f: PublicModelFixture,
  code: Uint8Array,
  m: RetainedManifest,
) {
  validateManifest(m);
  if (
    m.program !== f.program ||
    m.binarySha256 !== sha(code) ||
    m.sourceSha256 !== f.binding.sourceSha ||
    m.modelBinding !== modelCommitment(f.binding) ||
    m.fixtureRoot !== fixtureCommitment(f) ||
    m.identity.modelOwner !== f.identity.modelOwner ||
    m.identity.modelNonce !== f.identity.modelNonce
  )
    throw Error("retained_fixture_pin_mismatch");
}
type Rpc = { rpc<T>(method: string, params?: unknown[]): Promise<T> };
export async function verifyRetainedFixture(
  rpc: Rpc,
  f: PublicModelFixture,
  code: Uint8Array,
  manifest?: RetainedManifest,
  minimumSlot = 0,
) {
  if (manifest) checkRetainedPins(f, code, manifest);
  const genesis = await rpc.rpc<string>("getGenesisHash");
  address(genesis);
  if (manifest && genesis !== manifest.genesis)
    throw Error("retained_genesis_mismatch");
  type Raw = {
    owner: string;
    executable: boolean;
    data: [string, string];
    lamports: number | bigint;
  };
  if (!Number.isSafeInteger(minimumSlot) || minimumSlot < 0)
    throw Error("retained_account_context");
  let minSlot = minimumSlot;
  const read = async (keys: Address[]) => {
    const r = await rpc.rpc<{
      context: { slot: number | bigint };
      value: (Raw | null)[];
    }>("getMultipleAccounts", [
      keys,
      { encoding: "base64", commitment: "finalized", minContextSlot: minSlot },
    ]);
    const slot = Number(r?.context?.slot);
    if (
      !Number.isSafeInteger(slot) ||
      slot < minSlot ||
      !Array.isArray(r.value) ||
      r.value.length !== keys.length
    )
      throw Error("retained_account_context");
    minSlot = slot;
    return r.value.map((v) => {
      if (!v || v.data?.[1] !== "base64" || typeof v.executable !== "boolean")
        throw Error("retained_account_missing");
      return {
        ...v,
        owner: address(v.owner),
        bytes: Buffer.from(v.data[0], "base64"),
      };
    });
  };
  for (let i = 0; i < f.accounts.length; i += 64) {
    const expected = f.accounts.slice(i, i + 64),
      actual = await read(expected.map((a) => a.address));
    for (let j = 0; j < expected.length; j++)
      if (
        actual[j].owner !== f.program ||
        actual[j].executable ||
        !actual[j].bytes.equals(Buffer.from(expected[j].data)) ||
        BigInt(actual[j].lamports) !== expected[j].lamports
      )
        throw Error("retained_fixture_account_mismatch");
  }
  const [program] = await read([f.program]);
  if (!program.executable) throw Error("retained_program_not_executable");
  const pins: ProgramPin[] = [
    {
      address: f.program,
      owner: program.owner,
      executable: true,
      sha256: sha(program.bytes),
    },
  ];
  const loader = address("BPFLoaderUpgradeab1e11111111111111111111111");
  if (program.owner === loader) {
    if (program.bytes.length !== 36 || program.bytes.readUInt32LE(0) !== 2)
      throw Error("retained_program_encoding");
    const pd = getAddressDecoder().decode(program.bytes.subarray(4)),
      [expected] = await getProgramDerivedAddress({
        programAddress: loader,
        seeds: [getAddressEncoder().encode(f.program)],
      });
    if (pd !== expected) throw Error("retained_programdata_pda");
    const [data] = await read([pd]);
    if (
      data.owner !== loader ||
      data.executable ||
      data.bytes.length < 45 + code.length ||
      data.bytes.length > 45 + 2 * code.length ||
      data.bytes.readUInt32LE(0) !== 3 ||
      data.bytes[12] > 1 ||
      (data.bytes[12] === 1 &&
        !data.bytes.subarray(13, 45).every((v) => v === 0)) ||
      !data.bytes.subarray(45, 45 + code.length).equals(Buffer.from(code)) ||
      !data.bytes.subarray(45 + code.length).every((v) => v === 0)
    )
      throw Error("retained_program_elf_mismatch");
    pins.push({
      address: pd,
      owner: data.owner,
      executable: false,
      sha256: sha(data.bytes),
    });
  } else if (
    program.owner !== "BPFLoader2111111111111111111111111111111111" ||
    !program.bytes.equals(Buffer.from(code))
  )
    throw Error("retained_program_elf_mismatch");
  if (
    manifest &&
    JSON.stringify(pins) !== JSON.stringify(manifest.programAccounts)
  )
    throw Error("retained_program_pin_mismatch");
  return { genesis, programAccounts: pins };
}
