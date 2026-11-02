import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  AccountRole,
} from "@solana/kit";

export const HEADER = 192;
export const SHARD_BYTES = 8192;
export const CHUNK_BYTES = 768;
export const SYSTEM = address("11111111111111111111111111111111");
export const utf8 = new TextEncoder();
export const hex = (b: Uint8Array) =>
  Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
export function unhex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(s))
    throw new Error("Invalid hexadecimal value");
  return Uint8Array.from(s.match(/../g)!, (n) => parseInt(n, 16));
}
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
export const u32 = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)
    throw new Error("Invalid u32");
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
export const u64 = (n: bigint) => {
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error("Invalid u64");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
export const sha256 = async (b: Uint8Array) =>
  hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(b))),
  );
export const base64 = (b: Uint8Array) => {
  let s = "";
  for (const n of b) s += String.fromCharCode(n);
  return btoa(s);
};
export const fromBase64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const sol = (n: bigint) =>
  `${n < 0n ? "-" : ""}${(n < 0n ? -n : n) / 1000000000n}.${((n < 0n ? -n : n) % 1000000000n).toString().padStart(9, "0")}`;
export function parseSol(s: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(s))
    throw new Error("Use a nonnegative SOL amount with up to 9 decimals");
  const [a, b = ""] = s.split(".");
  return BigInt(a) * 1000000000n + BigInt(b.padEnd(9, "0"));
}
export async function registryAddress(
  program: Address,
  authority: Address,
  id: string,
) {
  if (id.length !== 64) throw new Error("Deployment ID must be 32 bytes");
  return (
    await getProgramDerivedAddress({
      programAddress: program,
      seeds: [
        utf8.encode("slm-reg-v1"),
        getAddressEncoder().encode(authority),
        unhex(id),
      ],
    })
  )[0];
}
export async function shardAddress(
  program: Address,
  authority: Address,
  id: string,
  index: number,
) {
  return (
    await getProgramDerivedAddress({
      programAddress: program,
      seeds: [
        utf8.encode("slm-shard-v1"),
        getAddressEncoder().encode(authority),
        unhex(id),
        u32(index),
      ],
    })
  )[0];
}
export async function sessionAddress(
  program: Address,
  owner: Address,
  id: string,
) {
  if (id.length !== 64) throw new Error("Deployment ID must be 32 bytes");
  return (
    await getProgramDerivedAddress({
      programAddress: program,
      seeds: [
        utf8.encode("slm-session-v1"),
        getAddressEncoder().encode(owner),
        unhex(id),
      ],
    })
  )[0];
}
const meta = (a: Address, role: AccountRole) => ({ address: a, role });
export function instruction(
  program: Address,
  authority: Address,
  registry: Address,
  operation:
    | "createRegistry"
    | "createShard"
    | "write"
    | "finalize"
    | "closeShard"
    | "closeRegistry"
    | "closeSession"
    | "seal",
  args: {
    id?: string;
    hash?: string;
    count?: number;
    bytes?: bigint;
    cap?: bigint;
    index?: number;
    length?: number;
    shard?: Address;
    offset?: number;
    chunk?: Uint8Array;
    recipient?: Address;
  } = {},
): Instruction {
  const { WRITABLE: W, WRITABLE_SIGNER: S, READONLY: R } = AccountRole;
  let data: Uint8Array;
  const accounts = [meta(authority, S), meta(registry, W)];
  switch (operation) {
    case "createRegistry":
      data = concat(
        new Uint8Array([0]),
        unhex(args.id!),
        unhex(args.hash!),
        u32(args.count!),
        u64(args.bytes!),
        u64(args.cap!),
      );
      accounts.push(meta(SYSTEM, R));
      break;
    case "createShard":
      data = concat(
        new Uint8Array([1]),
        u32(args.index!),
        u32(args.length!),
        unhex(args.hash!),
        u64(args.cap!),
      );
      accounts.push(meta(args.shard!, W), meta(SYSTEM, R));
      break;
    case "write":
      data = concat(new Uint8Array([2]), u32(args.offset!), args.chunk!);
      accounts[1] = meta(registry, R);
      accounts.push(meta(args.shard!, W));
      break;
    case "finalize":
      data = new Uint8Array([3]);
      accounts.push(meta(args.shard!, W));
      break;
    case "closeShard":
      data = concat(new Uint8Array([4]), u32(args.index!));
      accounts.push(meta(args.shard!, W), meta(args.recipient ?? authority, W));
      break;
    case "closeRegistry":
    case "closeSession":
      data = concat(
        new Uint8Array([operation === "closeSession" ? 8 : 5]),
        unhex(args.id!),
      );
      accounts.push(meta(args.recipient ?? authority, W));
      break;
    case "seal":
      data = new Uint8Array([6]);
      break;
  }
  return { programAddress: program, accounts, data };
}
export type Header = {
  kind: 1 | 2 | 3;
  state: number;
  authority: Address;
  id: string;
  hash: string;
  count: number;
  live: number;
  finalized: number;
  bytes: bigint;
  allocatedBytes: bigint;
  index: number;
  length: number;
  written: number;
  registry?: Address;
  session?: {
    delegate: Address;
    expires: bigint;
    budget: bigint;
    spent: bigint;
    operations: number;
    maxOperations: number;
  };
};
export function decodeHeader(b: Uint8Array): Header {
  if (
    b.length < HEADER ||
    new TextDecoder().decode(b.subarray(0, 8)) !== "SLMSTOR1" ||
    b[8] !== 1 ||
    ![1, 2, 3].includes(b[9]) ||
    b[10] > 2
  )
    throw new Error("Unsupported storage header");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    kind: b[9] as 1 | 2 | 3,
    state: b[10],
    authority: bytesAddress(b.subarray(16, 48)),
    id: hex(b.subarray(48, 80)),
    hash: hex(
      b.subarray(
        b[9] === 1 ? 80 : b[9] === 3 ? 144 : 128,
        b[9] === 1 ? 112 : b[9] === 3 ? 176 : 160,
      ),
    ),
    count: v.getUint32(b[9] === 3 ? 176 : 112, true),
    live: v.getUint32(116, true),
    finalized: v.getUint32(120, true),
    bytes: v.getBigUint64(b[9] === 3 ? 180 : 128, true),
    allocatedBytes: v.getBigUint64(136, true),
    index: v.getUint32(112, true),
    length: v.getUint32(116, true),
    written: v.getUint32(120, true),
    registry: b[9] === 2 ? bytesAddress(b.subarray(80, 112)) : undefined,
    session:
      b[9] === 3
        ? {
            delegate: bytesAddress(b.subarray(80, 112)),
            expires: v.getBigUint64(112, true),
            budget: v.getBigUint64(120, true),
            spent: v.getBigUint64(128, true),
            operations: v.getUint32(136, true),
            maxOperations: v.getUint32(140, true),
          }
        : undefined,
  };
}
import { getAddressDecoder } from "@solana/kit";
const bytesAddress = (b: Uint8Array) => getAddressDecoder().decode(b);

