import test from "node:test";
import assert from "node:assert/strict";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  AccountRole,
  address,
  generateKeyPairSigner,
  signTransaction,
  lamports,
} from "@solana/kit";
import { approvedTestSigner } from "./approved-test-signer";
import { transaction } from "../lib/chain/client";
import { instruction, registryAddress } from "../lib/chain/protocol";
const program = address("3qbR1eZRqXUWroWKKYhbDmR3FfqTHfqSU8zZSxtANzYh");
test("storage gate covers all tags; both approved owners retain create and full rent recovery", async () => {
  const svm = new LiteSVM().withSigverify(false);
  svm.addProgramFromFile(
    program,
    process.env.SLM_PROGRAM_BINARY || "program/target/deploy/slm_storage.so",
  );
  const outsider = await generateKeyPairSigner();
  svm.airdrop(outsider.address, lamports(100000000n));
  for (let tag = 0; tag <= 9; tag++) {
    svm.expireBlockhash();
    const ix = {
      programAddress: program,
      accounts: [
        { address: outsider.address, role: AccountRole.WRITABLE_SIGNER },
      ],
      data: Buffer.of(tag),
    };
    const tx = transaction(
      outsider.address,
      ix,
      svm.latestBlockhash(),
      100000n,
    );
    const result = svm.sendTransaction(
      await signTransaction([outsider.keyPair], tx.tx),
    );
    assert.ok(result instanceof FailedTransactionMetadata);
    assert.ok(
      result
        .meta()
        .logs()
        .some((log) => log.includes("custom program error: 0x4")),
    );
  }
  for (const index of [0, 1] as const) {
    const signer = await approvedTestSigner(index);
    svm.airdrop(signer.address, lamports(100000000n));
    const start = svm.getBalance(signer.address)!;
    const id = "12".repeat(32),
      registry = await registryAddress(program, signer.address, id);
    for (const op of ["createRegistry", "closeRegistry"] as const) {
      svm.expireBlockhash();
      const ix = instruction(program, signer.address, registry, op, {
        id,
        hash: "34".repeat(32),
        count: 1,
        bytes: 1n,
        cap: 10000000n,
      });
      const tx = transaction(
        signer.address,
        ix,
        svm.latestBlockhash(),
        100000n,
      );
      const result = svm.sendTransaction(
        await signTransaction([signer.keyPair], tx.tx),
      );
      assert.ok(
        !(result instanceof FailedTransactionMetadata),
        result instanceof FailedTransactionMetadata
          ? result.meta().logs().join("\n")
          : "",
      );
    }
    assert.equal(svm.getAccount(registry).exists, false);
    assert.equal(start - svm.getBalance(signer.address)!, 10000n);
  }
});
