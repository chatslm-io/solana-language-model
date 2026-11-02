import test from "node:test";
import assert from "node:assert/strict";
import {
  address,
  getAddressEncoder,
  getSignatureFromTransaction,
  getTransactionEncoder,
  signTransaction,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { operatorFixture } from "./operator-fixture";
import { account } from "../lib/chain/client";
import { base64, sha256 } from "../lib/chain/protocol";
import { loaderTransaction, LOADER } from "../lib/chain/loader";
import {
  quotePrivateLinearDeployment,
  runPrivateLinearDeployment,
  verifyPrivateLinearDeployment,
  preparePrivateLinearRetirement,
  verifyPrivateLinearRetirement,
} from "../lib/private-linear/devnet-deploy";

async function setup() {
  const f = await operatorFixture({ stableBlockhash: true });
  f.config.maxDeposit = "2000000000";
  f.config.maxFees = "10000000";
  f.config.maxTransactions = 200;
  f.config.rpcPolicy = { mode: "paid", rps: 50, sendRps: 5, scanRps: 25 };
  const job = await quotePrivateLinearDeployment(f.config, f.rpc, f.signer);
  f.store.programJobs.push(job);
  const save = () => f.store.save([]);
  save();
  return { ...f, job, save };
}

test("isolated real loader deployment and retirement prove exact ProgramData refund without changing storage pins", async () => {
  const f = await setup();
  try {
    assert.equal(f.sends(), 0);
    assert.equal(f.job.purpose, "private-linear-devnet-v1");
    const before = f.vm.svm.getBalance(f.signer.address)!;
    const storageProgram = f.config.program;
    await assert.rejects(
      runPrivateLinearDeployment({
        job: f.job,
        config: f.config,
        rpc: f.rpc,
        signer: f.signer,
        save: f.save,
        stopped: () => false,
      }),
      /not_approved/,
    );
    f.job.approved = true;
    f.save();
    await runPrivateLinearDeployment({
      job: f.job,
      config: f.config,
      rpc: f.rpc,
      signer: f.signer,
      save: f.save,
      stopped: () => false,
    });
    assert.equal(f.job.phase, "complete");
    // Simulate losing the final deploy reply: recovery discovers and verifies
    // the landed code, then the same workflow continues into retirement below.
    const deploymentSends = f.sends();
    f.job.phase = "paused";
    f.job.intent = "recover";
    await runPrivateLinearDeployment({
      job: f.job,
      config: f.config,
      rpc: f.rpc,
      signer: f.signer,
      save: f.save,
      stopped: () => false,
    });
    assert.equal(f.job.phase, "complete");
    assert.equal(f.sends(), deploymentSends);
    assert.equal(f.config.program, storageProgram);
    assert.deepEqual(f.store.programs, {});
    const deployed = await verifyPrivateLinearDeployment(f.rpc, f.job);
    assert.equal(deployed.programDataLamports, BigInt(f.job.codeRent));
    assert.equal(deployed.programRent, BigInt(f.job.programRent));
    assert.equal(await account(f.rpc, address(f.job.buffer)), null);
    await assert.rejects(
      preparePrivateLinearRetirement(f.rpc, f.job),
      /wait_for_later_slot/,
    );
    f.vm.svm.warpToSlot(f.vm.svm.getClock().slot + 1n);
    const retirement = await preparePrivateLinearRetirement(f.rpc, f.job);
    assert.equal(retirement.refundableLamports, BigInt(f.job.codeRent));
    assert.equal(
      retirement.instruction.accounts?.[1].address,
      f.signer.address,
    );
    const life = (
      await f.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
    ).value;
    const { tx } = loaderTransaction(
      f.signer.address,
      [retirement.instruction],
      life,
    );
    const signed = await signTransaction([f.signer.keyPair], tx);
    const sig = getSignatureFromTransaction(signed);
    // Local-only harness: the parent CLI separately tests durable retirement intent.
    await f.vm.request("sendTransaction", [
      base64(
        Uint8Array.from(getTransactionEncoder().encode(signed)),
      ) as Base64EncodedWireTransaction,
    ]);
    const recovery = await verifyPrivateLinearRetirement(
      f.rpc,
      f.job,
      sig,
      retirement.refundableLamports,
    );
    assert.equal(recovery.reclaimedLamports, BigInt(f.job.codeRent));
    assert.equal(recovery.retainedProgramLamports, BigInt(f.job.programRent));
    assert.equal(await account(f.rpc, address(f.job.programData)), null);
    assert.equal(
      before - f.vm.svm.getBalance(f.signer.address)!,
      BigInt(f.job.programRent) + BigInt(f.job.feesReserved) + 5000n,
    );
    await assert.rejects(
      verifyPrivateLinearRetirement(
        f.rpc,
        f.job,
        sig,
        retirement.refundableLamports + 1n,
      ),
      /expected refund/,
    );
    await assert.rejects(
      preparePrivateLinearRetirement(f.rpc, f.job),
      /verification_failed/,
    );
  } finally {
    await f.close();
  }
});

test("interrupted private-linear buffer recovery requires no matching local binary commitment", async () => {
  const f = await setup();
  try {
    const before = f.vm.svm.getBalance(f.signer.address)!;
    f.job.approved = true;
    f.save();
    await runPrivateLinearDeployment({
      job: f.job,
      config: f.config,
      rpc: f.rpc,
      signer: f.signer,
      save: f.save,
      stopped: () => f.sends() >= 1,
    });
    assert.equal(f.sends(), 1);
    assert.ok(await account(f.rpc, address(f.job.buffer)));
    // A stale/unavailable reviewed binary must not obstruct refund. If the
    // deployment branch reads/compares the current artifact, this digest fails.
    f.job.binaryHash = "0".repeat(64);
    f.job.intent = "recover";
    f.save();
    await runPrivateLinearDeployment({
      job: f.job,
      config: f.config,
      rpc: f.rpc,
      signer: f.signer,
      save: f.save,
      stopped: () => false,
    });
    assert.equal(f.job.phase, "recovered");
    assert.equal(await account(f.rpc, address(f.job.buffer)), null);
    assert.equal(await account(f.rpc, address(f.job.program)), null);
    const recoveredSends = f.sends();
    f.job.intent = "deploy";
    await runPrivateLinearDeployment({
      job: f.job,
      config: f.config,
      rpc: f.rpc,
      signer: f.signer,
      save: f.save,
      stopped: () => false,
    });
    assert.equal(f.job.phase, "recovered");
    assert.equal(f.sends(), recoveredSends);
    assert.equal(before - f.vm.svm.getBalance(f.signer.address)!, 10000n);
    assert.deepEqual(f.store.programs, {});
  } finally {
    await f.close();
  }
});

test("private-linear deployment refuses mainnet, changed identities and mismatched binary evidence", async () => {
  const f = await setup();
  try {
    await assert.rejects(
      quotePrivateLinearDeployment(
        { ...f.config, cluster: "mainnet-beta" },
        f.rpc,
        f.signer,
      ),
      /devnet_only/,
    );
    await assert.rejects(
      verifyPrivateLinearDeployment(f.rpc, {
        ...f.job,
        purpose: "wrong",
      } as unknown as typeof f.job),
      /wrong_deployment_purpose/,
    );
    await assert.rejects(
      verifyPrivateLinearDeployment(f.rpc, {
        ...f.job,
        program: f.signer.address,
      }),
      /addresses_changed/,
    );
    await assert.rejects(
      verifyPrivateLinearDeployment(
        {
          getGenesisHash: () => ({
            send: async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
          }),
        } as unknown as typeof f.rpc,
        f.job,
      ),
      /devnet_genesis_mismatch/,
    );
    f.job.approved = true;
    f.job.binaryHash = "0".repeat(64);
    f.save();
    await assert.rejects(
      runPrivateLinearDeployment({
        job: f.job,
        config: f.config,
        rpc: f.rpc,
        signer: f.signer,
        save: f.save,
        stopped: () => false,
      }),
      /binary changed/,
    );
    assert.equal(f.sends(), 0);
  } finally {
    await f.close();
  }
});

test("landed deployment recovery verifies remote commitment without requiring the current build", async () => {
  const f = await setup();
  try {
    const remoteBinary = Uint8Array.of(9, 8, 7);
    f.job.binaryBytes = remoteBinary.length;
    f.job.binaryHash = await sha256(remoteBinary);
    f.job.phase = "paused";
    f.job.intent = "recover";
    f.job.approved = true;
    const program = new Uint8Array(36);
    new DataView(program.buffer).setUint32(0, 2, true);
    program.set(getAddressEncoder().encode(address(f.job.programData)), 4);
    const data = new Uint8Array(45 + remoteBinary.length);
    new DataView(data.buffer).setUint32(0, 3, true);
    data[12] = 1;
    data.set(getAddressEncoder().encode(f.signer.address), 13);
    data.set(remoteBinary, 45);
    const rpc = {
      getGenesisHash: () => ({
        send: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      }),
      getAccountInfo: (key: string) => ({
        send: async () => ({
          value:
            key === f.job.buffer
              ? null
              : {
                  executable: key === f.job.program,
                  owner: LOADER,
                  lamports: 1n,
                  data: [
                    base64(key === f.job.program ? program : data),
                    "base64",
                  ],
                },
        }),
      }),
    } as unknown as typeof f.rpc;
    await runPrivateLinearDeployment({
      job: f.job,
      config: f.config,
      rpc,
      signer: f.signer,
      save: f.save,
      stopped: () => false,
    });
    assert.equal(f.job.phase, "complete");
    assert.equal(f.sends(), 0);
  } finally {
    await f.close();
  }
});
