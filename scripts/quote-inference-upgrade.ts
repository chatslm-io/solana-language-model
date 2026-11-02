/** Read-only upgrade preflight. Never signs, broadcasts, creates files or updates settings. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { network, operatorConfig } from "../lib/operator/config";
import { readOperatorEnv } from "../lib/operator/external";
import { localSigner } from "../lib/operator/signer";
import { rpcCall } from "../runtime/publisher";
import { verifiedBinary } from "../public-inference/harness/build.mjs";
import {
  LOADER,
  PROGRAM_CHUNK,
  BUFFER_HEADER,
  PROGRAM_DATA_HEADER,
} from "../lib/chain/loader";

export async function main(args: string[]) {
  if (args.length !== 1)
    throw Error("usage: quote-inference-upgrade.ts mainnet-beta|devnet");
  const cluster = network(args[0]);
  const settings = { ...process.env, ...readOperatorEnv() };
  const programValue = settings.SLM_INFERENCE_PROGRAM_ID;
  if (!programValue) throw Error("Set SLM_INFERENCE_PROGRAM_ID explicitly");
  const program = address(programValue);
  const binary = verifiedBinary();
  const rpc = rpcCall(operatorConfig(cluster).rpc);
  const genesis = await rpc<string>("getGenesisHash");
  const expected =
    cluster === "mainnet-beta"
      ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
      : "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  if (genesis !== expected) throw Error("wrong_network");
  const read = async (key: string) => {
    const { value } = await rpc<{
      value: null | {
        executable: boolean;
        owner: string;
        lamports: number;
        data: [string, string];
      };
    }>("getAccountInfo", [
      key,
      { encoding: "base64", commitment: "finalized" },
    ]);
    if (
      !value ||
      value.owner !== LOADER ||
      value.data[1] !== "base64" ||
      !Number.isSafeInteger(value.lamports)
    )
      throw Error("invalid_loader_account");
    return { ...value, bytes: Buffer.from(value.data[0], "base64") };
  };
  const p = await read(program);
  if (!p.executable || p.bytes.length !== 36 || p.bytes.readUInt32LE(0) !== 2)
    throw Error("not_upgradeable_loader_program");
  const programData = getAddressDecoder().decode(p.bytes.subarray(4));
  const [derived] = await getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [getAddressEncoder().encode(program)],
  });
  if (derived !== programData) throw Error("wrong_programdata");
  const d = await read(programData);
  if (
    d.executable ||
    d.bytes.length < 45 ||
    d.bytes.readUInt32LE(0) !== 3 ||
    d.bytes[12] !== 1
  )
    throw Error("program_not_upgradeable");
  const authority = getAddressDecoder().decode(d.bytes.subarray(13, 45));
  const signer = await localSigner();
  const [bufferRent, dataRent, balance] = await Promise.all([
    rpc<number>("getMinimumBalanceForRentExemption", [
      BUFFER_HEADER + binary.length,
      { commitment: "finalized" },
    ]),
    rpc<number>("getMinimumBalanceForRentExemption", [
      Math.max(d.bytes.length, PROGRAM_DATA_HEADER + binary.length),
      { commitment: "finalized" },
    ]),
    rpc<{ value: number }>("getBalance", [
      authority,
      { commitment: "finalized" },
    ]),
  ]);
  for (const n of [bufferRent, dataRent, balance.value])
    if (!Number.isSafeInteger(n) || n < 0) throw Error("invalid_rpc_amount");
  const extension = Math.max(0, dataRent - d.lamports);
  console.log(
    JSON.stringify(
      {
        cluster,
        program,
        programData,
        authority,
        operatorControlsAuthority: signer?.address === authority,
        binaryBytes: binary.length,
        binarySha256: createHash("sha256").update(binary).digest("hex"),
        existingCapacityBytes: d.bytes.length - PROGRAM_DATA_HEADER,
        additionalBytes: Math.max(
          0,
          PROGRAM_DATA_HEADER + binary.length - d.bytes.length,
        ),
        authorityBalanceLamports: String(balance.value),
        temporaryBufferRentLamports: String(bufferRent),
        additionalProgramRentLamports: String(extension),
        rentFundingBeforeFeesLamports: String(bufferRent + extension),
        estimatedBufferWrites: Math.ceil(binary.length / PROGRAM_CHUNK),
        note: "Read-only rent quote, not spending approval. Add current transaction fees and retry allowance at deployment. Verify upgraded bytes and buffer closure/refund afterward.",
      },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      "Upgrade quote unavailable: check protected configuration, authority, pinned binary and RPC. No transactions were sent.",
    );
    process.exitCode = 1;
  });
}
