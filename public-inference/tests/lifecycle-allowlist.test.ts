import test from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  address,
  generateKeyPairSigner,
  lamports,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { createLifecycleHarness } from "../harness/local-sbf";
import { executionInstruction, EXECUTION_TAGS } from "../execution-mode";
import { inferenceMemoData } from "../../runtime/publisher";

test("both approved signers can publish; outsiders cannot call any tag, envelope, or memo", async () => {
  const h = await createLifecycleHarness();
  const outsider = await generateKeyPairSigner();
  h.svm.airdrop(outsider.address, lamports(10000000n));
  const memo = (publisher: typeof h.owner.address) => ({
    programAddress: h.program,
    accounts: [
      { address: publisher, role: AccountRole.READONLY_SIGNER },
      {
        address: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        role: AccountRole.READONLY,
      },
    ],
    data: inferenceMemoData("ab".repeat(32)),
  });
  for (const signer of [h.owner, h.other]) {
    for (const ix of [memo(signer.address)]) {
      const { result } = await h.execute(ix, signer);
      assert.ok(!(result instanceof FailedTransactionMetadata));
    }
  }
  const calls = EXECUTION_TAGS.map((tag) =>
    executionInstruction(
      {
        programAddress: h.program,
        accounts: [
          { address: outsider.address, role: AccountRole.WRITABLE_SIGNER },
        ],
        data: Buffer.of(tag),
      },
      0,
    ),
  );
  const probes = [
    ...Array.from({ length: 27 }, (_, tag) => ({
      programAddress: h.program,
      accounts: [
        { address: outsider.address, role: AccountRole.WRITABLE_SIGNER },
      ],
      data: Buffer.of(tag),
    })),
    ...calls,
    memo(outsider.address),
    ...calls.map((ix) => {
      const data = Buffer.from(ix.data!);
      data[6] = 1;
      data.fill(0, 24, 64);
      return { ...ix, data };
    }),
  ];
  for (const ix of probes) {
    const { result } = await h.execute(ix, outsider);
    assert.ok(result instanceof FailedTransactionMetadata);
    assert.ok(
      result
        .meta()
        .logs()
        .some((log) => log.includes("custom program error: 0x4")),
    );
  }
  const unsigned = {
    ...memo(h.owner.address),
    accounts: [
      { address: h.owner.address, role: AccountRole.READONLY },
      memo(h.owner.address).accounts[1],
    ],
  };
  const { result } = await h.execute(unsigned, outsider);
  assert.ok(result instanceof FailedTransactionMetadata);
});
