import test from "node:test";
import assert from "node:assert/strict";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  generateKeyPairSigner,
  getAddressDecoder,
  getTransactionEncoder,
  createTransactionMessage,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  compileTransaction,
  signTransaction,
  lamports,
} from "@solana/kit";
import { verifiedBinary } from "../build.mjs";
import {
  dot,
  silu,
  softmax,
  quantizeQ8_0Reference,
  dotQ8_0Reference,
} from "../../../private-inference/reference/numeric";
async function harness() {
  const binary = verifiedBinary(),
    svm = new LiteSVM();
  const program = getAddressDecoder().decode(new Uint8Array(32).fill(98));
  svm.addProgram(program, binary);
  const payer = await generateKeyPairSigner();
  svm.airdrop(payer.address, lamports(1000000000n));
  async function execute(data: Uint8Array) {
    svm.expireBlockhash();
    const tx = await signTransaction(
      [payer.keyPair],
      compileTransaction(
        appendTransactionMessageInstruction(
          { programAddress: program, data },
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: svm.latestBlockhash(),
              lastValidBlockHeight: 1000000n,
            },
            setTransactionMessageFeePayer(
              payer.address,
              setTransactionMessageConfig(
                {
                  computeUnitLimit: 200000,
                  heapSize: 32768,
                  loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
                },
                createTransactionMessage({ version: 1 }),
              ),
            ),
          ),
        ),
      ),
    );
    return {
      result: svm.sendTransaction(tx),
      bytes: getTransactionEncoder().encode(tx).length,
    };
  }
  return { execute, binary };
}

test("compiled SBF scalar public kernels match independent numeric reference", async () => {
  const h = await harness();
  let worst = 0;
  for (let round = 0; round < 12; round++) {
    const a = Array.from({ length: 32 }, (_, i) =>
      Math.fround(Math.sin(i + round) * 4),
    );
    const b = Array.from({ length: 32 }, (_, i) =>
      Math.fround(Math.cos(i * 2 + round) * 2),
    );
    const f32 = (v: number[]) => {
      const out = Buffer.alloc(v.length * 4);
      v.forEach((x, i) => out.writeFloatLE(x, i * 4));
      return out;
    };
    const q = quantizeQ8_0Reference(a);
    for (const [opcode, data, expected] of [
      [0, Buffer.concat([f32(a), f32(b)]), [dot(a, b)]],
      [1, f32(a), a.map(silu)],
      [
        2,
        Buffer.concat([q, f32(b)]),
        [dotQ8_0Reference(q, quantizeQ8_0Reference(b))],
      ],
    ] as const) {
      const { result, bytes } = await h.execute(
        Buffer.concat([Buffer.of(opcode, 32), data]),
      );
      if (result instanceof FailedTransactionMetadata)
        assert.fail(String(result.err()));
      assert.ok(bytes <= 1232);
      const out = Buffer.from(result.returnData().data());
      expected.forEach((v, i) =>
        assert.equal(out.readUInt32LE(i * 4), f32([v]).readUInt32LE(0)),
      );
      worst = Math.max(worst, Number(result.computeUnitsConsumed()));
      console.log(
        JSON.stringify({
          stage: "public-kernel",
          opcode,
          round,
          cu: Number(result.computeUnitsConsumed()),
          txBytes: bytes,
        }),
      );
    }
  }
  assert.ok(worst <= 200000);
});

test("quantize once and batch full128column Q8 rows under default limits", async () => {
  const h = await harness();
  const values = Array.from({ length: 128 }, (_, i) =>
    Math.fround(Math.sin(i) * 2),
  );
  const weight = quantizeQ8_0Reference(values);
  const input = Buffer.alloc(512);
  values.forEach((x, i) => input.writeFloatLE(x, i * 4));
  for (const rows of [1, 4, 8, 16, 32]) {
    const { result, bytes } = await h.execute(
      Buffer.concat([Buffer.of(3, rows), weight, input]),
    );
    if (result instanceof FailedTransactionMetadata)
      assert.fail(String(result.err()));
    assert.ok(bytes <= 1232);
    assert.equal(result.returnData().data().length, rows * 4);
    console.log(
      JSON.stringify({
        stage: "public-Q8-rows",
        rows,
        columns: 128,
        cu: Number(result.computeUnitsConsumed()),
        txBytes: bytes,
      }),
    );
  }
});

test("SBF rotary pairs and context16 softmax match independent scalar operations", async () => {
  const h = await harness();
  const x = Array.from({ length: 16 }, (_, i) => Math.fround(Math.sin(i) * 2));
  const bytes = Buffer.alloc(64);
  x.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
  const rotary = [...x];
  for (let i = 0; i < 8; i++) {
    const a = Math.fround(7 * 10000 ** ((-2 * i) / 16)),
      c = Math.fround(Math.cos(a)),
      s = Math.fround(Math.sin(a));
    rotary[2 * i] = Math.fround(
      Math.fround(x[2 * i] * c) - Math.fround(x[2 * i + 1] * s),
    );
    rotary[2 * i + 1] = Math.fround(
      Math.fround(x[2 * i] * s) + Math.fround(x[2 * i + 1] * c),
    );
  }
  for (const [opcode, expected] of [
    [4, rotary],
    [5, softmax(x)],
  ] as const) {
    const { result } = await h.execute(
      Buffer.concat([Buffer.of(opcode, 16), bytes]),
    );
    if (result instanceof FailedTransactionMetadata)
      assert.fail(String(result.err()));
    const actual = Buffer.from(result.returnData().data());
    expected.forEach((v, i) => assert.equal(actual.readFloatLE(i * 4), v));
    console.log(
      JSON.stringify({
        stage: "public-nonlinear",
        opcode,
        cu: Number(result.computeUnitsConsumed()),
      }),
    );
  }
});
