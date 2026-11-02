import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { programBinary } from "../lib/operator/program-binary";
import {
  generateKeyPairSigner,
  lamports,
  getTransactionDecoder,
  getSignatureFromTransaction,
} from "@solana/kit";
import { vmRpc, TEST_PROGRAM, withTestAllowlist } from "./vm-rpc";
import { rpcClient } from "../lib/chain/client";
import { fromBase64, sha256 } from "../lib/chain/protocol";
import { canonical, type Manifest } from "../lib/model/manifest";
import { FileJobStore } from "../lib/operator/store";
import type { PrivateDirectory } from "../lib/operator/external";
import {
  OperatorEngine,
  type OperatorDependencies,
} from "../lib/operator/engine";
import type { OperatorConfig } from "../lib/operator/config";
export async function operatorFixture(
  options: { stableBlockhash?: boolean; genesis?: string } = {},
) {
  const vm = vmRpc(options),
    signer = await generateKeyPairSigner(false),
    root = mkdtempSync(join(tmpdir(), "slm-operator-test-"));
  vm.authorizeTestSigners([signer.address]);
  vm.svm.airdrop(signer.address, lamports(1000000000n));
  // Only public test journals go here. Some test runners snapshot /tmp with Git;
  // production directories always pass through privateDirectory().
  const store = new FileJobStore(root as PrivateDirectory),
    bytes = new Uint8Array(78).fill(42),
    digest = await sha256(bytes);
  const manifest: Manifest = {
    version: 1,
    source: { repo: "synthetic/operator", revision: "a".repeat(40) },
    tensors: [],
    artifacts: [{ name: "test", length: 78, payloadOffset: 0, sha256: digest }],
    payloadBytes: 78,
    shards: [{ index: 0, offset: 0, length: 78, sha256: digest }],
  };
  const hash = await sha256(new TextEncoder().encode(canonical(manifest)));
  let sends = 0;
  let afterSend = () => {};
  let beforeRequest = (_method: string) => {
    void _method;
  };
  let modelAvailable = true;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    const p = JSON.parse(body);
    try {
      beforeRequest(p.method);
      if (p.method === "sendTransaction") {
        const tx = getTransactionDecoder().decode(fromBase64(p.params[0]));
        const sig = getSignatureFromTransaction(tx);
        const audit = new FileJobStore(root as PrivateDirectory);
        const storageJobs = audit.load();
        if (
          !storageJobs.some((j) =>
            j.journal.some((e) => e.signature === sig),
          ) &&
          !audit.programJobs.some((j) =>
            j.journal.some((e) => e.signature === sig),
          )
        )
          throw new Error(
            "Signature was not durably recorded before broadcast",
          );
      }
      const result = await vm.request(p.method, p.params);
      if (p.method === "sendTransaction") {
        sends++;
        afterSend();
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: p.id, result }));
    } catch (e) {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: p.id,
          error: { code: -32000, message: (e as Error).message },
        }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config: OperatorConfig = {
    cluster: "devnet",
    program: TEST_PROGRAM,
    rpc: url,
    rpcDisplay: "VM",
    rpcPolicy: { mode: "free", rps: 50, sendRps: 5, scanRps: 25 },
    maxDeposit: "100000000",
    maxFees: "10000000",
    maxTransactions: 100,
  };
  const rpc = rpcClient(url);
  const deps: OperatorDependencies = {
    store,
    signer: async () => signer,
    config: (cluster) => ({ ...config, cluster }),
    rpc: () => rpc,
    models: {
      prepare: async () => {
        if (!modelAvailable) throw new Error("Model unavailable");
        return { id: hash, manifest };
      },
      manifest: async () => {
        if (!modelAvailable) throw new Error("Model unavailable");
        return { id: hash, manifest };
      },
      shard: async () => {
        if (!modelAvailable) throw new Error("Model unavailable");
        return bytes;
      },
    },
    binary: async () =>
      withTestAllowlist(await programBinary(), [signer.address]),
  };
  const engine = new OperatorEngine(deps);
  return {
    vm,
    signer,
    store,
    config,
    rpc,
    deps,
    engine,
    root,
    sends: () => sends,
    afterSend: (callback: () => void) => {
      afterSend = callback;
    },
    beforeRequest: (callback: (method: string) => void) => {
      beforeRequest = callback;
    },
    loseModels: () => {
      modelAvailable = false;
    },
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
