import test from "node:test";
import assert from "node:assert/strict";
import { ristretto255 } from "@noble/curves/ed25519";
import {
  address,
  generateKeyPairSigner,
  createTransactionMessage,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransaction,
  signTransaction,
  getTransactionEncoder,
  getTransactionDecoder,
  getBase58Decoder,
  type Instruction,
} from "@solana/kit";
import {
  createPrivateLinearKey,
  privateLinearInstruction,
  parseRequest,
  requestDigest,
  MODEL_ID,
  WEIGHTS,
  BIAS,
} from "../lib/private-linear";
import {
  verifyFinalizedPrivateLinear,
  type ExpectedPrivateLinearExecution,
  type RpcCall,
} from "../lib/private-linear/devnet-proof";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const OTHER_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM = "BPFLoaderUpgradeab1e11111111111111111111111";
const P = ristretto255.Point;
async function fixture(extra?: Instruction) {
  const caller = await generateKeyPairSigner();
  const key = createPrivateLinearKey();
  const request = key.encrypt([1, 2, 3, 4]);
  key.destroy();
  let R = P.ZERO,
    C = P.BASE.multiply(BigInt(BIAS));
  for (const [i, input] of parseRequest(request).inputs.entries()) {
    let r = P.fromBytes(input.r).multiply(BigInt(Math.abs(WEIGHTS[i]))),
      c = P.fromBytes(input.c).multiply(BigInt(Math.abs(WEIGHTS[i])));
    if (WEIGHTS[i] < 0) {
      r = r.negate();
      c = c.negate();
    }
    R = R.add(r);
    C = C.add(c);
  }
  const output = Buffer.concat([
    Buffer.from("SLMHEO01"),
    Buffer.from(MODEL_ID, "hex"),
    requestDigest(caller.address, request),
    R.toBytes(),
    C.toBytes(),
  ]);
  const message = appendTransactionMessageInstruction(
    privateLinearInstruction(PROGRAM, caller.address, request),
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: GENESIS as never, lastValidBlockHeight: 100n },
      setTransactionMessageFeePayer(
        caller.address,
        setTransactionMessageConfig(
          {
            computeUnitLimit: 200000,
            loadedAccountsDataSizeLimit: 64 * 1024 ** 2,
            priorityFeeLamports: 0n,
          },
          createTransactionMessage({ version: 1 }),
        ),
      ),
    ),
  );
  const signed = await signTransaction(
    [caller.keyPair],
    compileTransaction(
      extra ? appendTransactionMessageInstruction(extra, message) : message,
    ),
  );
  const signature = getBase58Decoder().decode(
    signed.signatures[caller.address]!,
  );
  const tx = {
    slot: 123,
    version: 1,
    transaction: [
      Buffer.from(getTransactionEncoder().encode(signed)).toString("base64"),
      "base64",
    ],
    meta: {
      err: null as unknown,
      fee: 5000,
      innerInstructions: [] as unknown[],
      returnData: {
        programId: PROGRAM,
        data: [output.toString("base64"), "base64"],
      },
      loadedAddresses: { readonly: [], writable: [] },
    },
  };
  const expected: ExpectedPrivateLinearExecution = {
    program: PROGRAM,
    caller: caller.address,
    request,
    genesisHash: GENESIS,
    maxFeeLamports: 5000n,
  };
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: RpcCall = async <T>(
    method: string,
    params: unknown[] = [],
  ): Promise<T> => {
    calls.push({ method, params });
    if (method === "getGenesisHash") return GENESIS as T;
    if (method === "getTransaction") return tx as T;
    throw Error("unexpected_rpc_method");
  };
  return { tx, expected, rpc, signature, calls, output };
}
test("real signed v1 request is verified only through exact successful finalized transaction return data", async () => {
  const f = await fixture();
  const evidence = await verifyFinalizedPrivateLinear(
    f.rpc,
    f.signature,
    f.expected,
  );
  assert.equal(evidence.slot, 123);
  assert.equal(evidence.fee, 5000n);
  assert.deepEqual(Buffer.from(evidence.output), f.output);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["getGenesisHash", "getTransaction", "getGenesisHash"],
  );
  assert.deepEqual(f.calls[1].params, [
    f.signature,
    {
      encoding: "base64",
      commitment: "finalized",
      maxSupportedTransactionVersion: 1,
    },
  ]);
});
test("wrong or changing network and absent finalized transaction fail closed", async () => {
  const f = await fixture();
  let genesisCalls = 0;
  for (const changeAfterFirst of [false, true]) {
    genesisCalls = 0;
    const rpc: RpcCall = async <T>(method: string, params: unknown[] = []) =>
      method === "getGenesisHash"
        ? ((++genesisCalls === 1 && changeAfterFirst
            ? GENESIS
            : OTHER_GENESIS) as T)
        : f.rpc<T>(method, params);
    await assert.rejects(
      verifyFinalizedPrivateLinear(rpc, f.signature, f.expected),
      /wrong_network/,
    );
  }
  const absent: RpcCall = async <T>(method: string) =>
    (method === "getGenesisHash" ? GENESIS : null) as T;
  await assert.rejects(
    verifyFinalizedPrivateLinear(absent, f.signature, f.expected),
    /not_finalized/,
  );
});
test("failed execution, missing return data/traces, wrong program, extra CPI and unsupported version reject", async () => {
  const base = await fixture();
  const attacks: ((tx: typeof base.tx) => void)[] = [
    (tx) => {
      tx.meta.err = { InstructionError: [0, "Custom"] };
    },
    (tx) => {
      tx.meta.returnData = undefined as never;
    },
    (tx) => {
      tx.meta.innerInstructions = null as never;
    },
    (tx) => {
      tx.meta.returnData.programId = "11111111111111111111111111111111";
    },
    (tx) => {
      tx.meta.innerInstructions = [
        { index: 0, instructions: [{ programId: "arbitrary" }] },
      ];
    },
    (tx) => {
      tx.version = 0;
    },
    (tx) => {
      tx.slot = -1;
    },
    (tx) => {
      tx.meta.fee = -1;
    },
    (tx) => {
      tx.meta.loadedAddresses.readonly = [PROGRAM] as never;
    },
    (tx) => {
      tx.transaction[1] = "json";
    },
    (tx) => {
      tx.transaction[0] += "\n";
    },
    (tx) => {
      tx.meta.returnData.data[1] = "base58";
    },
    (tx) => {
      tx.meta.returnData.data[0] = Buffer.alloc(135).toString("base64");
    },
  ];
  for (const mutate of attacks) {
    const tx = structuredClone(base.tx);
    mutate(tx);
    const rpc: RpcCall = async <T>(method: string) =>
      (method === "getGenesisHash" ? GENESIS : tx) as T;
    await assert.rejects(
      verifyFinalizedPrivateLinear(rpc, base.signature, base.expected),
      /invalid_finalized_evidence/,
    );
  }
});
test("exact ciphertext request, caller signature and output binding must agree", async () => {
  const f = await fixture();
  const changed = Uint8Array.from(f.expected.request);
  changed[40] ^= 1;
  await assert.rejects(
    verifyFinalizedPrivateLinear(f.rpc, f.signature, {
      ...f.expected,
      request: changed,
    }),
    /invalid_finalized_evidence/,
  );
  const other = await generateKeyPairSigner();
  await assert.rejects(
    verifyFinalizedPrivateLinear(f.rpc, f.signature, {
      ...f.expected,
      caller: other.address,
    }),
    /invalid_finalized_evidence/,
  );
  await assert.rejects(
    verifyFinalizedPrivateLinear(f.rpc, f.signature, {
      ...f.expected,
      maxFeeLamports: 4999n,
    }),
    /finalized_fee_exceeded/,
  );
  const tampered = Buffer.from(f.tx.meta.returnData.data[0], "base64");
  tampered[40] ^= 1;
  f.tx.meta.returnData.data[0] = tampered.toString("base64");
  await assert.rejects(
    verifyFinalizedPrivateLinear(f.rpc, f.signature, f.expected),
    /invalid_finalized_evidence/,
  );
});
test("forged RPC success cannot authenticate an invalid Ed25519 transaction signature", async () => {
  const f = await fixture();
  const wire = Buffer.from(f.tx.transaction[0], "base64");
  wire[wire.length - 1] ^= 1;
  const forged = getTransactionDecoder().decode(wire);
  const signature = getBase58Decoder().decode(
    forged.signatures[address(f.expected.caller)]!,
  );
  f.tx.transaction[0] = wire.toString("base64");
  await assert.rejects(
    verifyFinalizedPrivateLinear(f.rpc, signature, f.expected),
    /invalid_finalized_evidence/,
  );
  await assert.rejects(
    verifyFinalizedPrivateLinear(f.rpc, f.signature, f.expected),
    /invalid_finalized_evidence/,
  );
});
test("extra instructions including v1 ComputeBudget instructions are never accepted", async () => {
  for (const programAddress of [
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    "ComputeBudget111111111111111111111111111111",
  ]) {
    const f = await fixture({
      programAddress: address(programAddress),
      data: new Uint8Array([2, 0, 0, 0, 0]),
    });
    await assert.rejects(
      verifyFinalizedPrivateLinear(f.rpc, f.signature, f.expected),
      /invalid_finalized_evidence/,
    );
  }
});
