import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  generateKeyPairSigner,
  getAddressDecoder,
  getTransactionEncoder,
  createTransactionMessage,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransaction,
  signTransaction,
  lamports,
} from "@solana/kit";
import { verifiedBinary } from "../build.mjs";
import { prepareSingleUseAnd } from "../../client/halfgates";

const xor = (...xs: Uint8Array[]) =>
  Buffer.from(
    Array.from({ length: 32 }, (_, i) => xs.reduce((v, x) => v ^ x[i], 0)),
  );
function hash(x: Uint8Array, ns: Uint8Array, gate: bigint, half: number) {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(gate);
  return createHash("sha256")
    .update("slm:half-gates:sha256:v1\0")
    .update(ns)
    .update(id)
    .update(Buffer.of(half))
    .update(x)
    .digest();
}
/** Independent client-side ZRE15 garbling, not model operation evaluation. */
function fresh(a: number, b: number, gate = 0n) {
  const delta = randomBytes(32);
  delta[0] |= 1;
  const a0 = randomBytes(32),
    b0 = randomBytes(32),
    ns = randomBytes(32);
  const a1 = xor(a0, delta),
    b1 = xor(b0, delta);
  const ha0 = hash(a0, ns, gate, 0),
    ha1 = hash(a1, ns, gate, 0),
    hb0 = hash(b0, ns, gate, 1),
    hb1 = hash(b1, ns, gate, 1);
  const zero = Buffer.alloc(32);
  const tg = xor(ha0, ha1, b0[0] & 1 ? delta : zero),
    te = xor(hb0, hb1, a0);
  const wg = xor(ha0, a0[0] & 1 ? tg : zero);
  const we = xor(hb0, b0[0] & 1 ? xor(te, a0) : zero);
  const c0 = xor(wg, we),
    c1 = xor(c0, delta);
  const data = Buffer.alloc(169);
  data[0] = 1;
  ns.copy(data, 1);
  data.writeBigUInt64LE(gate, 33);
  (a ? a1 : a0).copy(data, 41);
  (b ? b1 : b0).copy(data, 73);
  tg.copy(data, 105);
  te.copy(data, 137);
  return {
    data,
    decode: (out: Uint8Array) =>
      Buffer.from(out).equals(c0) ? 0 : Buffer.from(out).equals(c1) ? 1 : null,
  };
}
async function harness() {
  const binary = verifiedBinary(),
    svm = new LiteSVM();
  const program = getAddressDecoder().decode(new Uint8Array(32).fill(98));
  svm.addProgram(program, binary);
  const payer = await generateKeyPairSigner();
  svm.airdrop(payer.address, lamports(1000000000n));
  async function execute(data: Uint8Array) {
    svm.expireBlockhash();
    const tx = await signTransaction(
      [payer.keyPair],
      compileTransaction(
        appendTransactionMessageInstruction(
          { programAddress: program, data },
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: svm.latestBlockhash(),
              lastValidBlockHeight: 1000000n,
            },
            setTransactionMessageFeePayer(
              payer.address,
              setTransactionMessageConfig(
                {
                  computeUnitLimit: 200000,
                  heapSize: 32768,
                  loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
                },
                createTransactionMessage({ version: 1 }),
              ),
            ),
          ),
        ),
      ),
    );
    return {
      result: svm.sendTransaction(tx),
      bytes: getTransactionEncoder().encode(tx).length,
    };
  }
  return { execute, binary };
}

test("real SBF encrypted AND: every truth value, 64 independent single-use garblings", async (t) => {
  const h = await harness();
  let worst = 0,
    best = Number.POSITIVE_INFINITY,
    txBytes = 0;
  for (let round = 0; round < 16; round++)
    for (const a of [0, 1])
      for (const b of [0, 1]) {
        // NEVER submit multiple inputs to a garbling: that reveals the global delta.
        const f = fresh(a, b, BigInt(round));
        const { result, bytes } = await h.execute(f.data);
        if (result instanceof FailedTransactionMetadata)
          assert.fail(String(result.err()));
        assert.equal(f.decode(result.returnData().data()), a & b);
        assert.equal(result.innerInstructions().flat().length, 0);
        worst = Math.max(worst, Number(result.computeUnitsConsumed()));
        best = Math.min(best, Number(result.computeUnitsConsumed()));
        txBytes = Math.max(txBytes, bytes);
      }
  assert.equal(
    best,
    worst,
    "valid encrypted inputs must use the same fixed work",
  );
  t.diagnostic(
    JSON.stringify({
      scope: "experimental_half_gates_not_chat",
      cases: 64,
      worstCU: worst,
      bestCU: best,
      heapLimit: 32768,
      transactionBytes: txBytes,
      binaryBytes: h.binary.length,
      binarySha256: createHash("sha256").update(h.binary).digest("hex"),
    }),
  );
});

test("SBF rejects malformed encoding and bounds; changed active input cannot decode", async () => {
  const h = await harness();
  for (const bad of [
    Buffer.alloc(0),
    Buffer.alloc(169),
    Buffer.alloc(170),
    Buffer.concat([Buffer.of(2), Buffer.alloc(168)]),
  ]) {
    assert.ok(
      (await h.execute(bad)).result instanceof FailedTransactionMetadata,
    );
  }
  const invalid = fresh(0, 0, 1n << 32n);
  assert.ok(
    (await h.execute(invalid.data)).result instanceof FailedTransactionMetadata,
  );
  for (const offset of [1, 33, 41, 73]) {
    const f = fresh(1, 1);
    f.data[offset] ^= 2;
    const { result } = await h.execute(f.data);
    if (result instanceof FailedTransactionMetadata)
      assert.fail(String(result.err()));
    assert.equal(f.decode(result.returnData().data()), null);
  }
  // Inactive table rows can change without changing one evaluation; lifecycle
  // authentication of the complete garbled artifact is mandatory.
});

test("same committed input survives evaluator restart without exposing new labels", async () => {
  const f = fresh(1, 0),
    h1 = await harness(),
    h2 = await harness();
  const r1 = (await h1.execute(f.data)).result,
    r2 = (await h2.execute(f.data)).result;
  if (
    r1 instanceof FailedTransactionMetadata ||
    r2 instanceof FailedTransactionMetadata
  )
    assert.fail("SBF failed");
  assert.ok(
    Buffer.from(r1.returnData().data()).equals(
      Buffer.from(r2.returnData().data()),
    ),
    "restart ciphertext mismatch",
  );
  assert.equal(f.decode(r2.returnData().data()), 0);
});

test("independent WebCrypto client garbler decrypts compiled SBF output", async () => {
  const h = await harness();
  for (const a of [false, true])
    for (const b of [false, true]) {
      const client = await prepareSingleUseAnd(randomBytes(32), 123);
      const { result } = await h.execute(client.encode(a, b));
      if (result instanceof FailedTransactionMetadata)
        assert.fail(String(result.err()));
      assert.equal(client.decode(result.returnData().data()), a && b);
      assert.throws(() => client.encode(a, b));
      client.destroy();
    }
});
