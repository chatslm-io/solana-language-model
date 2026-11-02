import { approvedTestSigner } from "../../tests/approved-test-signer";
import test from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  type Address,
  type Instruction,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { createLifecycleHarness } from "../harness/local-sbf";
import { prepareModelFixture } from "../harness/model-fixture";
import { prepareTokenizerFixture } from "../harness/tokenizer-fixture";
import { tokenizerClient } from "../harness/tokenizer-client";
import { encodeRawMessages } from "../client/tokenizer-frame";
import { tokenizerBucket } from "../compiler/tokenizer";
import {
  buildTokenizerPages,
  encodeTokenizerBinding,
  tokenizerCommitment,
} from "../tokenizer-protocol";
import { u32 } from "../harness/client";
const progress = (message: string) =>
  process.stderr.write(`[tokenizer bounds SBF] ${message}\n`);
let prepared: ReturnType<typeof prepareModelFixture> | undefined;
async function fixture(syntheticBucket: false | "absent" | "repeat" = false) {
  prepared ??= prepareModelFixture(
    undefined,
    progress,
    undefined,
    await approvedTestSigner(),
  );
  const f = await prepared;
  let t = await prepareTokenizerFixture(f);
  if (syntheticBucket) {
    // Deliberately synthetic authenticated table root for the accepted511-record
    // resource bound only. This is NOT tokenizer conformance/model evidence.
    const payloads = t.tables.pages.map((page) => Buffer.from(page.payload));
    const lhs = payloads[0].readUInt32LE(96 + 97 * 4),
      rhs = payloads[0].readUInt32LE(
        96 + (syntheticBucket === "repeat" ? 97 : 98) * 4,
      ),
      bucket = tokenizerBucket(lhs, rhs);
    const payload = Buffer.alloc(16 + 511 * 16);
    payload.write("SLMPTB01");
    payload.writeUInt32LE(bucket, 8);
    payload.writeUInt32LE(511, 12);
    let count = 0;
    if (syntheticBucket === "repeat") {
      [lhs, rhs, (lhs + 1) % 8192, 0].forEach((value, i) =>
        payload.writeUInt32LE(value, 16 + i * 4),
      );
      count = 1;
    }
    for (let left = 0; left < 8192 && count < 511; left++)
      for (let right = 0; right < 8192 && count < 511; right++)
        if (
          tokenizerBucket(left, right) === bucket &&
          !(left === lhs && right === rhs)
        ) {
          [left, right, left, count].forEach((value, i) =>
            payload.writeUInt32LE(value, 16 + count * 16 + i * 4),
          );
          count++;
        }
    assert.equal(count, 511);
    payloads[1 + bucket] = payload;
    const tables = buildTokenizerPages(payloads),
      binding = { ...t.binding, tableRoot: tables.root },
      client = await tokenizerClient(f, binding),
      enc = getAddressEncoder(),
      hash = Buffer.from(tokenizerCommitment(binding), "hex"),
      accounts: typeof t.accounts = [];
    const [, bump] = await getProgramDerivedAddress({
      programAddress: f.program,
      seeds: [
        Buffer.from("slm-pu-tokenizer"),
        enc.encode(f.client.model),
        Buffer.from(tables.root, "hex"),
      ],
    });
    const registry = Buffer.alloc(384);
    registry.write("SLMPTR01");
    registry[8] = 1;
    registry[9] = 5;
    registry[10] = 1;
    registry[11] = bump;
    registry.set(enc.encode(f.signer.address), 16);
    registry.set(enc.encode(f.client.model), 48);
    registry.set(hash, 80);
    registry.set(Buffer.from(tables.root, "hex"), 112);
    [33, 33, 33].forEach((v, i) => registry.writeUInt32LE(v, 144 + i * 4));
    registry.set(encodeTokenizerBinding(binding), 160);
    accounts.push({
      address: client.registry,
      data: registry,
      lamports: 100000000n,
    });
    for (const page of tables.pages) {
      const [address, bump] = await getProgramDerivedAddress({
          programAddress: f.program,
          seeds: [
            Buffer.from("slm-pu-tokpage"),
            enc.encode(client.registry),
            u32(page.index),
          ],
        }),
        d = Buffer.alloc(192 + page.payload.length);
      d.write("SLMPTP01");
      d[8] = 1;
      d[9] = 6;
      d[10] = 1;
      d[11] = bump;
      d.set(enc.encode(f.signer.address), 16);
      d.set(enc.encode(client.registry), 48);
      [page.index, page.payload.length, page.payload.length, 1].forEach(
        (v, i) => d.writeUInt32LE(v, 80 + i * 4),
      );
      d.set(Buffer.from(page.hash, "hex"), 96);
      d.set(hash, 128);
      d.set(page.payload, 192);
      accounts.push({ address, data: d, lamports: 100000000n });
    }
    t = { ...t, tables, binding, client, accounts };
  }
  const h = await createLifecycleHarness();
  h.svm.airdrop(f.signer.address, lamports(100000000000n));
  for (const a of [...f.accounts, ...t.accounts])
    h.svm.setAccount({
      address: a.address,
      data: a.data,
      programAddress: f.program,
      lamports: lamports(a.lamports),
      space: BigInt(a.data.length),
      executable: false,
    });
  const get = (address: Address) => {
    const a = h.svm.getAccount(address);
    assert.ok(a.exists);
    return Buffer.from(a.data);
  };
  const send = async (ix: Instruction) => {
    const { result, wireBytes } = await h.execute(ix, f.signer);
    if (result instanceof FailedTransactionMetadata)
      assert.fail(`${result.err()} ${result.meta().logs().join(" ")}`);
    assert.ok(result.computeUnitsConsumed() <= 200000n);
    assert.ok(wireBytes <= 1232);
    return Number(result.computeUnitsConsumed());
  };
  const begin = async (frame: Uint8Array, delegate = f.signer.address) => {
    await send(
      t.client.createText(frame, 1, h.svm.getClock().slot + 200000n, delegate),
    );
    await send(t.client.writeRaw(0, frame));
    await send(t.client.sealRaw());
  };
  const recover = async () => {
    await send(t.client.closeText());
    await send(f.client.closeSession());
    assert.equal(h.svm.getAccount(t.client.scratch).exists, false);
    assert.equal(h.svm.getAccount(f.client.session).exists, false);
  };
  return { f, t, h, get, send, begin, recover };
}
test(
  "512-byte ASCII and emoji paths stay bounded; context overflow is atomic and owner-recoverable",
  { timeout: 120000 },
  async () => {
    for (const content of ["a".repeat(512), "😀".repeat(128)]) {
      const x = await fixture(),
        { f, t, h, get, begin, recover } = x;
      await begin(encodeRawMessages([{ role: "user", content }]));
      const maxima = new Map<number, number>();
      let failed = false,
        steps = 0;
      for (; steps < 133000; steps++) {
        const before = get(t.client.scratch),
          sessionBefore = get(f.client.session),
          phase = before.readUInt32LE(804 + 8);
        const { result } = await h.execute(
          await t.client.step(before),
          f.signer,
        );
        if (result instanceof FailedTransactionMetadata) {
          assert.match(
            String(result.err()),
            /InstructionErrorCustom \{ code: 30 \}/,
          );
          assert.ok(before.equals(get(t.client.scratch)));
          assert.ok(sessionBefore.equals(get(f.client.session)));
          failed = true;
          break;
        }
        const cu = Number(result.computeUnitsConsumed());
        assert.ok(cu <= 200000);
        maxima.set(phase, Math.max(maxima.get(phase) ?? 0, cu));
      }
      assert.ok(failed);
      assert.equal(get(f.client.session).readUInt32LE(244), 0);
      assert.ok(maxima.has(1) && maxima.has(2) && maxima.has(3));
      await recover();
      progress(
        JSON.stringify({
          rawBytes: 512,
          kind: content.startsWith("a") ? "ASCII" : "emoji",
          steps,
          maxCuByPhase: Object.fromEntries(maxima),
          atomicContextRejection: true,
          recovered: true,
        }),
      );
    }
  },
);
test(
  "largest accepted511-record authenticated bucket stays under default CU; wrong page and delegate close reject unchanged",
  { timeout: 120000 },
  async () => {
    const x = await fixture("absent"),
      { f, t, h, get, send, begin, recover } = x;
    await begin(
      encodeRawMessages([{ role: "user", content: "ab" }]),
      h.other.address,
    );
    while (get(t.client.scratch).readUInt32LE(812) !== 3)
      await send(await t.client.step(get(t.client.scratch)));
    const before = get(t.client.scratch),
      good = await t.client.step(before),
      accounts = [...good.accounts!];
    accounts[4] = { ...accounts[4], address: await t.client.page(0) };
    const wrong = await h.execute({ ...good, accounts }, f.signer);
    assert.ok(wrong.result instanceof FailedTransactionMetadata);
    assert.ok(before.equals(get(t.client.scratch)));
    const close = t.client.closeText(),
      delegated = {
        ...close,
        accounts: [
          { address: h.other.address, role: AccountRole.WRITABLE_SIGNER },
          ...close.accounts!.slice(1),
        ],
      };
    const rejected = await h.execute(delegated, h.other);
    assert.ok(rejected.result instanceof FailedTransactionMetadata);
    assert.ok(before.equals(get(t.client.scratch)));
    const cu = await send(good);
    while (get(t.client.scratch)[10] !== 2)
      await send(await t.client.step(get(t.client.scratch)));
    await recover();
    progress(
      JSON.stringify({
        syntheticBucketEntries: 511,
        lookupCu: cu,
        wrongPageRejected: true,
        delegateCloseRejected: true,
        recovered: true,
      }),
    );
  },
);
test(
  "four empty role messages are wrapped entirely in SBF",
  { timeout: 120000 },
  async () => {
    const x = await fixture(),
      { f, t, get, send, begin, recover } = x;
    await begin(
      encodeRawMessages([
        { role: "system", content: "" },
        { role: "user", content: "" },
        { role: "assistant", content: "" },
        { role: "user", content: "" },
      ]),
    );
    let steps = 0;
    while (get(t.client.scratch)[10] !== 2) {
      await send(await t.client.step(get(t.client.scratch)));
      assert.ok(++steps < 32);
    }
    const session = get(f.client.session),
      tokens = Array.from({ length: session.readUInt32LE(244) }, (_, i) =>
        session.readUInt32LE(256 + i * 4),
      );
    assert.deepEqual(
      tokens,
      [8192, 8195, 8193, 8195, 8194, 8195, 8193, 8195, 8194],
    );
    await recover();
    progress(`Four empty roles passed in ${steps} bounded steps`);
  },
);