export function openSessionInstruction(
  program: Address,
  owner: Address,
  registry: Address,
  session: Address,
  delegate: Address,
  args: {
    id: string;
    hash: string;
    count: number;
    bytes: bigint;
    budget: bigint;
    fees: bigint;
    expires: bigint;
    maxOperations: number;
    cap: bigint;
  },
): Instruction {
  return {
    programAddress: program,
    accounts: [
      meta(owner, AccountRole.WRITABLE_SIGNER),
      meta(registry, AccountRole.WRITABLE),
      meta(session, AccountRole.WRITABLE),
      meta(delegate, AccountRole.WRITABLE),
      meta(SYSTEM, AccountRole.READONLY),
    ],
    data: concat(
      new Uint8Array([7]),
      unhex(args.id),
      unhex(args.hash),
      u32(args.count),
      u64(args.bytes),
      u64(args.budget),
      u64(args.fees),
      u64(args.expires),
      u32(args.maxOperations),
      u64(args.cap),
    ),
  };
}
export function delegateInstruction(
  ix: Instruction,
  delegate: Address,
  session: Address,
): Instruction {
  if (!ix.data || ![1, 2, 3, 6].includes(ix.data[0]) || !ix.accounts?.length)
    throw new Error("Delegate is restricted to upload operations");
  return {
    ...ix,
    accounts: [
      meta(delegate, AccountRole.READONLY_SIGNER),
      meta(session, AccountRole.WRITABLE),
      { ...ix.accounts[0], role: AccountRole.READONLY },
      ...ix.accounts.slice(1),
    ],
    data: concat(new Uint8Array([9]), Uint8Array.from(ix.data)),
  };
}
