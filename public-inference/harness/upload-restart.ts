/** Single-process acceptance: uploader authority stays in memory across the
 * owned-validator restart. Nothing serializes a signer or imports a wallet. */
import { rpcSlot } from "./confirmation";
import { waitForFinalizedReplay } from "./restart-readiness";
import { join } from "node:path";
import { privateDirectory } from "../../lib/operator/external";
import { prepareModelFixture } from "./model-fixture";
import { prepareTokenizerFixture } from "./tokenizer-fixture";
import { verifyRetainedFixture } from "./retained-ledger";
import { verifiedBinary } from "./build.mjs";
import { runForkModel, type ForkModelJournalFactory } from "./fork-model";
import type { startFrozenLocalValidator } from "./fork";
import type { TestProgress } from "./progress";

export async function runUploadRestartText(
  statePath: string,
  progress: TestProgress,
  start: typeof startFrozenLocalValidator,
  testDependencies: {
    privateDirectory?: typeof privateDirectory;
    createJournal?: ForkModelJournalFactory;
    signer?: Parameters<typeof prepareModelFixture>[3];
    inferenceSigner?: Parameters<typeof prepareModelFixture>[3];
  } = {},
) {
  const started = performance.now();
  const state = (testDependencies.privateDirectory ?? privateDirectory)(
    statePath,
  );
  const f = await prepareModelFixture(
    undefined,
    (message) => progress.log(message),
    undefined,
    testDependencies.signer,
  );
  const tokenizer = await prepareTokenizerFixture(f);
  // Import only when this explicit upload acceptance mode is selected.
  const { uploadModel, referenceChat } = await import("./upload-model");
  let validator: Awaited<ReturnType<typeof start>> | undefined;
  let uploaded: Awaited<ReturnType<typeof uploadModel>> | undefined;
  let recoveryAttempted = false;
  let recoveryReady = true;
  let primaryFailure: unknown;
  try {
    validator = await start(join(state, "upload"), progress, f, undefined, {
      ledgerRoot: join(state, "validator"),
      phase: "create",
    });
    uploaded = await uploadModel(
      validator.rpc,
      join(state, "upload-journals"),
      progress,
      f,
      tokenizer,
      testDependencies.createJournal,
    );
    const pin = validator.restartPin;
    if (!pin) throw Error("upload_acceptance_restart_pin_missing");
    const restartSlot = Number(
      rpcSlot(
        await validator.rpc.rpc("getSlot", [{ commitment: "finalized" }]),
      ),
    );
    await validator.close();
    validator = undefined;
    recoveryReady = false;
    validator = await start(join(state, "inference"), progress, f, undefined, {
      ledgerRoot: join(state, "validator"),
      phase: "resume",
      pin,
    });
    await waitForFinalizedReplay(validator.rpc, restartSlot, progress);
    recoveryReady = true;
    await progress.run(
      "Verifying every uploaded account after validator restart",
      () =>
        verifyRetainedFixture(
          validator!.rpc,
          {
            ...f,
            accounts: [...f.accounts, ...tokenizer.accounts].filter(
              (a, i, all) =>
                all.findIndex((b) => b.address === a.address) === i,
            ),
          },
          verifiedBinary(),
          undefined,
          restartSlot,
        ),
    );
    const inference = await prepareModelFixture(
      f.compiled.modelBytes,
      (message) => progress.log(message),
      f.identity,
      testDependencies.inferenceSigner,
    );
    if (inference.signer.address === f.signer.address)
      throw Error("upload_acceptance_requires_fresh_inference_owner");
    const inferenceTokenizer = await prepareTokenizerFixture(inference);
    // Bytes come from independent recompilation; balances reflect actual uploads.
    const uploadedAccounts = new Map(
      [...f.accounts, ...tokenizer.accounts].map((a) => [a.address, a]),
    );
    for (const account of [
      ...inference.accounts,
      ...inferenceTokenizer.accounts,
    ]) {
      const actual = uploadedAccounts.get(account.address);
      if (
        !actual ||
        !Buffer.from(account.data).equals(Buffer.from(actual.data))
      )
        throw Error("upload_acceptance_recompiled_fixture_mismatch");
      account.lamports = actual.lamports;
    }
    const result = await runForkModel(
      validator.rpc,
      join(state, "inference-journals"),
      progress,
      inference,
      {
        messages: [{ role: "user", content: "Hi" }],
        outputs: 1,
        tokenizer: inferenceTokenizer,
      },
      testDependencies.createJournal,
      { modelAccountSource: "uploaded" },
    );
    const reference = await progress.run(
      "Checking finalized raw-text prompt and output against independent CPU reference",
      () => referenceChat(f, [{ role: "user", content: "Hi" }], 1),
    );
    if (
      JSON.stringify(result.onchainPrompt) !==
        JSON.stringify(reference.promptTokens) ||
      JSON.stringify(result.outputs) !== JSON.stringify(reference.outputTokens)
    )
      throw Error("upload_acceptance_reference_mismatch");
    recoveryAttempted = true;
    const recovery = await uploaded.closeAll(validator.rpc);
    if (
      !result.refundVerified ||
      !recovery.refundVerified ||
      !recovery.allOwnedAccountsClosed
    )
      throw Error("upload_acceptance_refund_not_verified");
    return {
      scope: "uploaded-model-validator-restart-raw-text",
      sourceSha: f.binding.sourceSha,
      totalTransactions:
        uploaded.summary.uploadTransactions +
        result.transactions.length +
        recovery.transactions,
      totalFees: (
        BigInt(uploaded.summary.feesLamports) +
        BigInt(result.totalFees) +
        BigInt(recovery.feesLamports)
      ).toString(),
      refundedLamports: (
        BigInt(recovery.refundedLamports) + BigInt(result.refundedLamports)
      ).toString(),
      elapsedMs: Math.round(performance.now() - started),
      timingScope:
        "orchestrator-wall-clock-including-upload-validator-restart-inference-recovery; transport provenance must be reported separately",
      finalizedBeforeReturn: true,
      referenceParity: true,
      modelUploadTested: true,
      validatorRestartVerified: true,
      freshInferenceOwner: true,
      referenceParityVerified: true,
      genesisModelAccounts: 0,
      upload: uploaded.summary,
      inference: result,
      recovery,
      outputs: result.outputs,
      inferenceExecuted: true,
      refundVerified: true,
    };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      if (uploaded && !recoveryAttempted && validator && recoveryReady)
        await uploaded.closeAll(validator.rpc);
    } catch (recoveryError) {
      if (primaryFailure) {
        const code = (error: unknown) =>
          error instanceof Error &&
          /^[a-zA-Z][a-zA-Z0-9_:.-]{0,160}$/.test(error.message)
            ? error.message
            : "unclassified_error";
        throw new AggregateError(
          [primaryFailure, recoveryError],
          `upload_acceptance_failed:${code(primaryFailure)};recovery_failed:${code(recoveryError)}`,
        );
      }
      throw recoveryError;
    } finally {
      if (validator) await validator.close();
    }
  }
}
