import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSigner, signTransaction, lamports } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { vmRpc, TEST_PROGRAM } from "./vm-rpc";
import { canonical, type Manifest } from "../lib/model/manifest";
import {
  sha256,
  instruction,
  registryAddress,
  shardAddress,
  HEADER,
} from "../lib/chain/protocol";
import { transaction } from "../lib/chain/client";
test("independent verification CLI reconstructs exact bytes and validates segment hashes without source model files", async () => {
  const { svm, request, authorizeTestSigners } = vmRpc(),
    signer = await generateKeyPairSigner(),
    data = new Uint8Array([9, 1, 4, 8]);
  authorizeTestSigners([signer.address]);
  svm.airdrop(signer.address, lamports(1000000000n));
  const digest = await sha256(data),
    id = "ab".repeat(32);
  const manifest: Manifest = {
    version: 1,
    source: { repo: "synthetic/independent", revision: "0".repeat(40) },
    tensors: [],
    artifacts: [
      {
        name: "test.bytes",
        payloadOffset: 0,
        length: data.length,
        sha256: digest,
      },
    ],
    payloadBytes: data.length,
    shards: [{ index: 0, offset: 0, length: data.length, sha256: digest }],
  };
  const commitment = await sha256(
    new TextEncoder().encode(canonical(manifest)),
  );
  const registry = await registryAddress(TEST_PROGRAM, signer.address, id),
    shard = await shardAddress(TEST_PROGRAM, signer.address, id, 0);
  for (const ix of [
    instruction(TEST_PROGRAM, signer.address, registry, "createRegistry", {
      id,
      hash: commitment,
      count: 1,
      bytes: BigInt(data.length),
      cap: svm.minimumBalanceForRentExemption(BigInt(HEADER)),
    }),
    instruction(TEST_PROGRAM, signer.address, registry, "createShard", {
      index: 0,
      length: data.length,
      hash: digest,
      cap: svm.minimumBalanceForRentExemption(BigInt(HEADER + data.length)),
      shard,
    }),
    instruction(TEST_PROGRAM, signer.address, registry, "write", {
      shard,
      offset: 0,
      chunk: data,
    }),
    instruction(TEST_PROGRAM, signer.address, registry, "finalize", { shard }),
    instruction(TEST_PROGRAM, signer.address, registry, "seal"),
  ]) {
    svm.expireBlockhash();
    const tx = transaction(signer.address, ix, svm.latestBlockhash(), 100000n);
    const result = svm.sendTransaction(
      await signTransaction([signer.keyPair], tx.tx),
    );
    assert.ok(!(result instanceof FailedTransactionMetadata));
  }
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const b of req) data += b;
    const p = JSON.parse(data);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: p.id,
        result: await request(p.method, p.params),
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(join(tmpdir(), "slm-verifier-"));
  try {
    const path = join(root, "input.json");
    await writeFile(path, canonical(manifest));
    const port = (server.address() as { port: number }).port;
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/verify.ts",
        TEST_PROGRAM,
        signer.address,
        id,
        path,
        join(root, "output"),
      ],
      { env: { ...process.env, SOLANA_RPC_URL: `http://127.0.0.1:${port}` } },
    );
    assert.match(result.stdout, /Verified and reconstructed 4 bytes/);
    assert.deepEqual(
      new Uint8Array(
        await readFile(join(root, "output/selected-payload.bytes")),
      ),
      data,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
