/** Stable 64-byte envelope: mode 0 executes onchain; all other values are reserved. */
import { randomBytes } from "node:crypto";
import { AccountRole, address, type Instruction } from "@solana/kit";
export const INSTRUCTIONS_SYSVAR = address(
  "Sysvar1nstructions1111111111111111111111111",
);
export const MODE_MAGIC = Buffer.from("SLMM");
export const MODE_HEADER = 64;
export const EXECUTION_TAGS = [
  7, 8, 9, 10, 11, 12, 13, 21, 22, 23, 24, 25, 26,
] as const;
export function isExecutionTag(tag: number) {
  return (EXECUTION_TAGS as readonly number[]).includes(tag);
}
export function isExecutionEnvelope(data: Uint8Array) {
  return (
    data.length >= 5 &&
    isExecutionTag(data[0]) &&
    !(
      (data[0] === 7 && data.length === 153) ||
      (data[0] === 21 && data.length === 129)
    ) &&
    Buffer.from(data).subarray(1, 5).equals(MODE_MAGIC)
  );
}
export function decodeExecution(data: Uint8Array) {
  const b = Buffer.from(data);
  if (
    b.length < MODE_HEADER ||
    !isExecutionTag(b[0]) ||
    !b.subarray(1, 5).equals(MODE_MAGIC) ||
    b[5] !== 1 ||
    b[6] !== 0 ||
    b[7] !== 0
  )
    throw Error("invalid_execution_envelope");
  if (b.subarray(24, 64).some((v) => v !== 0))
    throw Error("invalid_execution_result");
  return {
    mode: b[6] as 0,
    nonce: b.subarray(8, 24),
    result: b.subarray(24, 64),
    legacy: Buffer.concat([b.subarray(0, 1), b.subarray(64)]),
  };
}
export function executionInstruction(
  ix: Instruction,
  mode: number = 0,
): Instruction {
  const legacy = Buffer.from(ix.data ?? []);
  if (!isExecutionTag(legacy[0]) || mode !== 0)
    throw Error("invalid_execution_instruction");
  if (isExecutionEnvelope(legacy)) throw Error("already_wrapped");
  const header = Buffer.alloc(MODE_HEADER);
  header[0] = legacy[0];
  MODE_MAGIC.copy(header, 1);
  header[5] = 1;
  header[6] = mode;
  randomBytes(16).copy(header, 8);
  return {
    ...ix,
    data: Buffer.concat([header, legacy.subarray(1)]),
    accounts: [
      ...(ix.accounts ?? []),
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
    ],
  };
}
