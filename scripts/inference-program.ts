/** Deploy only the reviewed public-inference binary; no storage program pins are changed. */
import { parseEnv } from "node:util";
import { configuredPath } from "../lib/config/environment.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeFileSync,
  renameSync,
  constants,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { address, getAddressDecoder } from "@solana/kit";
import { OperatorEngine } from "../lib/operator/engine";
import { FileJobStore } from "../lib/operator/store";
import { privateDirectory, readProtectedFile } from "../lib/operator/external";
import { localSigner } from "../lib/operator/signer";
import { operatorConfig, network } from "../lib/operator/config";
import { operatorRpc } from "../lib/operator/rpc";
import { account, chainCheck } from "../lib/chain/client";
import { LOADER } from "../lib/chain/loader";
import { verifiedBinary } from "../public-inference/harness/build.mjs";

class DeploymentError extends Error {}

export function setProgramSetting(text: string, program: string) {
  address(program);
  const lines = text.split(/\r?\n/);
  const matches = lines
    .map((line, i) =>
      /^\s*(?:export\s+)?SLM_INFERENCE_PROGRAM_ID\s*=/.test(line) ? i : -1,
    )
    .filter((i) => i >= 0);
  if (matches.length > 1)
    throw new DeploymentError("Duplicate receipt program settings");
  const line = `SLM_INFERENCE_PROGRAM_ID=${program}`;
  if (matches.length) lines[matches[0]] = line;
  else lines.push(line);
  const result = lines.join("\n").replace(/\n*$/, "\n");
  const before = parseEnv(text),
    after = parseEnv(result);
  if (
    after.SLM_INFERENCE_PROGRAM_ID !== program ||
    Object.keys({ ...before, ...after }).some(
      (key) => key !== "SLM_INFERENCE_PROGRAM_ID" && before[key] !== after[key],
    )
  )
    throw new DeploymentError(
      "Environment update would alter unrelated settings",
    );
  return result;
}
function updateEnvironment(path: string, program: string) {
  const bytes = readProtectedFile(path, 1024 * 1024);
  const value = setProgramSetting(bytes.toString("utf8"), program);
  bytes.fill(0);
  const temporary = path + ".inference-program.new";
  const fd = openSync(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
export async function main(args: string[]) {
  const [action, clusterValue, approval] = args;
  if (
    !["quote", "deploy", "recover-buffer", "configure"].includes(action) ||
    args.length > 3
  )
    throw new DeploymentError(
      "Usage: npx tsx scripts/inference-program.ts quote|deploy|recover-buffer|configure mainnet-beta|devnet [quote-id]",
    );
  const cluster = network(clusterValue);
  const root = privateDirectory(configuredPath("SLM_DEPLOYMENT_DIR"));
  const store = new FileJobStore(root);
  const signer = await localSigner();
  if (!signer) throw new DeploymentError("Missing external operator signer");
  const config = { ...operatorConfig(cluster), program: null };
  const rpc = operatorRpc(config);
  const unavailable = async (): Promise<never> => {
    throw new DeploymentError(
      "Model operations are unavailable in this deployment command",
    );
  };
  const engine = new OperatorEngine({
    store,
    signer: async () => signer,
    config: () => config,
    rpc: () => rpc,
    binary: async () => verifiedBinary(),
    models: { prepare: unavailable, manifest: unavailable, shard: unavailable },
  });
  if (action === "quote") {
    const quote = await engine.prepareProgram(cluster);
    const balance = (
      await rpc.getBalance(signer.address, { commitment: "finalized" }).send()
    ).value;
    console.log(
      JSON.stringify(
        {
          network: cluster,
          quoteId: quote.id,
          payer: quote.owner,
          program: quote.program,
          buffer: quote.buffer,
          programData: quote.programData,
          binaryBytes: quote.binaryBytes,
          binaryHash: quote.binaryHash,
          depositLamports: quote.deposit,
          codeRentLamports: quote.codeRent,
          programRentLamports: quote.programRent,
          feeCapLamports: quote.feeBudget,
          recoveryFeeCapLamports: quote.recoveryFeeBudget,
          transactions: quote.totalTransactions,
          balanceLamports: String(balance),
        },
        null,
        2,
      ),
    );
    console.log(
      `After reviewing the quote: npx tsx scripts/inference-program.ts deploy ${cluster} ${quote.id}`,
    );
    return;
  }
  const job = store.programJobs.at(-1);
  if (!job || job.cluster !== cluster || job.owner !== signer.address)
    throw new DeploymentError(
      "Deployment network or owner does not match saved state",
    );
  if (action === "configure") {
    if (cluster !== "mainnet-beta")
      throw new DeploymentError(
        "Production env configuration requires mainnet-beta",
      );
    const release = store.lock();
    try {
      store.load();
      const job = store.programJobs.at(-1);
      if (!job || job.cluster !== cluster || job.owner !== signer.address)
        throw new DeploymentError("Deployment state changed");
      if (job.phase !== "complete" || store.programs[cluster] !== job.program)
        throw new DeploymentError("Deployment is not verified complete");
      await chainCheck(rpc, { ...config, program: LOADER });
      const [program, data, buffer] = await Promise.all([
        account(rpc, address(job.program)),
        account(rpc, address(job.programData)),
        account(rpc, address(job.buffer)),
      ]);
      if (
        !program?.executable ||
        program.owner !== LOADER ||
        program.bytes.length !== 36
      )
        throw new DeploymentError("Program verification failed");
      if (
        !program ||
        new DataView(program.bytes.buffer, program.bytes.byteOffset).getUint32(
          0,
          true,
        ) !== 2 ||
        getAddressDecoder().decode(program.bytes.subarray(4)) !==
          job.programData ||
        !data ||
        data.owner !== LOADER ||
        data.bytes.length !== 45 + job.binaryBytes ||
        new DataView(data.bytes.buffer, data.bytes.byteOffset).getUint32(
          0,
          true,
        ) !== 3 ||
        data.bytes[12] !== 1 ||
        getAddressDecoder().decode(data.bytes.subarray(13, 45)) !==
          signer.address ||
        buffer ||
        createHash("sha256").update(data.bytes.subarray(45)).digest("hex") !==
          job.binaryHash ||
        createHash("sha256").update(verifiedBinary()).digest("hex") !==
          job.binaryHash
      )
        throw new DeploymentError("Program verification failed");
      const target = configuredPath("SLM_DEPLOYMENT_ENV_FILE");
      updateEnvironment(target, job.program);
      console.log(
        "Configured SLM_INFERENCE_PROGRAM_ID in the explicitly selected deployment environment file.",
      );
      return;
    } finally {
      release();
    }
  }
  if (approval !== job.id)
    throw new DeploymentError(
      "Supply the exact reviewed quote ID to authorize this operation",
    );
  if (
    action === "deploy" &&
    !job.approved &&
    Date.now() - job.quotedAt > 600000
  )
    throw new DeploymentError(
      "Quote expired; run quote again before deployment",
    );
  const stop = () => engine.pause(job.id);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const start = Date.now();
  const progress = setInterval(() => {
    const job = store.programJobs.at(-1)!;
    console.log(
      `[Inference program] ${job.phase}; ${job.completedTransactions}/${job.totalTransactions} transactions; ${job.writtenBytes}/${job.binaryBytes} bytes; elapsed ${Math.round((Date.now() - start) / 1000)}s`,
    );
  }, 5000);
  try {
    await engine.startProgram(job.id, cluster, action === "recover-buffer");
    await engine.wait();
    const finished = store.programJobs.at(-1)!;
    if (!["complete", "recovered"].includes(finished.phase))
      throw new DeploymentError(
        "Deployment paused or failed; retain the journal and resume the same quote ID",
      );
    console.log(
      JSON.stringify({
        phase: finished.phase,
        program: finished.program,
        binaryHash: finished.binaryHash,
        feesReservedLamports: finished.feesReserved,
      }),
    );
  } finally {
    clearInterval(progress);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof DeploymentError) console.error(error.message);
    console.error(
      "Inference-program operation incomplete. Check the selected network, protected configuration, balance and saved deployment state. Preserve the journal; never reset it to retry. Private diagnostics withheld.",
    );
    process.exitCode = 1;
  });
}
