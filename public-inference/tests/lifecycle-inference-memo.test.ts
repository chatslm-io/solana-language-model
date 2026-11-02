import test from "node:test";
import assert from "node:assert/strict";
import { AccountRole, address, type Instruction } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { createLifecycleHarness } from "../harness/local-sbf";
import { MEMO, inferenceMemoData } from "../../runtime/publisher";

test("compiled inferenceMemo invokes Memo with the publisher signer and exact commitment", async () => {
  const h = await createLifecycleHarness();
  const hash = "ab".repeat(32);
  const ix: Instruction = {
    programAddress: h.program,
    accounts: [
      { address: h.owner.address, role: AccountRole.READONLY_SIGNER },
      { address: address(MEMO), role: AccountRole.READONLY },
    ],
    data: inferenceMemoData(hash),
  };
  const before = h.svm.getBalance(h.owner.address);
  const { result } = await h.execute(ix);
  assert.ok(
    !(result instanceof FailedTransactionMetadata),
    result instanceof FailedTransactionMetadata
      ? result.meta().logs().join("\n")
      : "",
  );
  const logs = result.logs().join("\n");
  assert.ok(logs.includes(`Program ${MEMO} invoke [2]`));
  assert.ok(logs.includes(`slm:receipt:v1:${hash}`));
  assert.ok(logs.includes(h.owner.address));
  console.log(`inferenceMemo compute units: ${result.computeUnitsConsumed()}`);
  assert.equal(before! - h.svm.getBalance(h.owner.address)!, 5000n);
  for (const bad of [
    { ...ix, data: inferenceMemoData(hash).subarray(0, 39) },
    { ...ix, data: Buffer.concat([inferenceMemoData(hash), Buffer.of(0)]) },
    {
      ...ix,
      accounts: [
        ix.accounts![0],
        { address: h.other.address, role: AccountRole.READONLY },
      ],
    },
    {
      ...ix,
      accounts: [
        { address: h.other.address, role: AccountRole.READONLY },
        ix.accounts![1],
      ],
    },
    {
      ...ix,
      accounts: [
        ...ix.accounts!,
        { address: h.other.address, role: AccountRole.READONLY },
      ],
    },
    {
      ...ix,
      accounts: [
        ix.accounts![0],
        { address: address(MEMO), role: AccountRole.WRITABLE },
      ],
    },
  ]) {
    const out = await h.execute(bad);
    assert.ok(
      out.result instanceof FailedTransactionMetadata,
      "invalid memo invocation succeeded",
    );
  }
});
