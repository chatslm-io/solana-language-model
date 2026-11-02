/** Local SBF execution harness. No RPC, disk keys, account creation, or real funds. */
import { verifiedBinary } from "../../scripts/private-linear-build-support.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
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
import {
  createPrivateLinearKey,
  privateLinearInstruction,
  decryptOutput,
  WEIGHTS,
  BIAS,
} from "./index";
export const LOCAL_PROGRAM = getAddressDecoder().decode(
  new Uint8Array(32).fill(91),
);
export const DEFAULT_BINARY = fileURLToPath(
  new URL(
    "../../private-linear-program/target/deploy/slm_private_linear.so",
    import.meta.url,
  ),
);
export async function createLocalHarness(binaryPath = DEFAULT_BINARY) {
  const binary = verifiedBinary(binaryPath);
  const binaryHash = createHash("sha256").update(binary).digest("hex");
  const svm = new LiteSVM();
  svm.addProgram(LOCAL_PROGRAM, binary);
  const payer = await generateKeyPairSigner();
  svm.airdrop(payer.address, lamports(1_000_000_000n));
  async function execute(instruction: Instruction) {
    svm.expireBlockhash();
    const message = appendTransactionMessageInstruction(
      instruction,
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n },
        setTransactionMessageFeePayer(
          payer.address,
          setTransactionMessageConfig(
            {
              computeUnitLimit: 200_000,
              loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
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
    const wireBytes = getTransactionEncoder().encode(signed).length;
    const result = svm.sendTransaction(signed);
    return { result, wireBytes };
  }
  return {
    svm,
    caller: payer.address,
    program: LOCAL_PROGRAM,
    binaryHash,
    execute,
  };
}
/** Inputs and decrypted score remain in this process; return only validation evidence. */
export async function runLocalDemo() {
  const harness = await createLocalHarness();
  const key = createPrivateLinearKey();
  const inputs = [12, -7, 3, 9];
  try {
    const request = key.encrypt(inputs);
    const { result, wireBytes } = await harness.execute(
      privateLinearInstruction(harness.program, harness.caller, request),
    );
    if (result instanceof FailedTransactionMetadata)
      throw Error("private_linear_local_execution_failed");
    const returned = result.returnData();
    const score = decryptOutput(key, returned.data(), {
      request,
      caller: harness.caller,
      program: harness.program,
      returnProgram: getAddressDecoder().decode(returned.programId()),
    });
    if (score !== inputs.reduce((sum, x, i) => sum + x * WEIGHTS[i], BIAS))
      throw Error("private_linear_local_result_mismatch");
    return {
      scope:
        "experimental encrypted linear model; not transformer/chat inference",
      execution:
        "compiled Solana SBF in local LiteSVM; no network transactions",
      matched: true,
      computeUnits: Number(result.computeUnitsConsumed()),
      transactionBytes: wireBytes,
      requestBytes: request.length,
      encryptedResultBytes: returned.data().length,
      binarySha256: harness.binaryHash,
    };
  } finally {
    key.destroy();
  }
}
