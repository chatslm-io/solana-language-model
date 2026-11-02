import test from "node:test";
import assert from "node:assert/strict";
import { address, lamports } from "@solana/kit";
import { parseEnv } from "node:util";
import { setProgramSetting } from "../../scripts/inference-program";
import { verifiedBinary } from "../harness/build.mjs";
import { operatorFixture } from "../../tests/operator-fixture";
import { OperatorEngine } from "../../lib/operator/engine";
import { account } from "../../lib/chain/client";
import { sha256 } from "../../lib/chain/protocol";

const program = "GwgDVWhUuzrbhGP2MEcGkN1KiXQCHrvAJCbBxgwJwKxP";
test("receipt program env update preserves all other settings and rejects ambiguous files", () => {
  const original = 'OTHER="example value"\nSOLANA_CLUSTER=mainnet-beta\n';
  const updated = setProgramSetting(original, program);
  assert.deepEqual(parseEnv(updated), {
    ...parseEnv(original),
    SLM_INFERENCE_PROGRAM_ID: program,
  });
  assert.equal(setProgramSetting(updated, program), updated);
  assert.throws(
    () =>
      setProgramSetting(
        "SLM_INFERENCE_PROGRAM_ID=\nexport SLM_INFERENCE_PROGRAM_ID=\n",
        program,
      ),
    /Duplicate/,
  );
  assert.throws(
    () =>
      setProgramSetting(
        'OTHER="first line\nSLM_INFERENCE_PROGRAM_ID=inside value\nlast line"\n',
        program,
      ),
    /unrelated/,
  );
});

test("reviewed inference binary deploys through the real loader after interruption; buffer rent is recoverable", async () => {
  const f = await operatorFixture({ stableBlockhash: true });
  try {
    f.config.program = null;
    f.config.maxDeposit = "4000000000";
    f.config.maxFees = "10000000";
    f.config.maxTransactions = 1000;
    f.config.rpcPolicy = { mode: "paid", rps: 50, sendRps: 5, scanRps: 25 };
    f.vm.svm.airdrop(f.signer.address, lamports(5000000000n));
    f.deps.binary = async () => verifiedBinary();
    const p = await f.engine.prepareProgram("devnet");
    assert.equal(f.sends(), 0);
    f.afterSend(() => f.engine.pause(p.id));
    await f.engine.startProgram(p.id, "devnet");
    await f.engine.wait();
    assert.equal(f.store.programJobs.at(-1)!.phase, "paused");
    f.afterSend(() => {});
    const restarted = new OperatorEngine(f.deps);
    await restarted.startProgram(p.id, "devnet", true);
    await restarted.wait();
    assert.equal(f.store.programJobs.at(-1)!.phase, "recovered");
    assert.equal(await account(f.rpc, address(p.buffer)), null);
    const next = await restarted.prepareProgram("devnet");
    await restarted.startProgram(next.id, "devnet");
    await restarted.wait();
    const done = f.store.programJobs.at(-1)!;
    assert.equal(done.phase, "complete", done.message);
    assert.equal(f.store.programs.devnet, next.program);
    assert.equal(await account(f.rpc, address(next.buffer)), null);
    const code = await account(f.rpc, address(next.programData));
    assert.equal(
      await sha256(code!.bytes.subarray(45)),
      await sha256(verifiedBinary()),
    );
    assert.ok(done.journal.every((entry) => entry.status === "finalized"));
  } finally {
    await f.close();
  }
});
