import {
  openRetainedLedger,
  checkRetainedPins,
  verifyRetainedFixture,
  fixtureCommitment,
  type ClonePin,
  type ProgramPin,
} from "./retained-ledger";
import { loadCachedTarget } from "../reference/target-cache";
import { modelCommitment } from "../protocol";
import { createRunLogs, writeProtectedResult } from "./logging";
import { createProgress, type TestProgress } from "./progress";
import {
  localValidatorArgs,
  LOCAL_LEDGER_RETENTION_SHREDS,
} from "./validator-args";
import { stringifyJsonWithBigInts } from "@solana/rpc-spec-types";
/** Validator preflight and frozen public-account cloning. */
import { spawn } from "node:child_process";
import { cloneSigners } from "./clone-signers";
import { validatorVersion } from "../../private-inference/harness/validator-version";
import { writeFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { privateDirectory } from "../../lib/operator/external";

import { prepareModelFixture, type PublicModelFixture } from "./model-fixture";
import { prepareTokenizerFixture } from "./tokenizer-fixture";
import { runForkModel } from "./fork-model";
import {
  build,
  verifiedBinary,
  outputDirectory as buildOutput,
} from "./build.mjs";
import { ReadOnlyCloneRpc, OwnedLocalRpc } from "./transport";
export type AcceptanceRestartPin = {
  genesis: string;
  clone: ClonePin;
  programAccounts: ProgramPin[];
  binarySha256: string;
};
export type UploadAcceptanceValidatorOptions =
  | { ledgerRoot: string; phase: "create" }
  | { ledgerRoot: string; phase: "resume"; pin: AcceptanceRestartPin };
export async function startFrozenLocalValidator(
  statePath: string,
  progress: TestProgress = createProgress("local fork"),
  fixture: PublicModelFixture,
  retained?: ReturnType<typeof openRetainedLedger>,
  acceptance?: UploadAcceptanceValidatorOptions,
) {
  progress.log("Checking protected state directory and validator version");
  // Guard is deliberately before clone, spawn, identity creation or funding.
  const state = privateDirectory(resolve(statePath));
  const version = validatorVersion();
  const code = verifiedBinary();
  if (retained && acceptance)
    throw Error("acceptance_cannot_use_retained_fixture_mode");
  if (
    acceptance?.phase === "resume" &&
    acceptance.pin.binarySha256 !==
      createHash("sha256").update(code).digest("hex")
  )
    throw Error("acceptance_binary_changed");
  const resume = Boolean(retained?.manifest) || acceptance?.phase === "resume";
  if (retained?.manifest) checkRetainedPins(fixture, code, retained.manifest);
  const ledgerRoot = acceptance
    ? privateDirectory(resolve(acceptance.ledgerRoot))
    : (retained?.directory ?? state);
  if (acceptance?.phase === "create" && existsSync(join(ledgerRoot, "ledger")))
    throw Error("acceptance_requires_fresh_ledger");
  if (
    acceptance?.phase === "resume" &&
    !existsSync(join(ledgerRoot, "ledger", "genesis.bin"))
  )
    throw Error("acceptance_ledger_missing");
  if (retained || acceptance) privateDirectory(join(ledgerRoot, "ledger"));
  const genesisFiles =
    retained && !resume
      ? privateDirectory(join(ledgerRoot, "genesis-accounts"))
      : state;
  const key = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  const cloneFile = join(genesisFiles, "memo-account.json");
  let clone: ClonePin;
  if (acceptance?.phase === "resume") clone = acceptance.pin.clone;
  else if (resume) clone = retained!.manifest!.clone;
  else {
    const upstream = new ReadOnlyCloneRpc(process.env.SLM_CLONE_RPC_URL || "");
    const a = (await progress.run(
      "Cloning public Memo account (read-only mainnet RPC)",
      () =>
        upstream.read("getAccountInfo", [
          key,
          { encoding: "base64", commitment: "finalized" },
        ]),
    )) as {
      context: { slot: bigint };
      value: {
        data: [string, string];
        owner: string;
        lamports: bigint;
        executable: boolean;
        rentEpoch: bigint;
      } | null;
    };
    if (!a.value || a.value.data[1] !== "base64" || !a.value.executable)
      throw Error("invalid_clone_account");
    for (const amount of [a.value.lamports, a.value.rentEpoch]) {
      if (
        typeof amount !== "bigint" ||
        amount < 0n ||
        amount > 0xffffffffffffffffn
      )
        throw Error("invalid_clone_account_u64");
    }
    // Legacy BPF loader executable has no ProgramData dependency. Upgradeable programs require explicit dependency cloning.
    if (a.value.owner !== "BPFLoader2111111111111111111111111111111111")
      throw Error("clone_loader_requires_dependency_support");
    const repeat = (await progress.run(
      "Rechecking cloned account consistency",
      () =>
        upstream.read("getAccountInfo", [
          key,
          { encoding: "base64", commitment: "finalized" },
        ]),
    )) as typeof a;
    if (
      stringifyJsonWithBigInts(repeat.value) !==
      stringifyJsonWithBigInts(a.value)
    )
      throw Error("clone_changed_during_freeze");
    await writeFile(
      cloneFile,
      stringifyJsonWithBigInts({ pubkey: key, account: a.value }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    clone = {
      sourceAccount: key,
      sourceOwner: a.value.owner,
      sourceSlots: [a.context.slot.toString(), repeat.context.slot.toString()],
      sourceSha256: createHash("sha256")
        .update(Buffer.from(a.value.data[0], "base64"))
        .digest("hex"),
      atomicHistoricalSnapshot: false,
    };
  }
  const binary = join(
    buildOutput(),
    "sbpf-solana-solana/release/slm_public_inference.so",
  );
  const port = 18899;
  const args = localValidatorArgs({
    state: ledgerRoot,
    resume,
    port,
    cloneAddress: key,
    cloneFile,
    program: fixture.program,
    binary,
  });
  progress.log(
    `Local ledger retention target is ${LOCAL_LEDGER_RETENTION_SHREDS} data shreds for finalized receipt verification; execution limits remain enabled`,
  );
  for (const entry of resume || acceptance ? [] : fixture.accounts) {
    const file = join(genesisFiles, `model-${entry.address}.json`);
    await writeFile(
      file,
      stringifyJsonWithBigInts({
        pubkey: entry.address,
        account: {
          lamports: entry.lamports,
          data: [Buffer.from(entry.data).toString("base64"), "base64"],
          owner: fixture.program,
          executable: false,
          rentEpoch: 0n,
        },
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    args.push("--account", entry.address, file);
  }
  const log = await open(join(state, "validator.log"), "wx", 0o600);
  const child = spawn("solana-test-validator", args, {
    env: { PATH: process.env.PATH, NO_DNA: "1", NODE_ENV: "test" },
    stdio: ["ignore", log.fd, log.fd],
  });
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  const rpc = new OwnedLocalRpc(child, port);
  const stop = async () => {
    if (
      child.pid !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    )
      await new Promise<void>((done, reject) => {
        const force = setTimeout(() => child.kill("SIGKILL"), 10000);
        const deadline = setTimeout(
          () =>
            reject(
              Error("validator_stop_unconfirmed_retained_lock_must_remain"),
            ),
          20000,
        );
        child.once("exit", () => {
          clearTimeout(force);
          clearTimeout(deadline);
          done();
        });
        child.kill("SIGTERM");
      });
    await log.close();
  };
  try {
    const genesis = await progress.run(
      "Starting owned local validator (60s timeout)",
      async () => {
        const deadline = Date.now() + 60000;
        let genesis: string | undefined;
        while (Date.now() < deadline) {
          if (spawnError) throw Error("validator_spawn_failed");
          try {
            genesis = await rpc.pin();
            break;
          } catch {
            if (child.exitCode !== null)
              throw Error(
                `validator_start_failed (exit ${child.exitCode}); inspect ${join(state, "validator.log")}`,
              );
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        if (!genesis) throw Error("validator_start_timeout");
        return genesis;
      },
    );
    let restartPin: AcceptanceRestartPin | undefined;
    if (retained || acceptance) {
      const pins = await progress.run(
        "Verifying retained genesis, program ELF and every immutable fixture account",
        () =>
          verifyRetainedFixture(
            rpc,
            acceptance ? { ...fixture, accounts: [] } : fixture,
            code,
            retained?.manifest,
          ),
      );
      const memo = await rpc.rpc<{
        value: {
          owner: string;
          executable: boolean;
          data: [string, string];
        } | null;
      }>("getAccountInfo", [
        key,
        { encoding: "base64", commitment: "finalized" },
      ]);
      if (
        !memo.value ||
        memo.value.owner !== clone.sourceOwner ||
        !memo.value.executable ||
        memo.value.data[1] !== "base64" ||
        createHash("sha256")
          .update(Buffer.from(memo.value.data[0], "base64"))
          .digest("hex") !== clone.sourceSha256
      )
        throw Error("retained_clone_mismatch");
      restartPin = {
        genesis: pins.genesis,
        clone,
        programAccounts: pins.programAccounts,
        binarySha256: createHash("sha256").update(code).digest("hex"),
      };
      if (
        acceptance?.phase === "resume" &&
        (pins.genesis !== acceptance.pin.genesis ||
          JSON.stringify(pins.programAccounts) !==
            JSON.stringify(acceptance.pin.programAccounts))
      )
        throw Error("acceptance_restart_pin_mismatch");
      if (retained && !retained.manifest)
        retained.save({
          version: 1,
          identity: fixture.identity,
          genesis: pins.genesis,
          program: fixture.program,
          binarySha256: createHash("sha256").update(code).digest("hex"),
          sourceSha256: fixture.binding.sourceSha,
          modelBinding: modelCommitment(fixture.binding),
          fixtureRoot: fixtureCommitment(fixture),
          programAccounts: pins.programAccounts,
          clone,
        });
    }
    const evidence = {
      scope: acceptance
        ? "local mainnet public-account clone; program and Memo only at genesis; model/tokenizer uploaded through transactions"
        : "local mainnet public-account clone; public full model inference with genesis model fixture",
      modelSourceSha: fixture.binding.sourceSha,
      modelBinding: fixture.binding,
      genesisFixtureAccounts: acceptance ? 0 : fixture.accounts.length,
      modelAccountFunding: acceptance
        ? "owner-funded model/tokenizer upload; verified recovery reported separately"
        : "synthetic genesis fixture balances; no owner model deposit or model rent recovery claim",
      validator: version,
      genesis,
      ...clone,
      retainedLedger: retained
        ? { directory: retained.directory, resumed: resume }
        : undefined,
      binarySha256: createHash("sha256").update(code).digest("hex"),
      programDeployment:
        "preloaded at genesis; loader deployment/refund not exercised",
      ledgerRetention: {
        maxDataShreds: LOCAL_LEDGER_RETENTION_SHREDS,
        purpose:
          "retain finalized transaction metadata across confirmation checkpoints",
        bounded: true,
      },
      limits: {
        computeUnitLimit: 200000,
        transactionBytes: 1232,
        heapBytes: 32768,
      },
    };
    await writeFile(
      join(state, "clone-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return {
      rpc,
      state,
      evidence,
      restartPin,
      async close() {
        await progress.run("Stopping owned local validator", stop);
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
if (process.argv[1]?.endsWith("/fork.ts")) {
  const at = process.argv.indexOf("--state-dir");
  if (at < 0 || !process.argv[at + 1])
    throw Error(
      "Usage: node --import tsx public-inference/harness/fork.ts --state-dir /protected/outside-git/new-validator",
    );
  process.argv[at + 1] = resolve(process.argv[at + 1]);
  const progress = createProgress("public local fork");
  (async () => {
    // Before downloading model, serializing any fixtures, spawning or funding.
    privateDirectory(resolve(process.argv[at + 1]));
    const { signer, inferenceSigner } = await cloneSigners();
    process.env.SLM_APPROVED_SIGNER_1 = signer.address;
    process.env.SLM_APPROVED_SIGNER_2 = inferenceSigner.address;
    process.env.SLM_PUBLIC_BUILD_DIR = join(
      resolve(process.argv[at + 1]),
      "program-build",
    );
    await progress.run(
      "Build isolated clone program for selected signers",
      () => build(),
    );

    if (process.argv.includes("--upload-restart-text")) {
      for (const flag of [
        "--ledger-dir",
        "--compare",
        "--unbatched",
        "--strict-finalized",
        "--tokenize-only",
      ])
        if (process.argv.includes(flag))
          throw Error(`--upload-restart-text cannot combine with ${flag}`);
      const logs = createRunLogs(process.argv[at + 1], progress);
      progress.log(
        `Upload/restart/text acceptance files: ${logs.progressPath}; all wallets stay in memory`,
      );
      try {
        const { runUploadRestartText } = await import("./upload-restart");
        const result = await runUploadRestartText(
          process.argv[at + 1],
          logs.progress,
          startFrozenLocalValidator,
          { signer, inferenceSigner },
        );
        console.log(JSON.stringify(logs.writeResult(result).summary));
      } catch (error) {
        logs.progress.log(
          "Upload/restart/text acceptance failed; exact journals and ledger retained",
        );
        throw error;
      } finally {
        logs.close();
      }
      return;
    }
    const ledgerAt = process.argv.indexOf("--ledger-dir");
    if (
      ledgerAt >= 0 &&
      (!process.argv[ledgerAt + 1] ||
        process.argv[ledgerAt + 1].startsWith("--"))
    )
      throw Error("--ledger-dir requires an external path");
    const retained =
      ledgerAt >= 0
        ? openRetainedLedger(process.argv[ledgerAt + 1], process.argv[at + 1])
        : undefined;
    let releaseLock = true;
    try {
      const modelBytes = retained
        ? await loadCachedTarget(join(retained.directory, "cache"), (message) =>
            progress.log(message),
          )
        : undefined;
      const initialFixture = await prepareModelFixture(
        modelBytes,
        (message) => progress.log(message),
        retained?.manifest?.identity,
        signer,
      );
      const strictFinalized = process.argv.includes("--strict-finalized"),
        compare = process.argv.includes("--compare"),
        unbatched = process.argv.includes("--unbatched");
      if (compare && unbatched)
        throw Error("--compare already includes the unbatched baseline");
      const textMode =
        process.argv.includes("--text") ||
        process.argv.includes("--tokenize-only");
      const results: Awaited<ReturnType<typeof runForkModel>>[] = [];
      const modes = compare ? [false, true] : [!unbatched];
      for (let index = 0; index < modes.length; index++) {
        const batched = modes[index],
          fixture =
            index === 0
              ? initialFixture
              : await prepareModelFixture(
                  initialFixture.compiled.modelBytes,
                  undefined,
                  retained ? initialFixture.identity : undefined,
                  signer,
                ),
          tokenizer =
            textMode || retained
              ? await prepareTokenizerFixture(fixture)
              : undefined;
        if (tokenizer) fixture.accounts.push(...tokenizer.accounts);
        progress.log(
          `Public complete model: ${fixture.compiled.commands.length} commands/forward; ${batched ? "up to 8 commands per 1.2m CU transaction" : "one command per 200k CU transaction"}; ${strictFinalized ? "strict-finalized" : "confirmed progression with finalized output/refund barriers"}. No model-upload or validator-latency claim.`,
        );
        const runPath = compare
          ? join(process.argv[at + 1], batched ? "batched" : "unbatched")
          : process.argv[at + 1];
        const logs = createRunLogs(runPath, progress);
        progress.log(
          `Run files: ${logs.progressPath}; successful result will be written to ${join(runPath, "result.json")}`,
        );
        let h:
          Awaited<ReturnType<typeof startFrozenLocalValidator>> | undefined;
        try {
          h = await startFrozenLocalValidator(
            runPath,
            logs.progress,
            fixture,
            retained,
          );
          const result = await runForkModel(
            h.rpc,
            h.state,
            logs.progress,
            fixture,
            textMode && tokenizer
              ? {
                  messages: [{ role: "user", content: "Hi" }],
                  outputs: 1,
                  tokenizer,
                  tokenizeOnly: process.argv.includes("--tokenize-only"),
                }
              : { prompt: [1], outputs: 1 },
            undefined,
            {
              confirmation: strictFinalized ? "finalized" : "confirmed",
              batched,
            },
          );
          results.push(result);
          const saved = logs.writeResult(result);
          console.log(JSON.stringify(saved.summary));
        } catch (error) {
          logs.progress.log(
            "Run failed; existing progress and exact transaction journals retained for diagnosis",
          );
          throw error;
        } finally {
          try {
            if (h) {
              try {
                await h.close();
              } catch (error) {
                releaseLock = false;
                throw error;
              }
            }
          } finally {
            logs.close();
          }
        }
      }
      if (compare) {
        if (
          JSON.stringify(results[0].outputs) !==
          JSON.stringify(results[1].outputs)
        )
          throw Error("public_benchmark_output_mismatch");
        const comparison = {
          comparison: results.map((result) => ({
            benchmark: "benchmark" in result ? result.benchmark : undefined,
            elapsedMs: result.elapsedMs,
            refundVerified: result.refundVerified,
          })),
          outputsEqual: true,
          modelUploadTested: false,
        };
        const resultPath = writeProtectedResult(
          process.argv[at + 1],
          "comparison.json",
          comparison,
        );
        console.log(
          JSON.stringify({ ...comparison, comparisonFile: resultPath }),
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("validator_stop_unconfirmed")
      )
        releaseLock = false;
      throw error;
    } finally {
      if (releaseLock) retained?.close();
    }
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
