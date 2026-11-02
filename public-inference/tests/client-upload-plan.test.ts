import test from "node:test";
import assert from "node:assert/strict";
import { AccountRole, getAddressDecoder, type Instruction } from "@solana/kit";
import { groupRecoveryInstructions } from "../harness/upload-model";
import { instructionWireBytes } from "../harness/fork-model";
const key = (n: number) =>
    getAddressDecoder().decode(new Uint8Array(32).fill(n)),
  payer = key(1),
  program = key(2),
  registry = key(3);
const close = (n: number): Instruction => ({
  programAddress: program,
  accounts: [
    { address: payer, role: AccountRole.WRITABLE_SIGNER },
    { address: registry, role: AccountRole.WRITABLE },
    { address: key(n + 4), role: AccountRole.WRITABLE },
  ],
  data: Uint8Array.of(5),
});
test("upload recovery groups preserve child-before-registry order within bounded wire limits", () => {
  const instructions = [
      ...Array.from({ length: 20 }, (_, i) => close(i)),
      {
        programAddress: program,
        accounts: [
          { address: payer, role: AccountRole.WRITABLE_SIGNER },
          { address: registry, role: AccountRole.WRITABLE },
        ],
        data: Uint8Array.of(6),
      },
    ],
    groups = groupRecoveryInstructions(instructions, payer);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.flat(), instructions);
  for (const group of groups) {
    assert.ok(group.length <= 7);
    assert.ok(instructionWireBytes(group, payer, 200000) <= 1232);
  }
  assert.equal(groups.at(-1)!.at(-1)!.data![0], 6);
});
test("upload recovery refuses arbitrary operations and an oversized single close", () => {
  assert.throws(
    () =>
      groupRecoveryInstructions(
        [{ ...close(0), data: Uint8Array.of(3) }],
        payer,
      ),
    /recovery_instruction/,
  );
  const oversized = {
    ...close(0),
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      ...Array.from({ length: 50 }, (_, i) => ({
        address: key(i + 4),
        role: AccountRole.WRITABLE,
      })),
    ],
  };
  assert.throws(
    () => groupRecoveryInstructions([oversized], payer),
    /wire_limit/,
  );
});
