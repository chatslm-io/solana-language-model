import "server-only";
import { network, operatorConfig, rpcInfo } from "@/lib/operator/config";
import { localSigner } from "@/lib/operator/signer";
import { getOperator } from "@/lib/operator/runtime";
import type { Mode } from "@/lib/operator/types";
export async function operatorAction(input: Record<string, unknown>) {
  const allowed: Record<string, string[]> = {
    status: ["action", "cluster", "refresh"],
    prepare: ["action", "cluster", "mode", "repo", "revision", "file"],
    start: ["action", "cluster", "id"],
    pause: ["action", "cluster", "id"],
    rpcSettings: ["action", "cluster", "mode", "rps", "sendRps", "scanRps"],
    programPrepare: ["action", "cluster"],
    programStart: ["action", "cluster", "id"],
    programRecover: ["action", "cluster", "id"],
  };
  if (
    typeof input.action !== "string" ||
    !Object.hasOwn(allowed, input.action) ||
    Object.keys(input).some((k) => !allowed[input.action as string].includes(k))
  )
    throw new Error("Unsupported operator request");
  const cluster = network(input.cluster);
  if (input.action === "status" && !(await localSigner())) {
    const config = operatorConfig(cluster);
    return {
      cluster,
      owner: null,
      program: config.program,
      balance: "0",
      refundable: "0",
      accounts: 0,
      maxDeposit: config.maxDeposit,
      maxFees: config.maxFees,
      busy: false,
      rpc: rpcInfo(config),
      job: null,
    };
  }
  const engine = getOperator();
  if (
    input.action.startsWith("program") &&
    typeof engine.prepareProgram !== "function"
  )
    throw new Error(
      "The server updated while an older operation was active. Wait for it to finish or pause it, then retry program setup.",
    );
  if (input.action === "rpcSettings")
    return engine.configureRpc(cluster, {
      mode: input.mode,
      rps: input.rps,
      sendRps: input.sendRps,
      scanRps: input.scanRps,
    });
  if (input.action === "status")
    return engine.status(cluster, input.refresh === true);
  if (input.action === "programPrepare") return engine.prepareProgram(cluster);
  if (input.action === "prepare") {
    if (!["test", "upload", "withdraw"].includes(String(input.mode)))
      throw new Error("Unsupported operator mode");
    const source =
      input.mode === "upload"
        ? {
            repo: String(input.repo || ""),
            revision: String(input.revision || ""),
            file: String(input.file || ""),
          }
        : undefined;
    if (
      source &&
      (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(
        source.repo,
      ) ||
        !/^[a-f0-9]{40}$/.test(source.revision) ||
        source.file.length > 1024 ||
        !source.file.endsWith(".gguf"))
    )
      throw new Error("Choose a pinned Hugging Face repository and GGUF file");
    return engine.prepare(cluster, input.mode as Mode, source);
  }
  if (typeof input.id !== "string" || !/^[a-f0-9]{64}$/.test(input.id))
    throw new Error("Invalid operation ID");
  if (input.action === "programStart" || input.action === "programRecover")
    return engine.startProgram(
      input.id,
      cluster,
      input.action === "programRecover",
    );
  if (input.action === "start") return engine.start(input.id, cluster);
  return engine.pause(input.id);
}
