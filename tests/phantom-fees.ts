import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

// Model the documented sign-only behavior, not the extension itself:
// https://docs.phantom.com/developer-powertools/solana-priority-fees
// An unsigned transaction without explicit fee instructions is modified before
// signing. Use web3's builder independently of the production Kit builder.
export function applyPhantomPriorityFees(wire: Uint8Array): Uint8Array {
  const tx = VersionedTransaction.deserialize(wire);
  const message = TransactionMessage.decompile(tx.message);
  if (
    tx.signatures.some((s) => s.some(Boolean)) ||
    message.instructions.some((ix) =>
      ix.programId.equals(ComputeBudgetProgram.programId),
    )
  )
    return wire;
  message.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000n }),
  );
  return new VersionedTransaction(message.compileToV0Message()).serialize();
}
