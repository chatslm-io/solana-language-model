import {
  address,
  getBase58Decoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  verifySignature,
} from "@solana/kit";
import type { RpcCall } from "../../runtime/publisher";
import { OUTPUT_BYTES, parseRequest, verifyOutput } from "./index";
export type { RpcCall } from "../../runtime/publisher";

export type ExpectedPrivateLinearExecution = {
  program: string;
  caller: string;
  request: Uint8Array;
  genesisHash: string;
  maxFeeLamports?: bigint;
};
export type FinalizedPrivateLinearEvidence = {
  output: Uint8Array;
  slot: number;
  fee: bigint;
};
function invalid(): never {
  throw Error("private_linear_invalid_finalized_evidence");
}
function base64(value: unknown, maximum: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    invalid();
  const bytes = Buffer.from(value, "base64");
  if (
    !bytes.length ||
    bytes.length > maximum ||
    bytes.toString("base64") !== value
  )
    invalid();
  return bytes;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
/**
 * Read-only verification against a trusted RPC's finalized ledger view. This is
 * not a light-client finality proof. Only the reviewed v1, single-instruction
 * shape is supported; compute budgets belong to v1 message configuration.
 * No signing, submission, decryption, or plaintext logging occurs here.
 */
export async function verifyFinalizedPrivateLinear(
  rpc: RpcCall,
  signature: string,
  expected: ExpectedPrivateLinearExecution,
): Promise<FinalizedPrivateLinearEvidence> {
  const caller = address(expected.caller),
    program = address(expected.program);
  const genesisHash = address(expected.genesisHash);
  const maxFeeLamports = expected.maxFeeLamports;
  if (
    program === caller ||
    (maxFeeLamports !== undefined &&
      (typeof maxFeeLamports !== "bigint" || maxFeeLamports < 0n))
  )
    throw Error("private_linear_invalid_expected_execution");
  const request = Uint8Array.from(expected.request);
  parseRequest(request);
  try {
    const decoded = getBase58Encoder().encode(signature);
    if (
      decoded.length !== 64 ||
      getBase58Decoder().decode(decoded) !== signature
    )
      invalid();
  } catch {
    invalid();
  }
  if ((await rpc<string>("getGenesisHash")) !== genesisHash)
    throw Error("private_linear_wrong_network");
  const value = await rpc<unknown>("getTransaction", [
    signature,
    {
      encoding: "base64",
      commitment: "finalized",
      maxSupportedTransactionVersion: 1,
    },
  ]);
  if (value === null) throw Error("private_linear_not_finalized");
  let evidence: FinalizedPrivateLinearEvidence;
  try {
    const tx = record(value),
      meta = record(tx.meta);
    if (
      tx.version !== 1 ||
      !Number.isSafeInteger(tx.slot) ||
      (tx.slot as number) < 0 ||
      meta.err !== null ||
      !Number.isSafeInteger(meta.fee) ||
      (meta.fee as number) < 0
    )
      invalid();
    if (
      !Array.isArray(tx.transaction) ||
      tx.transaction.length !== 2 ||
      tx.transaction[1] !== "base64"
    )
      invalid();
    if (
      !Array.isArray(meta.innerInstructions) ||
      meta.innerInstructions.some((entry) => {
        const item = record(entry);
        return (
          !Array.isArray(item.instructions) || item.instructions.length !== 0
        );
      })
    )
      invalid();
    if (meta.loadedAddresses !== undefined && meta.loadedAddresses !== null) {
      const loaded = record(meta.loadedAddresses);
      if (
        !Array.isArray(loaded.readonly) ||
        loaded.readonly.length ||
        !Array.isArray(loaded.writable) ||
        loaded.writable.length
      )
        invalid();
    }
    const wire = base64(tx.transaction[0], 4096);
    const signed = getTransactionDecoder().decode(wire);
    if (!Buffer.from(getTransactionEncoder().encode(signed)).equals(wire))
      invalid();
    const message = getCompiledTransactionMessageDecoder().decode(
      signed.messageBytes,
    );
    if (
      message.version !== 1 ||
      message.numStaticAccounts !== 2 ||
      message.staticAccounts.length !== 2 ||
      message.staticAccounts[0] !== caller ||
      message.staticAccounts[1] !== program ||
      message.header.numSignerAccounts !== 1 ||
      message.header.numReadonlySignerAccounts !== 0 ||
      message.header.numReadonlyNonSignerAccounts !== 1 ||
      message.numInstructions !== 1 ||
      message.instructionHeaders.length !== 1 ||
      message.instructionPayloads.length !== 1 ||
      Object.keys(signed.signatures).length !== 1
    )
      invalid();
    const header = message.instructionHeaders[0],
      payload = message.instructionPayloads[0];
    if (
      header.programAccountIndex !== 1 ||
      header.numInstructionAccounts !== 1 ||
      header.numInstructionDataBytes !== request.length ||
      payload.instructionAccountIndices.length !== 1 ||
      payload.instructionAccountIndices[0] !== 0 ||
      !Buffer.from(payload.instructionData).equals(Buffer.from(request))
    )
      invalid();
    const signedBytes = signed.signatures[caller];
    if (
      !signedBytes ||
      getBase58Decoder().decode(signedBytes) !== signature ||
      !(await verifySignature(
        await getPublicKeyFromAddress(caller),
        signedBytes,
        signed.messageBytes,
      ))
    )
      invalid();
    const returned = record(meta.returnData);
    if (
      returned.programId !== program ||
      !Array.isArray(returned.data) ||
      returned.data.length !== 2 ||
      returned.data[1] !== "base64"
    )
      invalid();
    const output = base64(returned.data[0], OUTPUT_BYTES);
    verifyOutput(output, { request, caller, program, returnProgram: program });
    const fee = BigInt(meta.fee as number);
    if (maxFeeLamports !== undefined && fee > maxFeeLamports)
      throw Error("private_linear_finalized_fee_exceeded");
    evidence = {
      output: Uint8Array.from(output),
      slot: tx.slot as number,
      fee,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "private_linear_finalized_fee_exceeded"
    )
      throw error;
    invalid();
  }
  if ((await rpc<string>("getGenesisHash")) !== genesisHash)
    throw Error("private_linear_wrong_network");
  return evidence;
}
