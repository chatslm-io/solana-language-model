import test from "node:test";
import assert from "node:assert/strict";
import {
  address,
  getTransactionDecoder,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { createLifecycleHarness } from "../harness/local-sbf";
import { memoPublisher, MEMO, type RpcCall } from "../../runtime/publisher";

test("publisher signs wrapper bytes, executes real CPI, checks inner evidence and resumes legacy journal bytes", async () => {
  const h = await createLifecycleHarness();
  let wire = "";
  let inner: {
    index: number;
    instructions: {
      programIdIndex: number;
      accounts: number[];
      data: string;
      stackHeight: number;
    }[];
  }[] = [];
  let final = false;
  const rpc: RpcCall = async <T>(method: string, params: unknown[] = []) => {
    let value: unknown;
    switch (method) {
      case "getGenesisHash":
        value = "local";
        break;
      case "getAccountInfo":
        value = { value: h.svm.getAccount(h.program) };
        break;
      case "getLatestBlockhash":
        h.svm.expireBlockhash();
        value = {
          value: {
            blockhash: h.svm.latestBlockhash(),
            lastValidBlockHeight: 1000000,
          },
        };
        break;
      case "getFeeForMessage":
        value = { value: 5000 };
        break;
      case "getBlockHeight":
        value = 0;
        break;
      case "sendTransaction": {
        wire = params[0] as string;
        const result = h.svm.sendTransaction(
          getTransactionDecoder().decode(Buffer.from(wire, "base64")),
        );
        assert.ok(
          !(result instanceof FailedTransactionMetadata),
          result instanceof FailedTransactionMetadata
            ? result.meta().logs().join("\n")
            : "",
        );
        inner = result.innerInstructions().map((group, index) => ({
          index,
          instructions: group.map((item) => ({
            programIdIndex: item.instruction().programIdIndex(),
            accounts: [...item.instruction().accounts()],
            data: getBase58Decoder().decode(item.instruction().data()),
            stackHeight: item.stackHeight(),
          })),
        }));
        final = true;
        value = "ok";
        break;
      }
      case "getTransaction":
        value = final
          ? {
              slot: 1,
              version: "legacy",
              meta: { err: null, innerInstructions: inner },
              transaction: [wire, "base64"],
            }
          : null;
        break;
      case "getSignatureStatuses":
        value = { value: [null] };
        break;
      default:
        throw Error(method);
    }
    return value as T;
  };
  const options = {
    rpc,
    signer: h.owner,
    network: "localnet",
    genesisHash: "local",
    forbiddenAuthorities: ["11111111111111111111111111111111"],
    maxFeeLamports: 5000n,
  };
  const publisher = memoPublisher({ ...options, programId: h.program });
  const hash = "ab".repeat(32),
    signed = await publisher.prepare(hash);
  const decoded = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(Buffer.from(signed.wire, "base64"))
      .messageBytes,
  );
  assert.ok(decoded.version === "legacy");
  assert.equal(
    decoded.staticAccounts[decoded.instructions[0].programAddressIndex],
    h.program,
  );
  assert.ok(decoded.staticAccounts.includes(address(MEMO)));
  // A fresh publisher verifies and reuses the exact journaled receipt bytes.
  await memoPublisher({ ...options, programId: h.program }).broadcast(signed);
  assert.equal((await publisher.inspect(signed, hash)).state, "finalized");
  for (const [offset, value] of [
    [5, 2],
    [6, 1],
    [7, 1],
  ] as const) {
    const bytes = Buffer.from(signed.wire, "base64");
    const at = bytes.indexOf(Buffer.from(decoded.instructions[0].data!));
    assert.ok(at > 0);
    bytes[at + offset] = value;
    await assert.rejects(
      publisher.broadcast({ ...signed, wire: bytes.toString("base64") }),
    );
  }
  const genuine = structuredClone(inner);
  const memoGroup = inner.findIndex((g) => g.instructions.length > 0);
  assert.equal(inner[memoGroup].index, 0);
  assert.equal(decoded.instructions.length, 1);
  assert.equal(decoded.instructions[0].data!.length, 40);
  for (const mutate of [
    () => {
      inner = [];
    },
    () => {
      inner[memoGroup].instructions[0].stackHeight = 3;
    },
    () => {
      inner[memoGroup].instructions[0].accounts = [];
    },
    () => {
      inner[memoGroup].index = 1;
    },
    () => {
      inner[memoGroup].instructions[0].data = getBase58Decoder().decode(
        Buffer.from("slm:receipt:v1:" + "cd".repeat(32)),
      );
    },
  ]) {
    inner = structuredClone(genuine);
    mutate();
    await assert.rejects(
      publisher.inspect(signed, hash),
      /invalid_finalized_evidence/,
    );
  }
  inner = genuine;
  await assert.rejects(
    publisher.inspect(signed, "cd".repeat(32)),
    /invalid_saved_memo/,
  );
  const legacy = await memoPublisher(options).prepare(hash);
  await publisher.broadcast(legacy);
  assert.equal((await publisher.inspect(legacy, hash)).state, "finalized");
  await assert.rejects(
    memoPublisher({
      ...options,
      maxFeeLamports: 4999n,
      programId: h.program,
    }).prepare(hash),
    /fee_limit/,
  );
});
