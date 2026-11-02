import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  address,
  generateKeyPairSigner,
  getTransactionDecoder,
  getSignatureFromTransaction,
  type Instruction,
} from "@solana/kit";
import { UploadTransactionSender } from "../harness/upload-transactions";
import { MainnetInferenceRpc } from "../client/mainnet-rpc";
import { SubmissionJournal } from "../../private-inference/coordinator/transactions";
import type { PrivateDirectory } from "../../lib/operator/external";

async function fixture(mainnet = false) {
  const dir = mkdtempSync("/tmp/slm-upload-sender-test-"),
    signer = await generateKeyPairSigner();
  const control = {
    finalized: false,
    failed: false,
    lostReply: false,
    pruned: false,
    changed: false,
    sends: 0,
    signature: "",
  };
  const rpc = {
    localOnly: true as const,
    async beforeSigning() {},
    async sendExact(wire: string) {
      control.sends++;
      control.signature = getSignatureFromTransaction(
        getTransactionDecoder().decode(Buffer.from(wire, "base64")),
      );
      if (control.lostReply) throw Error("simulated_lost_reply");
      return control.signature;
    },
    async status(): Promise<"pending" | "finalized" | "failed"> {
      return control.finalized
        ? control.failed
          ? "failed"
          : "finalized"
        : "pending";
    },
    async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
      if (method === "getLatestBlockhash")
        return {
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 100,
          },
        } as T;
      if (method === "getSignatureStatuses")
        return {
          context: { slot: 5 },
          value: [
            {
              slot: 5,
              err: control.failed ? { InstructionError: [0, "test"] } : null,
              confirmationStatus: control.finalized ? "finalized" : "confirmed",
            },
          ],
        } as T;
      if (method === "getFirstAvailableBlock") return 6 as T;
      if (method === "getTransaction") {
        if (control.pruned) return null as T;
        const finalized =
          (params[1] as { commitment: string }).commitment === "finalized";
        return {
          slot: 5,
          meta: {
            fee: 5000,
            computeUnitsConsumed: finalized && control.changed ? 1001 : 1000,
            err: control.failed ? { InstructionError: [0, "test"] } : null,
          },
        } as T;
      }
      throw Error("unexpected_rpc");
    },
  };
  const transport = mainnet
    ? Object.assign(
        new MainnetInferenceRpc("https://rpc.example.invalid", signer.address),
        {
          rpc: rpc.rpc,
          beforeSigning: rpc.beforeSigning,
          sendExact: rpc.sendExact,
          status: rpc.status,
        },
      )
    : rpc;
  const path = join(dir, "journal", "transactions.json"),
    journal = new SubmissionJournal(path, transport, {
      outsideGit(p) {
        assert.ok(p.startsWith(dir + "/"));
      },
      privateDirectory(p) {
        assert.ok(p.startsWith(dir + "/"));
        mkdirSync(p, { recursive: true, mode: 0o700 });
        return p as PrivateDirectory;
      },
    });
  await journal.initialize({
    available: "1000000",
    feeAllowance: "100000",
    rentAllowance: "100000",
    cleanupReserve: "100000",
  });
  const sender = new UploadTransactionSender({
    rpc: transport,
    signer,
    progress: {
      log() {},
      async run<T>(_label: string, action: () => Promise<T>) {
        return action();
      },
    },
    confirmation: { timeoutMs: 50, pollMs: 1, pendingWindow: 4 },
  });
  const ix: Instruction = {
    programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    data: Uint8Array.of(1),
  };
  return {
    sender,
    control,
    journal,
    ix,
    read: () => JSON.parse(readFileSync(path, "utf8")),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("upload sender records exact grouped wire and only finalized fees", async () => {
  const f = await fixture();
  try {
    const r = await f.sender.send("upload", [f.ix, f.ix], f.journal, {
      rent: 123n,
    });
    assert.ok(r.wireBytes <= 1232);
    assert.equal(r.finalized, false);
    assert.equal(f.sender.totalFees, 0n);
    assert.equal(f.read().transactions[0].rent, "123");
    f.control.finalized = true;
    await f.sender.checkpoint();
    assert.equal(f.sender.totalFees, 5000n);
    assert.equal(f.sender.pendingCount, 0);
    assert.equal(f.read().transactions[0].state, "finalized");
    await f.sender.checkpoint();
    assert.equal(f.sender.totalFees, 5000n);
    await assert.rejects(
      f.sender.send("upload", f.ix, f.journal),
      /sender_operation/,
    );
  } finally {
    f.close();
  }
});
test("lost reply preserves reserved wire and blocks replacement until exact finality", async () => {
  const f = await fixture();
  try {
    f.control.lostReply = true;
    await assert.rejects(
      f.sender.send("upload", f.ix, f.journal),
      /lost_reply/,
    );
    await assert.rejects(
      f.sender.send("replacement", f.ix, f.journal),
      /checkpoint_required/,
    );
    assert.equal(f.read().transactions[0].state, "reserved");
    assert.equal(f.control.sends, 1);
    f.control.finalized = true;
    await f.sender.checkpoint();
    assert.equal(f.sender.totalFees, 5000n);
    assert.equal(f.control.sends, 1);
  } finally {
    f.close();
  }
});
test("pruned receipt cannot release reservation or start recovery sends", async () => {
  const f = await fixture();
  try {
    f.control.pruned = true;
    await assert.rejects(
      f.sender.send("upload", f.ix, f.journal),
      /receipt_pruned/,
    );
    f.control.finalized = true;
    await assert.rejects(f.sender.checkpoint(), /receipt_pruned/);
    await assert.rejects(
      f.sender.send("cleanup", f.ix, f.journal),
      /checkpoint_required/,
    );
    assert.equal(f.read().transactions[0].state, "broadcast");
  } finally {
    f.close();
  }
});
test("changed finalized metadata fails closed", async () => {
  const f = await fixture();
  try {
    await f.sender.send("upload", f.ix, f.journal);
    f.control.finalized = true;
    f.control.changed = true;
    await assert.rejects(f.sender.checkpoint(), /receipt_changed/);
    assert.equal(f.sender.totalFees, 0n);
    assert.equal(f.read().transactions[0].state, "broadcast");
  } finally {
    f.close();
  }
});
test("finalized execution failure is billed and reconciled before recovery", async () => {
  const f = await fixture();
  try {
    f.control.failed = true;
    await assert.rejects(
      f.sender.send("upload", f.ix, f.journal),
      /transaction_failed/,
    );
    f.control.finalized = true;
    await f.sender.checkpoint();
    assert.equal(f.sender.totalFees, 5000n);
    assert.equal(f.sender.transactions[0].failed, true);
    assert.equal(f.read().transactions[0].state, "failed");
  } finally {
    f.close();
  }
});
test("oversized wires and compute budget overrides never broadcast", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.sender.send(
        "oversize",
        { ...f.ix, data: new Uint8Array(1232) },
        f.journal,
      ),
      /wire_limit/,
    );
    await assert.rejects(
      f.sender.send(
        "override",
        {
          programAddress: address(
            "ComputeBudget111111111111111111111111111111",
          ),
        },
        f.journal,
      ),
      /instruction_count_or_budget/,
    );
    assert.equal(f.control.sends, 0);
    assert.equal(f.sender.pendingCount, 0);
  } finally {
    f.close();
  }
});

test("mainnet upload sender finalizes journal and records actual fees", async () => {
  const f = await fixture(true);
  try {
    await f.sender.send("mainnet-upload", f.ix, f.journal, { rent: 123n });
    f.control.finalized = true;
    await f.sender.checkpoint();
    assert.equal(f.read().transactions[0].state, "finalized");
    assert.equal(f.sender.totalFees, 5000n);
  } finally {
    f.close();
  }
});

test("mainnet lost reply preserves the signed transaction and blocks replacements", async () => {
  const f = await fixture(true);
  try {
    f.control.lostReply = true;
    await assert.rejects(
      f.sender.send("mainnet-upload", f.ix, f.journal),
      /lost_reply/,
    );
    assert.equal(f.read().transactions[0].state, "reserved");
    await assert.rejects(
      f.sender.send("replacement", f.ix, f.journal),
      /checkpoint_required/,
    );
    assert.equal(f.control.sends, 1);
  } finally {
    f.close();
  }
});
