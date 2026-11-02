import { approvedTestSigner } from "../../tests/approved-test-signer";
/** Fast compiled-SBF lifecycle tests only. No RPC and no signer export. */
import { verifiedBinary } from "./build.mjs";
import { LiteSVM } from "litesvm";
import {
  getAddressDecoder,
  getTransactionEncoder,
  createTransactionMessage,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  signTransaction,
  lamports,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
export const TEST_PROGRAM = getAddressDecoder().decode(
  new Uint8Array(32).fill(183),
);
export async function createLifecycleHarness() {
  let svm = new LiteSVM().withSigverify(false);
  svm.addProgram(TEST_PROGRAM, verifiedBinary());
  const owner = await approvedTestSigner();
  const other = await approvedTestSigner(1);
  svm.airdrop(owner.address, lamports(100_000_000_000n));
  svm.airdrop(other.address, lamports(100_000_000_000n));
  async function execute(
    ix: Instruction | readonly Instruction[],
    signer: KeyPairSigner = owner,
    computeUnitLimit: 200000 | 1200000 = 200000,
  ) {
    const instructions: readonly Instruction[] = Array.isArray(ix)
      ? ix
      : [ix as Instruction];
    if (
      ![200000, 1200000].includes(computeUnitLimit) ||
      (computeUnitLimit === 1200000 &&
        (instructions.length !== 1 || instructions[0].data?.[0] !== 26))
    )
      throw Error("public_test_compute_budget");
    svm.expireBlockhash();
    const message = appendTransactionMessageInstructions(
      instructions,
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1000000n },
        setTransactionMessageFeePayer(
          signer.address,
          setTransactionMessageConfig(
            {
              computeUnitLimit,
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