test(
  "512-symbol non-overlapping merge pass stays bounded with a synthetic authenticated full bucket",
  { timeout: 120000 },
  async () => {
    const { t, get, send, begin, recover } = await fixture("repeat");
    await begin(
      encodeRawMessages([{ role: "user", content: "a".repeat(512) }]),
    );
    let steps = 0,
      maxLookup = 0,
      maxStart = 0;
    while (get(t.client.scratch).readUInt32LE(812) !== 4) {
      const phase = get(t.client.scratch).readUInt32LE(812);
      const cu = await send(await t.client.step(get(t.client.scratch)));
      if (phase === 3) maxLookup = Math.max(maxLookup, cu);
      if (phase === 2) maxStart = Math.max(maxStart, cu);
      assert.ok(++steps < 1024);
    }
    assert.equal(get(t.client.scratch).readUInt32LE(804 + 36), 512);
    const mergeCu = await send(await t.client.step(get(t.client.scratch)));
    assert.equal(get(t.client.scratch).readUInt32LE(804 + 36), 256);
    await recover();
    progress(
      JSON.stringify({
        synthetic: true,
        initialSymbols: 512,
        remainingSymbols: 256,
        startPieceCu: maxStart,
        fullBucketLookupCu: maxLookup,
        mergeCu,
        steps,
        recovered: true,
      }),
    );
  },
);
