import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import vectors from "./fixtures/response-receipt-v1.json";
import {
  canonicalPayload,
  hashPayload,
  memo,
  parseStrict,
  validatePayload,
  validateReceipt,
  PREFIX,
} from "../runtime/receipt";
import { memoPublisher, type RpcCall } from "../runtime/publisher";
const sig = getBase58Decoder().decode(new Uint8Array(64).fill(7));
test("shared canonical bytes, hashes and memos; strict negative inputs", () => {
  for (const v of vectors.vectors) {
    assert.equal(canonicalPayload(v.payload), v.canonicalJson);
    assert.equal(
      Buffer.from(PREFIX + canonicalPayload(v.payload)).toString("hex"),
      v.preimageHex,
    );
    assert.equal(hashPayload(v.payload), v.receiptHash);
    assert.equal(memo(v.receiptHash), v.memo);
    assert.equal(
      validateReceipt({
        payload: v.payload,
        receiptHash: v.receiptHash,
        transactionSignature: sig,
      }).payload.reply,
      v.payload.reply,
    );
    assert.throws(() =>
      validateReceipt({
        payload: { ...v.payload, reply: v.payload.reply + "!" },
        receiptHash: v.receiptHash,
        transactionSignature: sig,
      }),
    );
  }
  for (const s of [
    '{"version":1,"version":1}',
    '{"a":{"x":1,"x":2}}',
    '{"a":"\\ud800"}',
    '{"x":1,}',
    "\ufeff{}",
  ])
    assert.throws(() => parseStrict(s));
  assert.throws(() => parseStrict(Uint8Array.from([0xff])));
  for (const p of [
    { ...vectors.vectors[0].payload, extra: 1 },
    { ...vectors.vectors[0].payload, version: "1" },
    { ...vectors.vectors[0].payload, nonce: "A".repeat(64) },
    { ...vectors.vectors[0].payload, reply: "a".repeat(65537) },
    { ...vectors.vectors[0].payload, reply: "\ud800" },
  ])
    assert.throws(() => validatePayload(p));
});
test("real signed memo shape, finalization gate, failed/wrong network and expiry checks", async () => {
  const signer = await generateKeyPairSigner(false);
  let genesis = "test",
    wire: string | undefined,
    final = false,
    height = 1,
    error: unknown = null;
  const hash = "a".repeat(64);
  let sent = 0;
  const rpc: RpcCall = async <T>(method: string, params: unknown[] = []) => {
    let result: unknown;
    switch (method) {
      case "getGenesisHash":
        result = genesis;
        break;
      case "getLatestBlockhash":
        result = {
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 10,
          },
        };
        break;
      case "getFeeForMessage":
        result = { value: 5000 };
        break;
      case "getBlockHeight":
        result = height;
        break;
      case "getTransaction":
        result = final
          ? {
              slot: 10,
              version: "legacy",
              meta: { err: error },
              transaction: [wire, "base64"],
            }
          : null;
        break;
      case "getSignatureStatuses":
        result = { value: [null] };
        break;
      case "sendTransaction":
        sent++;
        wire = params[0] as string;
        result = "ok";
        break;
      default:
        throw new Error(method);
    }
    return result as T;
  };
  const publisher = memoPublisher({
    rpc,
    signer,
    network: "localnet",
    genesisHash: "test",
    forbiddenAuthorities: ["11111111111111111111111111111111"],
    maxFeeLamports: 5000n,
  });
  const signed = await publisher.prepare(hash);
  assert.equal((await publisher.inspect(signed, hash)).state, "pending");
  await publisher.broadcast(signed);
  assert.equal(sent, 1);
  final = true;
  assert.equal((await publisher.inspect(signed, hash)).state, "finalized");
  error = { InstructionError: [0, 1] };
  assert.equal((await publisher.inspect(signed, hash)).state, "failed");
  final = false;
  height = 11;
  assert.equal((await publisher.inspect(signed, hash)).state, "uncertain");
  await publisher.broadcast(signed);
  assert.equal(sent, 1);
  genesis = "wrong";
  await assert.rejects(publisher.inspect(signed, hash), /wrong_network/);
  assert.throws(
    () =>
      memoPublisher({
        rpc,
        signer,
        network: "localnet",
        genesisHash: "test",
        forbiddenAuthorities: [signer.address],
        maxFeeLamports: 5000n,
      }),
    /separate/,
  );
});
