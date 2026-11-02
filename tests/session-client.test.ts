import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  generateKeyPairSigner,
  getTransactionDecoder,
  getTransactionEncoder,
  signTransaction,
  lamports,
} from "@solana/kit";
import { vmRpc, TEST_PROGRAM } from "./vm-rpc";
import { rpcClient, discover } from "../lib/chain/client";
import {
  prepareSession,
  uploadSession,
  refundSessionFees,
} from "../lib/chain/session";
import {
  submitBatch,
  planWithdrawalBatch,
  previewBatch,
  type BatchPreview,
} from "../lib/chain/batch";
import { sha256 } from "../lib/chain/protocol";
import { canonical, type Manifest } from "../lib/model/manifest";

test("client runs an entire session with one owner signature and independently recovers its rent", async () => {
  const vm = vmRpc(),
    owner = await generateKeyPairSigner(),
    delegate = await generateKeyPairSigner();
  vm.authorizeTestSigners([owner.address, delegate.address]);
  vm.svm.airdrop(owner.address, lamports(1000000000n));
  let sends = 0,
    ownerSigns = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    const p = JSON.parse(body);
    try {
      if (p.method === "sendTransaction") sends++;
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: p.id,
          result: await vm.request(p.method, p.params),
        }),
      );
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
  try {
    const rpc = rpcClient(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      ),
      config = {
        cluster: "devnet",
        program: TEST_PROGRAM,
        rpcDisplay: "VM",
        maxDeposit: "100000000",
        maxTransactions: 100,
      };
    const bytes = new Uint8Array(78).fill(42),
      digest = await sha256(bytes);
    const m: Manifest = {
      version: 1,
      source: { repo: "synthetic/session", revision: "0".repeat(40) },
      tensors: [],
      artifacts: [
        { name: "bytes", length: 78, payloadOffset: 0, sha256: digest },
      ],
      payloadBytes: 78,
      shards: [{ index: 0, offset: 0, length: 78, sha256: digest }],
    };
    const hash = await sha256(new TextEncoder().encode(canonical(m)));
    await assert.rejects(
      prepareSession(
        rpc,
        { ...config, cluster: "mainnet-beta" },
        owner.address,
        delegate.address,
        "ab".repeat(32),
        hash,
        m,
      ),
      /devnet-only/,
    );
    const p = await prepareSession(
      rpc,
      config,
      owner.address,
      delegate.address,
      "ab".repeat(32),
      hash,
      m,
    );
    const ownerSend = async (batch: BatchPreview) => {
      ownerSigns++;
      const signed = await Promise.all(
        batch.transactions.map(async (t) =>
          Uint8Array.from(
            getTransactionEncoder().encode(
              await signTransaction(
                [owner.keyPair],
                getTransactionDecoder().decode(t.wire),
              ),
            ),
          ),
        ),
      );
      await submitBatch(rpc, batch, signed, () => {});
    };
    await ownerSend(p.batch);
    await uploadSession(
      rpc,
      config,
      p,
      delegate,
      m,
      async () => bytes,
      () => {},
      () => true,
    );
    await refundSessionFees(
      rpc,
      config,
      p,
      delegate,
      () => {},
      () => true,
    );
    assert.equal(ownerSigns, 1);
    assert.equal(vm.svm.getBalance(delegate.address) || 0n, 0n);
    let refunds = 0n;
    for (;;) {
      const found = await discover(rpc, TEST_PROGRAM, owner.address);
      if (!found.length) break;
      const ops = await planWithdrawalBatch(
        TEST_PROGRAM,
        owner.address,
        found,
        new Set(found.map((a) => a.address)),
        16,
      );
      refunds += ops.reduce((n, o) => n + o.reclaim, 0n);
      await ownerSend(await previewBatch(rpc, config, owner.address, ops));
    }
    assert.equal(refunds, p.batch.deposit - p.allowance);
    assert.equal(
      vm.svm.getBalance(owner.address),
      1000000000n - BigInt(sends) * 5000n,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
