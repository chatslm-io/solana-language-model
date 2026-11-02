import { OperatorEngine } from "./engine";
import { FileJobStore } from "./store";
import { localSigner } from "./signer";
import { operatorConfig } from "./config";
import { operatorRpc } from "./rpc";
import { operatorModels } from "./models";
import { readOperatorEnv, stateDirectory } from "./external";
import { programBinary } from "./program-binary";
const globalOperator = globalThis as typeof globalThis & {
  slmOperator?: OperatorEngine;
};
export function getOperator() {
  const previous = globalOperator.slmOperator;
  // Next preserves globalThis across module reloads, including instances of
  // the old engine class. Recreate idle engines from the durable journal;
  // never replace one while it owns the operation lock or is still signing.
  if (previous && !(previous instanceof OperatorEngine)) {
    const busy = Object.getOwnPropertyDescriptor(previous, "busy")?.value;
    if (busy === false) globalOperator.slmOperator = undefined;
  }
  if (!globalOperator.slmOperator) {
    const env = readOperatorEnv();
    // Only explicit model-service settings enter the process environment. The
    // signing key is never exported into Next's environment or build tooling.
    for (const key of ["HF_DOWNLOAD_DIR", "HF_TOKEN", "SLM_MAX_DOWNLOAD_BYTES"])
      if (env[key]) process.env[key] = env[key];
    globalOperator.slmOperator = new OperatorEngine({
      store: new FileJobStore(stateDirectory()),
      signer: localSigner,
      config: operatorConfig,
      rpc: operatorRpc,
      models: operatorModels,
      binary: programBinary,
    });
  }
  return globalOperator.slmOperator;
}
