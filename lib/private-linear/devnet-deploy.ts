/**
 * Devnet-only loader adapter for the isolated private-linear experiment.
 * Existing storage deployment code/pins are untouched. Callers own explicit
 * approval, durable journals, process locking, and any retirement submission.
 */
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  address,
  getAddressDecoder,
  signature,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { verifiedBinary } from "../../scripts/private-linear-build-support.mjs";
import { account, verifyClosure, type RPC } from "../chain/client";
import {
  LOADER,
  PROGRAM_SIZE,
  PROGRAM_DATA_HEADER,
  loaderAddresses,
} from "../chain/loader";
import { sha256, u32 } from "../chain/protocol";
import {
  quoteProgram,
  reconcileProgram,
  runProgram,
} from "../operator/program-deploy";
import type { OperatorConfig } from "../operator/config";
import type { ProgramJob } from "../operator/program-types";

export const PRIVATE_LINEAR_DEPLOYMENT_PURPOSE = "private-linear-devnet-v1";
export type PrivateLinearProgramJob = ProgramJob & {
  purpose: typeof PRIVATE_LINEAR_DEPLOYMENT_PURPOSE;
};
const BINARY = fileURLToPath(
  new URL(
    "../../private-linear-program/target/deploy/slm_private_linear.so",
    import.meta.url,
  ),
);
export function privateLinearBinary(): Uint8Array {
  return Uint8Array.from(verifiedBinary(BINARY));
}
function requireDevnet(config: Pick<OperatorConfig, "cluster">) {
  if (config.cluster !== "devnet") throw Error("private_linear_devnet_only");
}
async function checkedAddresses(job: PrivateLinearProgramJob) {
  requireDevnet(job);
  if (job.purpose !== PRIVATE_LINEAR_DEPLOYMENT_PURPOSE)
    throw Error("private_linear_wrong_deployment_purpose");
  const a = await loaderAddresses(address(job.owner), job.nonce);
  if (
    a.program !== job.program ||
    a.programData !== job.programData ||
    a.buffer !== job.buffer
  )
    throw Error("private_linear_deployment_addresses_changed");
  if (
    !/^[a-f0-9]{64}$/.test(job.binaryHash) ||
    !Number.isSafeInteger(job.binaryBytes) ||
    job.binaryBytes < 1
  )
    throw Error("private_linear_invalid_binary_commitment");
  return a;
}
async function devnet(rpc: RPC) {
  if (
    (await rpc.getGenesisHash().send()) !==
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw Error("private_linear_devnet_genesis_mismatch");
}
/** Read-only live-rent/fee quote. The caller must persist and approve before run. */
export async function quotePrivateLinearDeployment(
  config: OperatorConfig,
  rpc: RPC,
  signer: KeyPairSigner,
): Promise<PrivateLinearProgramJob> {
  requireDevnet(config);
  const job = await quoteProgram(config, rpc, signer, privateLinearBinary());
  return {
    ...job,
    purpose: PRIVATE_LINEAR_DEPLOYMENT_PURPOSE,
    message:
      "Review this isolated devnet experiment. ProgramData rent is refundable; program-ID rent and network fees are not.",
  };
}
type DriverContext = Parameters<typeof runProgram>[0];
export type PrivateLinearDeploymentContext = Omit<
  DriverContext,
  "binary" | "pin" | "job"
> & {
  job: PrivateLinearProgramJob;
};
/** Reuses reviewed resumable loader lifecycle without touching storage pins. */
export async function runPrivateLinearDeployment(
  context: PrivateLinearDeploymentContext,
) {
  requireDevnet(context.config);
  await checkedAddresses(context.job);
  if (!context.job.approved)
    throw Error("private_linear_deployment_not_approved");
  if (
    BigInt(context.job.deposit) > BigInt(context.config.maxDeposit) ||
    BigInt(context.job.feeBudget) > BigInt(context.config.maxFees) ||
    BigInt(context.job.recoveryFeeBudget) > BigInt(context.config.maxFees) ||
    context.job.transactionBudget > context.config.maxTransactions
  )
    throw Error("private_linear_deployment_exceeds_caps");
  if (context.signer.address !== context.job.owner)
    throw Error("private_linear_owner_changed");
  await devnet(context.rpc);
  if (context.job.phase === "recovered") return;
  if (context.job.intent === "recover") {
    await reconcileProgram(context);
    if (await account(context.rpc, address(context.job.program))) {
      // A landed deployment is verified against its saved commitment. Recovery
      // must not depend on the local build artifact still being available.
      await verifyPrivateLinearDeployment(context.rpc, context.job);
      context.job.phase = "complete";
      context.job.intent = "deploy";
      context.job.completedTransactions = context.job.totalTransactions;
      context.job.writtenBytes = context.job.binaryBytes;
      context.job.message =
        "Landed deployment reconciled; ready for rent recovery.";
      context.save();
      return;
    }
  }
  await runProgram({
    ...context,
    binary: async () => privateLinearBinary(),
    pin: () => {},
  });
  if (context.job.phase === "complete") {
    context.job.message =
      "Isolated private-linear program verified on devnet. Existing storage program pins were not changed.";
    context.save();
  }
}
/** Verify finalized loader metadata, retained authority, binary and buffer refund. */
export async function verifyPrivateLinearDeployment(
  rpc: RPC,
  job: PrivateLinearProgramJob,
) {
  const a = await checkedAddresses(job);
  await devnet(rpc);
  const [program, data, buffer] = await Promise.all([
    account(rpc, a.program),
    account(rpc, a.programData),
    account(rpc, a.buffer),
  ]);
  if (
    !program ||
    !program.executable ||
    program.owner !== LOADER ||
    program.bytes.length !== PROGRAM_SIZE ||
    new DataView(program.bytes.buffer, program.bytes.byteOffset).getUint32(
      0,
      true,
    ) !== 2 ||
    getAddressDecoder().decode(program.bytes.subarray(4, 36)) !==
      a.programData ||
    !data ||
    data.executable ||
    data.owner !== LOADER ||
    data.bytes.length !== PROGRAM_DATA_HEADER + job.binaryBytes ||
    new DataView(data.bytes.buffer, data.bytes.byteOffset).getUint32(
      0,
      true,
    ) !== 3 ||
    data.bytes[12] !== 1 ||
    getAddressDecoder().decode(data.bytes.subarray(13, 45)) !== job.owner ||
    (await sha256(data.bytes.subarray(PROGRAM_DATA_HEADER))) !==
      job.binaryHash ||
    buffer
  )
    throw Error("private_linear_deployment_verification_failed");
  return {
    programRent: program.lamports,
    programDataLamports: data.lamports,
    deploymentSlot: new DataView(
      data.bytes.buffer,
      data.bytes.byteOffset,
    ).getBigUint64(4, true),
  };
}
/** Returns only the exact authorized-owner retirement instruction; never sends it. */
export async function preparePrivateLinearRetirement(
  rpc: RPC,
  job: PrivateLinearProgramJob,
) {
  const state = await verifyPrivateLinearDeployment(rpc, job);
  // Loader v3 cannot retire ProgramData in its deployment slot. Check finalized
  // slot, never alter block time, and let simulation enforce the same invariant.
  const currentSlot = await rpc.getSlot({ commitment: "finalized" }).send();
  if (currentSlot <= state.deploymentSlot)
    throw Error("private_linear_wait_for_later_slot");
  const owner = address(job.owner);
  const instruction: Instruction = {
    programAddress: LOADER,
    accounts: [
      { address: address(job.programData), role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY_SIGNER },
      { address: address(job.program), role: AccountRole.WRITABLE },
    ],
    data: u32(5),
  };
  return {
    instruction,
    refundableLamports: state.programDataLamports,
    programRent: state.programRent,
  };
}
/** A missing account alone is not refund proof; require successful finalized balances. */
export async function verifyPrivateLinearRetirement(
  rpc: RPC,
  job: PrivateLinearProgramJob,
  transactionSignature: string,
  minimumRefund: bigint,
) {
  const a = await checkedAddresses(job);
  await devnet(rpc);
  if (minimumRefund < 0n) throw Error("private_linear_invalid_refund");
  const reclaimedLamports = await verifyClosure(
    rpc,
    {
      authority: address(job.owner),
      operation: { account: a.programData, reclaim: minimumRefund },
    },
    signature(transactionSignature),
  );
  const [program, buffer] = await Promise.all([
    account(rpc, a.program),
    account(rpc, a.buffer),
  ]);
  // Loader-v3 leaves the program-ID account behind after ProgramData closure.
  // Its executable flag is not proof of live code: the verified ProgramData is gone.
  if (
    !program ||
    program.owner !== LOADER ||
    program.bytes.length !== PROGRAM_SIZE ||
    new DataView(program.bytes.buffer, program.bytes.byteOffset).getUint32(
      0,
      true,
    ) !== 2 ||
    getAddressDecoder().decode(program.bytes.subarray(4, 36)) !==
      a.programData ||
    buffer
  )
    throw Error("private_linear_retirement_metadata_mismatch");
  return { reclaimedLamports, retainedProgramLamports: program.lamports };
}
