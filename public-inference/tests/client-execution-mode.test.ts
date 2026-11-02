import test from "node:test";
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import {
  decodeExecution,
  executionInstruction,
  isExecutionEnvelope,
  INSTRUCTIONS_SYSVAR,
} from "../execution-mode";
const programAddress = address("BPFLoaderUpgradeab1e11111111111111111111111");
test("mode 0 preserves legacy payloads and wire size, appends the sysvar and reserves result fields", () => {
  for (const [tag, length] of [
    [7, 153],
    [8, 13],
    [9, 1],
    [10, 41],
    [11, 1],
    [12, 5],
    [13, 1],
    [21, 129],
    [22, 6],
    [23, 1],
    [24, 37],
    [25, 1],
    [26, 45],
  ]) {
    const data = Buffer.alloc(length);
    data[0] = tag;
    const original = { programAddress, data, accounts: [] };
    const ix = executionInstruction(original, 0);
    assert.equal(ix.accounts![0].address, INSTRUCTIONS_SYSVAR);
    assert.equal(ix.data!.length, length + 63);
    const decoded = decodeExecution(Uint8Array.from(ix.data!));
    assert.equal(decoded.mode, 0);
    assert.deepEqual(decoded.legacy, data);
    assert.ok(isExecutionEnvelope(Uint8Array.from(ix.data!)));
    assert.ok(decoded.result.every((v) => v === 0));
    assert.throws(() => executionInstruction(ix, 0), /already_wrapped/);
  }
});
test("legacy create nonces beginning with magic remain wrappable and malformed modes are rejected", () => {
  for (const [tag, length] of [
    [7, 153],
    [21, 129],
  ]) {
    const data = Buffer.alloc(length);
    data[0] = tag;
    data.write("SLMM", 1);
    assert.equal(isExecutionEnvelope(data), false);
    const ix = executionInstruction({ programAddress, data }, 0);
    assert.deepEqual(decodeExecution(Uint8Array.from(ix.data!)).legacy, data);
  }
  const ix = executionInstruction({ programAddress, data: Buffer.of(9) }, 0);
  for (const [offset, value] of [
    [5, 2],
    [6, 2],
    [7, 1],
    [24, 1],
  ]) {
    const data = Buffer.from(ix.data!);
    data[offset] = value;
    assert.throws(() => decodeExecution(data), /invalid_execution/);
  }
});

test("all other mode bytes are reserved and cannot be encoded or decoded", () => {
  const ix = executionInstruction({ programAddress, data: Buffer.of(9) });
  for (let mode = 1; mode <= 255; mode++) {
    assert.throws(
      () => executionInstruction({ programAddress, data: Buffer.of(9) }, mode),
      /invalid_execution/,
    );
    const data = Buffer.from(ix.data!);
    data[6] = mode;
    assert.throws(() => decodeExecution(data), /invalid_execution/);
  }
  for (const mode of [-1, 256, 0.5, NaN])
    assert.throws(
      () => executionInstruction({ programAddress, data: Buffer.of(9) }, mode),
      /invalid_execution/,
    );
});
