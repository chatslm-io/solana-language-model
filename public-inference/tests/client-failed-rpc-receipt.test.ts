/** A landed LiteSVM failure is a known failed receipt, never an unknown send. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSigner,
  lamports,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransaction,
  signTransaction,
  getTransactionEncoder,
  getSignatureFromTransaction,
  type Blockhash,
} from "@solana/kit";
import { simulatedRpc } from "./fork-rpc-fixture";
test("simulated RPC retains actual failed SBF execution metadata for exact-signature recovery", async () => {
  const sim = simulatedRpc(),
    signer = await generateKeyPairSigner();
  sim.svm.airdrop(signer.address, lamports(100000000n));
  sim.setOperation("intentional-invalid-instruction");
  const lifetime = (
    await sim.rpc.rpc<{
      value: { blockhash: Blockhash; lastValidBlockHeight: number };
    }>("getLatestBlockhash")
  ).value;
  const message = appendTransactionMessageInstruction(
    { programAddress: sim.program, data: Uint8Array.of(255) },
    setTransactionMessageLifetimeUsingBlockhash(
      {
        ...lifetime,
        lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
      },
      setTransactionMessageFeePayer(
        signer.address,
        createTransactionMessage({ version: 0 }),
      ),
    ),
  );
  const tx = await signTransaction(
      [signer.keyPair],
      compileTransaction(message),
    ),
    signature = getSignatureFromTransaction(tx);
  assert.equal(
    await sim.rpc.sendExact(
      Buffer.from(getTransactionEncoder().encode(tx)).toString("base64"),
    ),
    signature,
  );
  assert.equal(await sim.rpc.status(signature), "failed");
  const statuses = await sim.rpc.rpc<{ value: { err: unknown }[] }>(
    "getSignatureStatuses",
    [[signature], { searchTransactionHistory: true }],
  );
  assert.notEqual(statuses.value[0].err, null);
  const receipt = await sim.rpc.rpc<{
    meta: { err: unknown; fee: number; computeUnitsConsumed: number };
  }>("getTransaction", [signature, { commitment: "confirmed" }]);
  assert.notEqual(receipt.meta.err, null);
  assert.equal(receipt.meta.fee, 5000);
  assert.ok(receipt.meta.computeUnitsConsumed > 0);
});
