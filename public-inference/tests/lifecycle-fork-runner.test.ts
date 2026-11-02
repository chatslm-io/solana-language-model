import { approvedTestSigner } from "../../tests/approved-test-signer";
/** Real SBF through the actual fork runner; RPC finality is explicitly simulated.
 * No validator or network. Only public ciphertext journals use test path injection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { lamports } from "@solana/kit";
import { runForkModel } from "../harness/fork-model";
import { prepareModelFixture } from "../harness/model-fixture";

import { TransactionCoordinator } from "../coordinator/transactions";
import type { PrivateDirectory } from "../../lib/operator/external";

import { simulatedRpc } from "./fork-rpc-fixture";

test(
  "actual public model fork runner executes complete SBF model with explicitly simulated RPC finality",
  { timeout: 180000 },
  async () => {
    const root = mkdtempSync("/tmp/slm-public-fork-test-");
    const progress = {
      log(message: string) {
        const step = /token-\d+-step-(\d+):/.exec(message);
        if (!step || Number(step[1]) % 250 === 0)
          process.stderr.write("[public fork simulation] " + message + "\n");
      },
      async run<T>(stage: string, action: () => Promise<T>) {
        this.log(stage);
        return action();
      },
    };
    try {
      const fixture = await prepareModelFixture(
          undefined,
          (message) => progress.log(message),
          undefined,
          await approvedTestSigner(),
        ),
        { rpc, svm } = simulatedRpc();
      for (const a of fixture.accounts)
        svm.setAccount({
          address: a.address,
          data: a.data,
          programAddress: fixture.program,
          lamports: lamports(a.lamports),
          space: BigInt(a.data.length),
          executable: false,
        });
      // Only synthetic public transaction journals override the outside-Git guard.
      // Actual validator identity and journals ALWAYS use the production guard.
      const result = await runForkModel(
        rpc,
        root,
        progress,
        fixture,
        { prompt: [1], outputs: 1 },
        (path, transport) =>
          new TransactionCoordinator(path, transport, {
            outsideGit(path) {
              assert.ok(path.startsWith(root + "/"));
            },
            privateDirectory(path) {
              assert.ok(path.startsWith(root + "/"));
              mkdirSync(path, { recursive: true, mode: 0o700 });
              return path as PrivateDirectory;
            },
          }),
      );
      assert.deepEqual(result.outputs, [1047]);
      assert.equal(result.refundVerified, true);
      assert.equal(svm.getAccount(fixture.client.session).exists, false);
      for (const a of fixture.client.states)
        assert.equal(svm.getAccount(a).exists, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test(
  "tokenizer-only actual RPC runner uses raw UTF8 and compiled SBF with simulated finality",
  { timeout: 120000 },
  async () => {
    const root = mkdtempSync("/tmp/slm-public-text-fork-test-"),
      progress = {
        log(message: string) {
          process.stderr.write("[tokenizer RPC simulation] " + message + "\n");
        },
        async run<T>(stage: string, action: () => Promise<T>) {
          this.log(stage);
          return action();
        },
      };
    try {
      const { prepareTokenizerFixture } =
          await import("../harness/tokenizer-fixture"),
        fixture = await prepareModelFixture(
          undefined,
          (message) => progress.log(message),
          undefined,
          await approvedTestSigner(),
        ),
        tokenizer = await prepareTokenizerFixture(fixture),
        { rpc, svm } = simulatedRpc();
      for (const a of [...fixture.accounts, ...tokenizer.accounts])
        svm.setAccount({
          address: a.address,
          data: a.data,
          programAddress: fixture.program,
          lamports: lamports(a.lamports),
          space: BigInt(a.data.length),
          executable: false,
        });
      const result = await runForkModel(
        rpc,
        root,
        progress,
        fixture,
        {
          messages: [{ role: "user", content: "Hi" }],
          outputs: 1,
          tokenizer,
          tokenizeOnly: true,
        },
        (path, transport) =>
          new TransactionCoordinator(path, transport, {
            outsideGit(path) {
              assert.ok(path.startsWith(root + "/"));
            },
            privateDirectory(path) {
              assert.ok(path.startsWith(root + "/"));
              mkdirSync(path, { recursive: true, mode: 0o700 });
              return path as PrivateDirectory;
            },
          }),
      );
      assert.equal(result.refundVerified, true);
      assert.equal(result.inferenceExecuted, false);
      assert.equal(result.onchainPrompt.length, 5);
      assert.equal(result.onchainPrompt[0], 8193);
      assert.equal(result.onchainPrompt.at(-1), 8194);
      assert.equal(svm.getAccount(fixture.client.session).exists, false);
      assert.equal(svm.getAccount(tokenizer.client.scratch).exists, false);
      for (const state of fixture.client.states)
        assert.equal(svm.getAccount(state).exists, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
