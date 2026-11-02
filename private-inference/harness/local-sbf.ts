/** Fast compiled-SBF lifecycle tests only. No RPC and no signer export. */
import { verifiedBinary } from "./build.mjs";
import { LiteSVM } from "litesvm";
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
  type KeyPairSigner,
} from "@solana/kit";
export const TEST_PROGRAM = getAddressDecoder().decode(
  new Uint8Array(32).fill(182),
);
export async function createLifecycleHarness(
  flavor:
    "mock" | "experimental" | "production" | "circuit" | "stream" = "mock",
) {
  let svm = new LiteSVM();
  svm.addProgram(TEST_PROGRAM, verifiedBinary(flavor));
  const owner = await generateKeyPairSigner();
  const other = await generateKeyPairSigner();
  svm.airdrop(owner.address, lamports(10_000_000_000n));
  svm.airdrop(other.address, lamports(10_000_000_000n));
  async function execute(ix: Instruction, signer: KeyPairSigner = owner) {
    svm.expireBlockhash();
    const message = appendTransactionMessageInstruction(
      ix,
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1000000n },
        setTransactionMessageFeePayer(
          signer.address,
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
    const tx = await signTransaction(
      [signer.keyPair],
      compileTransaction(message),
    );
    const wireBytes = getTransactionEncoder().encode(tx).length;
    if (wireBytes > 1232) throw Error("transaction_too_large");
    return { result: svm.sendTransaction(tx), wireBytes };
  }
  return {
    get svm() {
      return svm;
    },
    restart() {
      svm = LiteSVM.fromBytes(svm.toBytes());
    },
    owner,
    other,
    program: TEST_PROGRAM,
    execute,
  };
}
