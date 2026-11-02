import test from "node:test";
import assert from "node:assert/strict";
import { FailedTransactionMetadata } from "litesvm";
import {
  AccountRole,
  lamports,
  getAddressDecoder,
  getAddressEncoder,
  type Instruction,
} from "@solana/kit";
import { ristretto255 } from "@noble/curves/ed25519";
import { createLocalHarness } from "../lib/private-linear/local";
import {
  createPrivateLinearKey,
  privateLinearInstruction,
  decryptOutput,
  BIAS,
  WEIGHTS,
  OUTPUT_BYTES,
} from "../lib/private-linear/index";
const P = ristretto255.Point;
test("compiled SBF evaluates encrypted positive, negative and boundary inputs with no model accounts", async () => {
  const h = await createLocalHarness();
  for (const inputs of [
    [0, 0, 0, 0],
    [1, 2, 3, 4],
    [-12, 7, -3, -9],
    [255, -255, 255, 255],
    [-255, 255, -255, -255],
  ]) {
    const key = createPrivateLinearKey();
    try {
      const request = key.encrypt(inputs);
      const before = h.svm.getBalance(h.caller);
      const { result, wireBytes } = await h.execute(
        privateLinearInstruction(h.program, h.caller, request),
      );
      if (result instanceof FailedTransactionMetadata)
        assert.fail(result.err().toString());
      assert.ok(
        result.computeUnitsConsumed() > 0n &&
          result.computeUnitsConsumed() <= 200_000n,
      );
      assert.ok(wireBytes <= 1232);
      const returned = result.returnData();
      assert.equal(returned.data().length, OUTPUT_BYTES);
      assert.equal(getAddressDecoder().decode(returned.programId()), h.program);
      const score = decryptOutput(key, returned.data(), {
        request,
        caller: h.caller,
        program: h.program,
        returnProgram: h.program,
      });
      assert.equal(
        score,
        inputs.reduce((sum, x, i) => sum + x * WEIGHTS[i], BIAS),
      );
      // No rent deposit, allocation or transfer: only the local test transaction fee.
      assert.equal(before! - h.svm.getBalance(h.caller)!, 5000n);
      assert.equal(result.innerInstructions().flat().length, 0);
      assert.ok(
        result.logs().every((line) => !line.startsWith("Program log:")),
      );
    } finally {
      key.destroy();
    }
  }
});
test("compiled SBF rejects malformed inputs, points, duplicate randomness and missing authority", async () => {
  const h = await createLocalHarness(),
    key = createPrivateLinearKey();
  try {
    const valid = key.encrypt([4, 3, 2, 1]);
    const raw = (
      data: Uint8Array,
      accounts: Instruction["accounts"] = [
        { address: h.caller, role: AccountRole.READONLY_SIGNER },
      ],
    ): Instruction => ({ programAddress: h.program, accounts, data });
    const attacks: Instruction[] = [
      raw(valid.subarray(1)),
      raw(Buffer.concat([valid, Buffer.from([0])])),
      raw(valid, []),
    ];
    for (const [offset, byte] of [
      [0, 0],
      [8, 0],
      [72, 0],
      [104, 255],
    ] as const) {
      const data = Uint8Array.from(valid);
      if (offset === 0) data[0] = byte;
      else data.fill(byte, offset, offset + 32);
      attacks.push(raw(data));
    }
    const duplicate = Uint8Array.from(valid);
    duplicate.set(valid.subarray(72, 104), 136);
    attacks.push(raw(duplicate));
    const other = getAddressDecoder().decode(new Uint8Array(32).fill(92));
    h.svm.airdrop(other, lamports(1_000_000n));
    attacks.push(raw(valid, [{ address: other, role: AccountRole.READONLY }]));
    attacks.push(
      raw(valid, [
        { address: h.caller, role: AccountRole.READONLY_SIGNER },
        { address: other, role: AccountRole.READONLY },
      ]),
    );
    // Distinct nonzero input blindings whose weighted sum is zero. No decryption key involved.
    const canceled = Uint8Array.from(valid);
    const scalars = [1n, 2n, 3n, P.Fn.ORDER - 14n];
    for (let i = 0; i < 4; i++)
      canceled.set(P.BASE.multiply(scalars[i]).toBytes(), 72 + i * 64);
    attacks.push(raw(canceled));
    for (const attack of attacks) {
      const { result } = await h.execute(attack);
      assert.ok(
        result instanceof FailedTransactionMetadata,
        "malformed execution unexpectedly succeeded",
      );
      assert.equal(result.meta().returnData().data().length, 0);
    }
  } finally {
    key.destroy();
  }
});
test("local result is bound to the requesting signer and exact ciphertext request", async () => {
  const h = await createLocalHarness(),
    key = createPrivateLinearKey();
  try {
    const request = key.encrypt([10, 11, 12, 13]);
    const { result } = await h.execute(
      privateLinearInstruction(h.program, h.caller, request),
    );
    if (result instanceof FailedTransactionMetadata)
      assert.fail(result.err().toString());
    const output = result.returnData().data();
    const binding = {
      request,
      caller: h.caller,
      program: h.program,
      returnProgram: h.program,
    };
    assert.throws(
      () =>
        decryptOutput(key, output, {
          ...binding,
          request: key.encrypt([10, 11, 12, 13]),
        }),
      /request_mismatch/,
    );
    const other = getAddressDecoder().decode(new Uint8Array(32).fill(93));
    assert.throws(
      () => decryptOutput(key, output, { ...binding, caller: other }),
      /request_mismatch/,
    );
    assert.throws(
      () => decryptOutput(key, output, { ...binding, returnProgram: other }),
      /wrong_return_program/,
    );
    assert.equal(getAddressEncoder().encode(h.caller).length, 32);
  } finally {
    key.destroy();
  }
});
