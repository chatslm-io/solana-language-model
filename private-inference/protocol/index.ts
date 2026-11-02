/** Canonical private-inference v1 public wire contracts. No secret material. */
import { createHash } from "node:crypto";
export const VERSION = 1;
export const SESSION_BYTES = 412;
export const STEP_BYTES = 80;
export const MAX_PAGES = 64;
export const MAX_PAGE_BYTES = 8192;
const sessionKeys = [
  "genesis",
  "program",
  "codeHash",
  "owner",
  "executor",
  "sessionNonce",
  "deployment",
  "storageManifest",
  "modelPlanRoot",
  "paramsRoot",
  "evalKeyRoot",
  "inputRoot",
] as const;
type Digest = string;
export type SessionBinding = Record<(typeof sessionKeys)[number], Digest> & {
  inputBound: number;
  outputBound: number;
  maxSteps: number;
  expirySlot: bigint;
};
export type Step = {
  bindingHash: Digest;
  expectedStateRoot: Digest;
  sequence: number;
  workUnits: number;
};
function hex(value: string): Buffer {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw Error("Invalid canonical 32-byte digest");
  return Buffer.from(value, "hex");
}
function uint(value: number, positive = false): number {
  if (
    !Number.isSafeInteger(value) ||
    value < (positive ? 1 : 0) ||
    value > 0xffff_ffff
  )
    throw Error("Invalid u32");
  return value;
}
function exactKeys(value: object, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== keys.length ||
    actual.some((v, i) => v !== [...keys].sort()[i])
  )
    throw Error("Noncanonical fields");
}
export function commitment(
  domain:
    | "session"
    | "page"
    | "pages"
    | "step"
    | "result"
    | "model-plan"
    | "parameters",
  bytes: Uint8Array,
): Digest {
  if (
    ![
      "session",
      "page",
      "pages",
      "step",
      "result",
      "model-plan",
      "parameters",
    ].includes(domain)
  )
    throw Error("Unknown commitment domain");
  return createHash("sha256")
    .update(`slm-private:${domain}:v1\n`, "ascii")
    .update(bytes)
    .digest("hex");
}
export function encodeSession(value: SessionBinding): Buffer {
  exactKeys(value, [
    ...sessionKeys,
    "inputBound",
    "outputBound",
    "maxSteps",
    "expirySlot",
  ]);
  if (
    typeof value.expirySlot !== "bigint" ||
    value.expirySlot < 1n ||
    value.expirySlot > 0xffff_ffff_ffff_ffffn
  )
    throw Error("Invalid expiry slot");
  const out = Buffer.alloc(SESSION_BYTES);
  out.write("SLMPIB01", 0, "ascii");
  sessionKeys.forEach((key, i) => hex(value[key]).copy(out, 8 + i * 32));
  out.writeUInt32LE(uint(value.inputBound, true), 392);
  out.writeUInt32LE(uint(value.outputBound, true), 396);
  out.writeUInt32LE(uint(value.maxSteps, true), 400);
  out.writeBigUInt64LE(value.expirySlot, 404);
  return out;
}
export function decodeSession(bytes: Uint8Array): SessionBinding {
  const b = Buffer.from(bytes);
  if (
    b.length !== SESSION_BYTES ||
    !b.subarray(0, 8).equals(Buffer.from("SLMPIB01", "ascii"))
  )
    throw Error("Invalid session wire encoding");
  const value = Object.fromEntries(
    sessionKeys.map((key, i) => [
      key,
      b.subarray(8 + i * 32, 40 + i * 32).toString("hex"),
    ]),
  ) as Record<(typeof sessionKeys)[number], Digest>;
  const result = {
    ...value,
    inputBound: b.readUInt32LE(392),
    outputBound: b.readUInt32LE(396),
    maxSteps: b.readUInt32LE(400),
    expirySlot: b.readBigUInt64LE(404),
  };
  encodeSession(result);
  return result;
}
export function sessionCommitment(value: SessionBinding): Digest {
  return commitment("session", encodeSession(value));
}
export function pageCommitment(
  index: number,
  purpose: number,
  payload: Uint8Array,
): Digest {
  if (
    uint(index) >= MAX_PAGES ||
    uint(purpose) > 3 ||
    payload.length < 1 ||
    payload.length > MAX_PAGE_BYTES
  )
    throw Error("Invalid page bounds");
  const header = Buffer.alloc(12);
  header.writeUInt32LE(index, 0);
  header.writeUInt32LE(purpose, 4);
  header.writeUInt32LE(payload.length, 8);
  return commitment("page", Buffer.concat([header, payload]));
}
export function pagesCommitment(orderedHashes: readonly Digest[]): Digest {
  if (orderedHashes.length < 1 || orderedHashes.length > MAX_PAGES)
    throw Error("Invalid page count");
  return commitment("pages", Buffer.concat(orderedHashes.map(hex)));
}
export function encodeStep(value: Step): Buffer {
  exactKeys(value, [
    "bindingHash",
    "expectedStateRoot",
    "sequence",
    "workUnits",
  ]);
  const out = Buffer.alloc(STEP_BYTES);
  out.write("SLMPIS01", 0, "ascii");
  hex(value.bindingHash).copy(out, 8);
  hex(value.expectedStateRoot).copy(out, 40);
  out.writeUInt32LE(uint(value.sequence), 72);
  out.writeUInt32LE(uint(value.workUnits, true), 76);
  return out;
}
export function decodeStep(bytes: Uint8Array): Step {
  const b = Buffer.from(bytes);
  if (
    b.length !== STEP_BYTES ||
    !b.subarray(0, 8).equals(Buffer.from("SLMPIS01", "ascii"))
  )
    throw Error("Invalid step wire encoding");
  const value = {
    bindingHash: b.subarray(8, 40).toString("hex"),
    expectedStateRoot: b.subarray(40, 72).toString("hex"),
    sequence: b.readUInt32LE(72),
    workUnits: b.readUInt32LE(76),
  };
  encodeStep(value);
  return value;
}
