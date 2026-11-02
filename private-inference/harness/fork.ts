import { createProgress, type TestProgress } from "./progress";
import { stringifyJsonWithBigInts } from "@solana/rpc-spec-types";
/** Validator preflight and frozen public-account cloning. */
import { spawn } from "node:child_process";
import { validatorVersion } from "./validator-version";
import { writeFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { privateDirectory } from "../../lib/operator/external";
import { runForkStream } from "./fork-stream";
import { runForkCircuit } from "./fork-circuit";
import { runForkPrimitive } from "./fork-primitive";
import { verifiedBinary, outputDirectory as buildOutput } from "./build.mjs";
import { ReadOnlyCloneRpc, OwnedLocalRpc } from "./transport";
export async function startFrozenLocalValidator(
  statePath: string,
  progress: TestProgress = createProgress("local fork"),
  flavor: "experimental" | "circuit" | "stream" = "experimental",
) {
  progress.log("Checking protected state directory and validator version");
  // Guard is deliberately before clone, spawn, identity creation or funding.
  const state = privateDirectory(resolve(statePath));
  const version = validatorVersion();
  const upstream = new ReadOnlyCloneRpc(process.env.SLM_CLONE_RPC_URL || "");
  const key = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
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
    stringifyJsonWithBigInts(repeat.value) !== stringifyJsonWithBigInts(a.value)
  )
    throw Error("clone_changed_during_freeze");
  const cloneFile = join(state, "memo-account.json");
  await writeFile(
    cloneFile,
    stringifyJsonWithBigInts({ pubkey: key, account: a.value }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const binary = join(
    buildOutput(),
    flavor,
    "sbpf-solana-solana/release/slm_private_inference.so",
  );
  const code = verifiedBinary(flavor);
  const port = 18899;
  const log = await open(join(state, "validator.log"), "wx", 0o600);
  const args = [
    "--ledger",
    join(state, "ledger"),
    "--rpc-port",
    String(port),
    "--bind-address",
    "127.0.0.1",
    "--faucet-port",
    "18900",
    "--account",
    key,
    cloneFile,
    "--bpf-program",
    "DJEo3okrdH4EPUXNPNNDxKTqRuHdaZxEhGJRcBA2ydhf",
    binary,
    "--quiet",
  ];
  const child = spawn("solana-test-validator", args, {
    env: { PATH: process.env.PATH, NO_DNA: "1", NODE_ENV: "test" },
    stdio: ["ignore", log.fd, log.fd],
  });
  const rpc = new OwnedLocalRpc(child, port);
  try {
    const genesis = await progress.run(
      "Starting owned local validator (60s timeout)",
      async () => {
        const deadline = Date.now() + 60000;
        let genesis: string | undefined;
        while (Date.now() < deadline) {
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
    const evidence = {
      scope:
        "local mainnet public-account clone; experimental encrypted primitive only",
      validator: version,
      genesis,
      sourceAccount: key,
      sourceOwner: a.value.owner,
      sourceSlots: [a.context.slot.toString(), repeat.context.slot.toString()],
      sourceSha256: createHash("sha256")
        .update(Buffer.from(a.value.data[0], "base64"))
        .digest("hex"),
      atomicHistoricalSnapshot: false,
      binarySha256: createHash("sha256").update(code).digest("hex"),
      programDeployment:
        "preloaded at genesis; loader deployment/refund not exercised",
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
      async close() {
        await progress.run(
          "Stopping local validator (10s graceful shutdown limit)",
          () =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
              }
              const timeout = setTimeout(() => {
                child.kill("SIGKILL");
                resolve();
              }, 10000);
              child.once("exit", () => {
                clearTimeout(timeout);
                resolve();
              });
              child.kill("SIGTERM");
            }),
        );
        await log.close();
      },
    };
  } catch (error) {
    child.kill("SIGTERM");
    await log.close();
    throw error;
  }
}
if (process.argv[1]?.endsWith("/fork.ts")) {
  const at = process.argv.indexOf("--state-dir");
  if (at < 0 || !process.argv[at + 1])
    throw Error(
      "Usage: npm run private-inference:test:fork -- --state-dir /external/protected/new-local-validator",
    );
  const suite = process.argv.includes("--suite");
  const circuit = process.argv.includes("--circuit");
  const streamAt = process.argv.indexOf("--stream-operation"),
    stream = process.argv.includes("--stream") || streamAt >= 0;
  const operation = streamAt >= 0 ? process.argv[streamAt + 1] : "compare";
  if (!["compare", "add", "multiply"].includes(operation))
    throw Error("--stream-operation must be compare, add or multiply");
  if (stream && circuit) throw Error("Choose either --stream or --circuit");
  if (stream && suite && operation !== "compare")
    throw Error(
      "--stream --suite supports comparison/recovery only; run add or multiply as a single explicit operation",
    );
  const progress = createProgress("local fork");
  startFrozenLocalValidator(
    process.argv[at + 1],
    progress,
    stream ? "stream" : circuit ? "circuit" : "experimental",
  )
    .then(async (h) => {
      try {
        console.log(JSON.stringify(h.evidence));
        if (stream) {
          const op = operation as "compare" | "add" | "multiply";
          const cases = suite
            ? [
                {
                  operation: "compare" as const,
                  aBits: 0xbf800000,
                  bBits: 0x3f800000,
                },
                {
                  operation: "compare" as const,
                  aBits: 0x7fc01234,
                  bBits: 0x3f800000,
                },
                {
                  operation: "compare" as const,
                  aBits: 0,
                  bBits: 0x80000000,
                  interruptAfterWindow: true,
                },
              ]
            : [
                {
                  operation: op,
                  aBits:
                    op === "compare"
                      ? 0xbf800000
                      : op === "add"
                        ? 0x3f800000
                        : 3,
                  bBits:
                    op === "compare"
                      ? 0x3f800000
                      : op === "add"
                        ? 0x33800000
                        : 0x3f000000,
                },
              ];
          for (let i = 0; i < cases.length; i++) {
            progress.log(
              `Streaming scenario ${i + 1}/${cases.length}: ${cases[i].operation}`,
            );
            const directory = privateDirectory(
              join(h.state, `stream-${i + 1}`),
            );
            console.log(
              JSON.stringify(
                await runForkStream(h.rpc, directory, progress, cases[i]),
              ),
            );
          }
          progress.log(
            "PASS: encrypted scalar binary32 operation/recovery; not transformer/chat",
          );
        } else if (circuit) {
          const scenarios = suite
            ? [
                { left: -128, right: 127, interruptAfterStep: false },
                { left: 127, right: -128, interruptAfterStep: false },
                { left: -1, right: -1, interruptAfterStep: false },
                { left: 0, right: 1, interruptAfterStep: true },
              ]
            : [{ left: -128, right: 127, interruptAfterStep: false }];
          for (let i = 0; i < scenarios.length; i++) {
            progress.log(`Circuit scenario ${i + 1}/${scenarios.length}`);
            const directory = privateDirectory(
              join(h.state, `circuit-${i + 1}`),
            );
            console.log(
              JSON.stringify(
                await runForkCircuit(h.rpc, directory, progress, scenarios[i]),
              ),
            );
          }
          progress.log(
            "PASS: bounded compiled encrypted circuit and recovery; not transformer/chat",
          );
        } else if (suite) {
          const scenarios = [
            { a: false, b: false },
            { a: false, b: true },
            { a: true, b: false },
            { a: true, b: true },
            { a: true, b: false, interruptUpload: true },
          ];
          const results = [];
          for (let i = 0; i < scenarios.length; i++) {
            progress.log(
              `Scenario ${i + 1}/${scenarios.length}: ${scenarios[i].interruptUpload ? "interrupted upload and key-independent recovery" : "fresh encrypted AND"}`,
            );
            const directory = privateDirectory(join(h.state, `case-${i + 1}`));
            const result = await runForkPrimitive(
              h.rpc,
              directory,
              progress,
              scenarios[i],
            );
            results.push(result);
            console.log(JSON.stringify(result));
          }
          const evidence = {
            scope: "local encrypted primitive suite; not transformer/chat",
            scenariosPassed: results.length,
            allRefundsVerified: results.every((r) => r.refundVerified),
            results,
          };
          await writeFile(
            join(h.state, "suite-evidence.json"),
            JSON.stringify(evidence, null, 2) + "\n",
            { mode: 0o600, flag: "wx" },
          );
          progress.log(
            "PASS: all four AND inputs plus interrupted-upload recovery; not transformer/chat",
          );
        } else {
          console.log(
            JSON.stringify(await runForkPrimitive(h.rpc, h.state, progress)),
          );
          progress.log(
            "PASS: experimental encrypted AND, finalized execution and rent recovery (not transformer/chat)",
          );
        }
      } finally {
        await h.close();
      }
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
