import { address } from "@solana/kit";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configuredPath, requiredSetting } from "../lib/config/environment.mjs";
import { localSigner } from "../lib/operator/signer";
import { readOperatorEnv, privateDirectory } from "../lib/operator/external";
import { MainnetInferenceRpc } from "../public-inference/client/mainnet-rpc";
import { modelUploadOperations } from "../public-inference/client/model-upload-plan";
import { prepareModelFixture } from "../public-inference/harness/model-fixture";
import { instructionWireBytes } from "../public-inference/harness/fork-model";
import { verifyUploadedAccounts } from "../public-inference/harness/upload-model";
import { UploadTransactionSender } from "../public-inference/harness/upload-transactions";
import { SubmissionJournal } from "../private-inference/coordinator/transactions";
import { createProgress } from "../public-inference/harness/progress";

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length && !["--quote", "--execute"].includes(args[0]))
  )
    throw Error("Use --quote or --execute");
  const execute = args[0] === "--execute";
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...readOperatorEnv() }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (requiredSetting("SOLANA_CLUSTER", env) !== "mainnet-beta")
    throw Error("mainnet_cluster_required");
  const signer = await localSigner(() => ({ ...env }));
  if (!signer) throw Error("mainnet_signer_required");
  const owner = address(requiredSetting("SLM_MODEL_OWNER", env));
  if (owner !== signer.address)
    throw Error("model_owner_must_match_upload_signer");
  const program = address(requiredSetting("SLM_INFERENCE_PROGRAM_ID", env));
  const rpc = new MainnetInferenceRpc(
    requiredSetting("SOLANA_RPC_URL", env),
    program,
  );
  await rpc.beforeSigning();
  const progress = createProgress("mainnet model upload");
  const f = await prepareModelFixture(
    undefined,
    (message) => progress.log(message),
    {
      modelOwner: owner,
      modelNonce: requiredSetting("SLM_MODEL_NONCE", env),
    },
    signer,
    program,
  );
  const existing = await rpc.rpc<{ value: unknown }>("getAccountInfo", [
    f.client.model,
    { encoding: "base64", commitment: "finalized" },
  ]);
  if (existing.value !== null)
    throw Error("model_already_exists_preserve_prior_upload_journal");
  const rents = new Map<number, bigint>();
  for (const account of f.accounts) {
    if (!rents.has(account.data.length)) {
      const value = await rpc.rpc<number>("getMinimumBalanceForRentExemption", [
        account.data.length,
        { commitment: "finalized" },
      ]);
      if (!Number.isSafeInteger(value) || value < 0)
        throw Error("invalid_rent_quote");
      rents.set(account.data.length, BigInt(value));
    }
    account.lamports = rents.get(account.data.length)!;
  }
  const rentByAddress = new Map(f.accounts.map((a) => [a.address, a.lamports]));
  const operations = await modelUploadOperations(f, (key) => {
    const rent = rentByAddress.get(key);
    if (rent === undefined) throw Error("upload_account_missing");
    return rent;
  });
  for (const operation of operations)
    if (
      instructionWireBytes(operation.instruction, signer.address, 200000) > 1232
    )
      throw Error("upload_wire_limit");
  const rentTotal = operations.reduce((sum, op) => sum + op.rent, 0n);
  const feeAllowance = BigInt(operations.length) * 10000n;
  const cleanupReserve = BigInt(f.accounts.length) * 10000n;
  const required = rentTotal + feeAllowance + cleanupReserve;
  const quote = {
    cluster: "mainnet-beta",
    payer: signer.address,
    program,
    model: f.client.model,
    modelOwner: owner,
    modelNonce: f.identity.modelNonce,
    transactions: operations.length,
    rentLamports: String(rentTotal),
    feeAllowanceLamports: String(feeAllowance),
    cleanupReserveLamports: String(cleanupReserve),
    requiredLamports: String(required),
  };
  console.log(JSON.stringify(quote));
  if (!execute) return;
  const cap = requiredSetting("SLM_UPLOAD_MAX_LAMPORTS", env);
  if (!/^[1-9][0-9]{0,18}$/.test(cap) || BigInt(cap) < required)
    throw Error("upload_budget_exceeded");
  const balance = await rpc.rpc<{ value: number }>("getBalance", [
    owner,
    { commitment: "finalized" },
  ]);
  if (!Number.isSafeInteger(balance.value) || BigInt(balance.value) < required)
    throw Error("upload_insufficient_balance");
  const root = privateDirectory(configuredPath("SLM_UPLOAD_STATE_DIR", env));
  const state = join(root, randomUUID());
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, "upload.json"), JSON.stringify(quote) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  progress.log(`Upload journal: ${state}`);
  const sender = new UploadTransactionSender({
    rpc,
    signer,
    progress,
    confirmation: { confirmation: "confirmed" },
  });
  for (let at = 0; at < operations.length; at += 1024) {
    const slice = operations.slice(at, at + 1024);
    const journal = new SubmissionJournal(
      join(state, `batch-${at}`, "transactions.json"),
      rpc,
    );
    await journal.initialize({
      feeAllowance: String(BigInt(slice.length) * 10000n),
      rentAllowance: String(slice.reduce((sum, op) => sum + op.rent, 0n)),
      cleanupReserve: String(cleanupReserve),
      available: String(required),
    });
    for (const op of slice)
      await sender.send(op.name, op.instruction, journal, { rent: op.rent });
    await sender.checkpoint();
  }
  await verifyUploadedAccounts(rpc, f, sender.minContextSlot);
  await writeFile(
    join(state, "result.json"),
    JSON.stringify({
      ...quote,
      sealed: true,
      totalFeesLamports: String(sender.totalFees),
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      sealed: true,
      model: f.client.model,
      SLM_MODEL_OWNER: owner,
      SLM_MODEL_NONCE: f.identity.modelNonce,
    }),
  );
}
main().catch((error: unknown) => {
  if (error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message))
    console.error(error.message);
  console.error(
    "Model upload stopped. Preserve upload journals and reconcile any submitted transactions before retrying.",
  );
  process.exitCode = 1;
});
