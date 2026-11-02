/** Public arithmetic only; no encryption or production inference claims. */
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
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
  type Instruction,
} from "@solana/kit";
import { verifiedBinary, binaryDigest } from "./build-support.mjs";
export const MODULUS = 1_062_862_849;
export function schoolbook(a: number[], b: number[]) {
  assert.equal(a.length, b.length);
  const n = a.length;
  const result = Array<bigint>(n).fill(0n);
  const p = BigInt(MODULUS);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const product = BigInt(a[i]) * BigInt(b[j]);
      result[(i + j) % n] += i + j < n ? product : -product;
    }
  const out = Buffer.alloc(4 * n);
  result.forEach((x, i) => out.writeUInt32LE(Number(((x % p) + p) % p), 4 * i));
  return out;
}
export async function harness() {
  const binary = verifiedBinary(
    fileURLToPath(
      new URL("./target/deploy/slm_fhe_ntt_bench.so", import.meta.url),
    ),
  );
  const program = getAddressDecoder().decode(new Uint8Array(32).fill(97));
  const svm = new LiteSVM();
  svm.addProgram(program, binary);
  const payer = await generateKeyPairSigner();
  svm.airdrop(payer.address, lamports(1_000_000_000n));
  async function execute(
    data: Uint8Array,
    accounts: Instruction["accounts"] = [],
  ) {
    svm.expireBlockhash();
    const message = appendTransactionMessageInstruction(
      { programAddress: program, accounts, data },
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n },
        setTransactionMessageFeePayer(
          payer.address,
          setTransactionMessageConfig(
            {
              computeUnitLimit: 1_400_000,
              loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
              heapSize: 262144,
            },
            createTransactionMessage({ version: 1 }),
          ),
        ),
      ),
    );
    const signed = await signTransaction(
      [payer.keyPair],
      compileTransaction(message),
    );
    return {
      result: svm.sendTransaction(signed),
      wireBytes: getTransactionEncoder().encode(signed).length,
    };
  }
  return {
    execute,
    program,
    binaryBytes: binary.length,
    binarySha256: binaryDigest(binary),
  };
}
export function explicitRequest(a: number[], b: number[]) {
  assert.equal(a.length, b.length);
  const out = Buffer.alloc(3 + 8 * a.length);
  out.writeUInt16LE(a.length, 1);
  [...a, ...b].forEach((x, i) => out.writeUInt32LE(x, 3 + 4 * i));
  return out;
}
export async function benchmark() {
  const h = await harness();
  const measurements = [];
  for (const n of [32, 64, 128, 256, 512, 1024, 2048, 4096]) {
    const seed = 23,
      request = Buffer.alloc(7);
    request[0] = 1;
    request.writeUInt16LE(n, 1);
    request.writeUInt32LE(seed, 3);
    const { result, wireBytes } = await h.execute(request);
    if (result instanceof FailedTransactionMetadata) {
      measurements.push({
        degree: n,
        success: false,
        computeUnits: Number(result.meta().computeUnitsConsumed()),
        error: String(result.err()),
        logs: result.meta().logs(),
      });
      continue;
    }
    const values = Array.from(
      { length: 2 * n },
      (_, i) => (seed + 17 * i) % 251,
    );
    const reference = schoolbook(values.slice(0, n), values.slice(n));
    assert.deepEqual(
      Buffer.from(result.returnData().data()).subarray(0, 32),
      createHash("sha256").update(reference).digest(),
    );
    measurements.push({
      degree: n,
      success: true,
      matched: true,
      computeUnits: Number(result.computeUnitsConsumed()),
      wireBytes,
      stageRemainingComputeUnits: result
        .logs()
        .filter((x) => x.includes("units remaining")),
    });
  }
  return {
    scope:
      "public polynomial arithmetic only; not encryption or transformer inference",
    backend: "tfhe-ntt 0.7.1 scalar SBF",
    heapBytes: 262144,
    computeLimit: 1_400_000,
    binaryBytes: h.binaryBytes,
    binarySha256: h.binarySha256,
    measurements,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  benchmark().then(
    (x) => process.stdout.write(JSON.stringify(x, null, 2) + "\n"),
    (e) => {
      process.stderr.write(String(e) + "\n");
      process.exitCode = 1;
    },
  );
