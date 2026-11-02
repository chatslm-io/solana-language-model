import { address } from "@solana/kit";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configuredPath, requiredSetting } from "../lib/config/environment.mjs";
import { localSigner } from "../lib/operator/signer";
import {
  outsideGit,
  privateDirectory,
  readOperatorEnv,
} from "../lib/operator/external";
import { MainnetInferenceRpc } from "../public-inference/client/mainnet-rpc";
import { prepareModelFixture } from "../public-inference/harness/model-fixture";
import { runModel } from "../public-inference/harness/fork-model";
import { createProgress } from "../public-inference/harness/progress";

async function main() {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...readOperatorEnv() }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (requiredSetting("SOLANA_CLUSTER", env) !== "mainnet-beta")
    throw Error("mainnet_cluster_required");
  const budgetText = requiredSetting("SLM_INFERENCE_MAX_LAMPORTS", env);
  if (!/^[1-9][0-9]{0,18}$/.test(budgetText))
    throw Error("invalid_inference_budget");
  const budget = BigInt(budgetText);
  const prompt: unknown = JSON.parse(requiredSetting("SLM_PROMPT_TOKENS", env));
  const outputs = Number(requiredSetting("SLM_OUTPUT_TOKENS", env));
  if (
    !Array.isArray(prompt) ||
    !prompt.length ||
    !prompt.every((t) => Number.isInteger(t) && t >= 0 && t < 8196) ||
    !Number.isInteger(outputs) ||
    outputs < 1 ||
    outputs > 15 ||
    prompt.length + outputs > 16
  )
    throw Error("invalid_inference_scenario");
  const signer = await localSigner(() => ({ ...env }));
  if (!signer) throw Error("mainnet_signer_required");
  const program = address(requiredSetting("SLM_INFERENCE_PROGRAM_ID", env));
  const rpc = new MainnetInferenceRpc(
    requiredSetting("SOLANA_RPC_URL", env),
    program,
  );
  await rpc.beforeSigning();
  const progress = createProgress("mainnet inference");
  const fixture = await prepareModelFixture(
    undefined,
    (message) => progress.log(message),
    {
      modelOwner: address(requiredSetting("SLM_MODEL_OWNER", env)),
      modelNonce: requiredSetting("SLM_MODEL_NONCE", env),
    },
    signer,
    program,
  );
  // Compare sealed account contents, not the synthetic rent balances used by local fixtures.
  for (let at = 0; at < fixture.accounts.length; at += 64) {
    const expected = fixture.accounts.slice(at, at + 64);
    const response = await rpc.rpc<{
      value: ({
        owner: string;
        executable: boolean;
        data: [string, string];
      } | null)[];
    }>("getMultipleAccounts", [
      expected.map((a) => a.address),
      { encoding: "base64", commitment: "finalized" },
    ]);
    if (
      !Array.isArray(response.value) ||
      response.value.length !== expected.length
    )
      throw Error("model_account_count");
    expected.forEach((want, i) => {
      const actual = response.value[i];
      if (
        !actual ||
        actual.owner !== program ||
        actual.executable ||
        actual.data[1] !== "base64" ||
        !Buffer.from(actual.data[0], "base64").equals(Buffer.from(want.data))
      )
        throw Error("mainnet_model_account_mismatch");
    });
  }
  const root = configuredPath("SLM_INFERENCE_STATE_DIR", env);
  outsideGit(root);
  privateDirectory(root);
  const state = join(root, randomUUID());
  await mkdir(state, { mode: 0o700 });
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      cluster: "mainnet-beta",
      program,
      payer: signer.address,
      model: fixture.client.model,
      session: fixture.client.session,
      states: fixture.client.states,
      budgetLamports: budgetText,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  progress.log(
    `Mainnet payer ${signer.address}; program ${program}; maximum ${budgetText} lamports. Journal: ${state}`,
  );
  const result = await runModel(
    rpc,
    state,
    progress,
    fixture,
    { prompt, outputs },
    undefined,
    {
      modelAccountSource: "uploaded",
      mainnetBudgetLamports: budget,
      confirmation: "finalized",
    },
  );
  await writeFile(join(state, "result.json"), JSON.stringify(result) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ outputs: result.outputs, totalFees: result.totalFees }),
  );
}
main().catch((error: unknown) => {
  if (error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message))
    console.error(error.message);
  console.error(
    "Mainnet inference stopped. Check configuration and preserve the session journal before retrying.",
  );
  process.exitCode = 1;
});
