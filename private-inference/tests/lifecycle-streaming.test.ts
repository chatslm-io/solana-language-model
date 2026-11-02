import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { CircuitBuilder } from "../compiler/circuit";
import { prepareStreamingCircuit } from "../client/streaming";
import {
  decodeStreamingDescriptor,
  encodeStreamingDescriptor,
  streamingWindows,
} from "../protocol/streaming";
import { verifyCompletedStreamingBytes } from "../protocol/streaming-state";
import {
  encodeSession,
  sessionCommitment,
  pageCommitment,
  pagesCommitment,
  encodeStep,
  type SessionBinding,
} from "../protocol";
import { createLifecycleHarness } from "../harness/local-sbf";
import { verifiedBinary } from "../harness/build.mjs";
import { recoveryPlan } from "../coordinator/recovery";
const enc = getAddressEncoder(),
  system = address("11111111111111111111111111111111"),
  zero = "00".repeat(32);
const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  },
  u64 = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };
const hex = (a: Address) => Buffer.from(enc.encode(a)).toString("hex");
type Harness = Awaited<ReturnType<typeof createLifecycleHarness>>;
const data = (h: Harness, a: Address) => {
  const v = h.svm.getAccount(a);
  assert.ok(v.exists);
  assert.equal(v.programAddress, h.program);
  return Buffer.from(v.data);
};
const bits = (n: number) =>
  Array.from({ length: 32 }, (_, i) => Boolean((n >>> i) & 1));
async function setup(
  operation: "compare" | "add" | "multiply" | "and32",
  a: number,
  b: number,
  invalidGeneration: false | "source" | "destination" = false,
  partialSlotOnly = false,
  paddedSlots = false,
) {
  const h = await createLifecycleHarness("stream"),
    nonce = randomBytes(32),
    builder = new CircuitBuilder(64, "planning"),
    aa = Array.from({ length: 32 }, (_, i) => i),
    bb = aa.map((i) => i + 32);
  let plan;
  if (operation === "and32") {
    let last = 0;
    for (let i = 0; i < 32; i++) last = builder.and(last, 1);
    plan = builder.finishPlan([last]);
  } else
    plan = builder.finishPlan(
      operation === "compare"
        ? [builder.float32OrderedLess(aa, bb)]
        : operation === "add"
          ? builder.float32Add(aa, bb)
          : builder.float32Multiply(aa, bb),
    );
  const key = await prepareStreamingCircuit(plan, nonce);
  let encoded = key.encode([...bits(a), ...bits(b)]);
  if (invalidGeneration) {
    const records = Buffer.concat(
      encoded.windows.map((w) => Buffer.from(w.records)),
    );
    if (invalidGeneration === "source")
      records.writeUInt32LE((records.readUInt32LE(4) + 1) % 64, 4);
    else records.writeUInt32LE(0xfffffffe, 24);
    const committed = await streamingWindows(records),
      desc = decodeStreamingDescriptor(encoded.descriptor);
    encoded = {
      descriptor: encodeStreamingDescriptor({
        ...desc,
        recordRoot: committed.root,
      }),
      windows: committed.windows,
    };
  }
  if (paddedSlots)
    encoded = {
      ...encoded,
      descriptor: encodeStreamingDescriptor({
        ...decodeStreamingDescriptor(encoded.descriptor),
        slotCount: 256,
      }),
    };
  const descriptor = Buffer.from(encoded.descriptor),
    shape = decodeStreamingDescriptor(descriptor);
  const binding: SessionBinding = {
    genesis: zero,
    program: hex(h.program),
    codeHash: zero,
    owner: hex(h.owner.address),
    executor: hex(h.other.address),
    sessionNonce: nonce.toString("hex"),
    deployment: zero,
    storageManifest: zero,
    modelPlanRoot: zero,
    paramsRoot: zero,
    evalKeyRoot: zero,
    inputRoot: pagesCommitment([pageCommitment(0, 1, descriptor)]),
    inputBound: 64,
    outputBound: shape.outputs.length,
    maxSteps: encoded.windows.length,
    expirySlot: h.svm.getClock().slot + 1000000n,
  };
  const [session] = await getProgramDerivedAddress({
    programAddress: h.program,
    seeds: [Buffer.from("slm-pi-session"), enc.encode(h.owner.address), nonce],
  });
  const [page] = await getProgramDerivedAddress({
    programAddress: h.program,
    seeds: [Buffer.from("slm-pi-page"), enc.encode(session), u32(0)],
  });
  const slots = await Promise.all(
    [0, 1].map((i) =>
      getProgramDerivedAddress({
        programAddress: h.program,
        seeds: [Buffer.from("slm-pi-slot"), enc.encode(session), u32(i)],
      }),
    ),
  );
  const [window] = await getProgramDerivedAddress({
    programAddress: h.program,
    seeds: [Buffer.from("slm-pi-window"), enc.encode(session)],
  });
  const ix = (
    d: Uint8Array,
    extra: Address[] = [],
    who = h.owner.address,
  ): Instruction => ({
    programAddress: h.program,
    data: d,
    accounts: [
      { address: who, role: AccountRole.WRITABLE_SIGNER },
      { address: session, role: AccountRole.WRITABLE },
      ...extra.map((a) => ({
        address: a,
        role: a === system ? AccountRole.READONLY : AccountRole.WRITABLE,
      })),
    ],
  });
  let transactions = 0,
    worst = 0n;
  const run = async (instruction: Instruction, signer = h.owner) => {
    const { result, wireBytes } = await h.execute(instruction, signer);
    transactions++;
    if (result instanceof FailedTransactionMetadata)
      assert.fail(
        result.err().toString() + " " + result.meta().logs().join("\n"),
      );
    assert.ok(wireBytes <= 1232);
    assert.ok(result.computeUnitsConsumed() <= 200000n);
    if (result.computeUnitsConsumed() > worst)
      worst = result.computeUnitsConsumed();
    return result;
  };
  await run(
    ix(
      Buffer.concat([
        Buffer.from([0]),
        encodeSession(binding),
        u32(1),
        u64(100_000_000n),
      ]),
      [system],
    ),
  );
  await run(
    ix(
      Buffer.concat([
        Buffer.from([1]),
        u32(0),
        u32(1),
        u32(descriptor.length),
        Buffer.from(pageCommitment(0, 1, descriptor), "hex"),
        u64(100_000_000n),
      ]),
      [page, system],
    ),
  );
  for (let offset = 0; offset < descriptor.length; offset += 700)
    await run(
      ix(
        Buffer.concat([
          Buffer.from([2]),
          u32(offset),
          descriptor.subarray(offset, offset + 700),
        ]),
        [page],
      ),
    );
  await run(ix(Buffer.from([3]), [page]));
  await run(ix(Buffer.from([4]), [page]));
  for (let index = 0; index < (partialSlotOnly ? 1 : 2); index++)
    await run(
      ix(Buffer.concat([Buffer.from([11]), u32(index), u64(100_000_000n)]), [
        page,
        slots[index][0],
        system,
      ]),
    );
  if (!partialSlotOnly)
    await run(
      ix(Buffer.concat([Buffer.from([12]), u64(100_000_000n)]), [
        page,
        window,
        slots[0][0],
        slots[1][0],
        system,
      ]),
    );
  const begin = (index: number) =>
    ix(Buffer.concat([Buffer.from([13]), u32(index)]), [page, window]);
  const upload = (offset: number, bytes: Uint8Array) =>
    ix(Buffer.concat([Buffer.from([14]), u32(offset), bytes]), [window]);
  const seal = (index: number) =>
    ix(
      Buffer.concat([
        Buffer.from([15]),
        ...encoded.windows[index].proof.map((p) => Buffer.from(p)),
      ]),
      [page, window],
    );
  const step = (index: number) =>
    ix(
      Buffer.concat([
        Buffer.from([16]),
        encodeStep({
          bindingHash: sessionCommitment(binding),
          expectedStateRoot: data(h, session)
            .subarray(176, 208)
            .toString("hex"),
          sequence: index,
          workUnits: Math.min(32, shape.gateCount - index * 32),
        }),
      ]),
      [page, window, slots[0][0], slots[1][0]],
    );
  const admit = async (index: number) => {
    await run(begin(index));
    const records = encoded.windows[index].records;
    for (let offset = 0; offset < records.length; offset += 700)
      await run(upload(offset, records.subarray(offset, offset + 700)));
    await run(seal(index));
  };
  return {
    h,
    key,
    encoded,
    descriptor,
    shape,
    binding,
    session,
    page,
    slots,
    window,
    ix,
    run,
    begin,
    upload,
    seal,
    step,
    admit,
    get metrics() {
      return { transactions, worst: Number(worst) };
    },
  };
}
async function failed(
  f: Awaited<ReturnType<typeof setup>>,
  instruction: Instruction,
) {
  assert.ok(
    (await f.h.execute(instruction)).result instanceof
      FailedTransactionMetadata,
  );
}
async function recover(f: Awaited<ReturnType<typeof setup>>) {
  const inventory = [
    f.session,
    f.page,
    f.window,
    ...f.slots.map((s) => s[0]),
  ].flatMap((a) => {
    const v = f.h.svm.getAccount(a);
    return v.exists
      ? [
          {
            address: a,
            owner: v.programAddress,
            data: v.data,
            lamports: v.lamports,
          },
        ]
      : [];
  });
  const plan = await recoveryPlan(f.h.program, f.h.owner.address, inventory),
    before = f.h.svm.getBalance(f.h.owner.address)!;
  for (const ix of plan.instructions) await f.run(ix);
  assert.equal(
    f.h.svm.getBalance(f.h.owner.address)! - before,
    plan.refundableLamports - BigInt(plan.instructions.length) * 5000n,
  );
  for (const a of inventory)
    assert.equal(f.h.svm.getAccount(a.address).exists, false);
}
async function output(f: Awaited<ReturnType<typeof setup>>) {
  assert.equal(
    data(f.h, f.session).subarray(112, 144).toString("hex"),
    sessionCommitment(f.binding),
  );
  const args = {
    session: data(f.h, f.session),
    sessionAddress: Uint8Array.from(enc.encode(f.session)),
    slots: [data(f.h, f.slots[0][0]), data(f.h, f.slots[1][0])] as const,
    slotBumps: [f.slots[0][1], f.slots[1][1]] as const,
    descriptor: f.descriptor,
  };
  return { args, labels: await verifyCompletedStreamingBytes(args) };
}
test("381-gate encrypted binary32 comparison streams authenticated windows across restart and recovers without keys", async () => {
  for (const [a, b, expected] of [
    [0x80000000, 0, false],
    [0xbf800000, 0x3f800000, true],
    [0x7fc01234, 0x3f800000, false],
    [0xff800000, 0x7f800000, true],
    [0x3f800000, 0x3f800000, false],
  ] as const) {
    const f = await setup("compare", a, b);
    try {
      let worstStep = 0n;
      for (let index = 0; index < f.encoded.windows.length; index++) {
        await f.admit(index);
        const ix = f.step(index),
          r = await f.run(ix);
        if (r.computeUnitsConsumed() > worstStep)
          worstStep = r.computeUnitsConsumed();
        if (index === 0) {
          f.h.restart();
          const snapshot = [
            f.session,
            f.window,
            ...f.slots.map((s) => s[0]),
          ].map((a) => data(f.h, a));
          await failed(f, ix);
          assert.ok(
            [f.session, f.window, ...f.slots.map((s) => s[0])].every((a, i) =>
              data(f.h, a).equals(snapshot[i]),
            ),
            "consumed-step replay mutated persisted state",
          );
        }
      }
      const verified = await output(f);
      assert.deepEqual(f.key.decode(verified.labels), [expected]);
      const bad = Uint8Array.from(verified.args.slots[0]);
      bad[264] ^= 1;
      await assert.rejects(
        verifyCompletedStreamingBytes({
          ...verified.args,
          slots: [bad, verified.args.slots[1]],
        }),
        /invalid_streaming_result/,
      );
      f.key.destroy();
      await recover(f);
      console.log(
        JSON.stringify({
          scope: "real encrypted binary32 ordered comparison",
          gates: f.shape.gateCount,
          windows: f.encoded.windows.length,
          physicalSlots: f.shape.slotCount,
          worstStepCu: Number(worstStep),
          ...f.metrics,
          refundVerified: true,
        }),
      );
    } finally {
      f.key.destroy();
    }
  }
});
test("5252-gate encrypted binary32 RNE addition runs165 fixed windows without offchain intermediates", async () => {
  const f = await setup("add", 0x3f800000, 0x33800000);
  try {
    let worstStep = 0n;
    for (let index = 0; index < f.encoded.windows.length; index++) {
      await f.admit(index);
      const r = await f.run(f.step(index));
      if (r.computeUnitsConsumed() > worstStep)
        worstStep = r.computeUnitsConsumed();
      if (index === 40) f.h.restart();
    }
    const verified = await output(f);
    const bits = f.key.decode(verified.labels);
    const number = bits.reduce((n, x, i) => (n + (x ? 2 ** i : 0)) >>> 0, 0);
    assert.equal(number, 0x3f800000);
    await recover(f);
    console.log(
      JSON.stringify({
        scope: "real encrypted binary32 addition ties-to-even",
        gates: f.shape.gateCount,
        windows: f.encoded.windows.length,
        physicalSlots: f.shape.slotCount,
        worstStepCu: Number(worstStep),
        ...f.metrics,
        refundVerified: true,
      }),
    );
  } finally {
    f.key.destroy();
  }
});
test("streaming rejects wrong Merkle/window/cursor and immutable upload changes then closes after lost decoding key", async () => {
  const f = await setup("compare", 0, 1);
  try {
    await failed(f, f.begin(1));
    await f.run(f.begin(0));
    await failed(f, f.begin(0));
    await failed(f, f.seal(0));
    const records = f.encoded.windows[0].records;
    for (let o = 0; o < records.length; o += 700)
      await f.run(f.upload(o, records.subarray(o, o + 700)));
    const bad = f.seal(0),
      bytes = Buffer.from(bad.data!);
    bytes[1] ^= 1;
    await failed(f, { ...bad, data: bytes });
    await f.run(f.seal(0));
    await failed(f, f.upload(0, records.subarray(0, 700)));
    await failed(f, f.begin(1));
    const wrong = f.step(0),
      changed = Buffer.from(wrong.data!);
    changed[41] ^= 1;
    await failed(f, { ...wrong, data: changed });
    await f.run(f.step(0));
    f.h.restart();
    await f.run(f.begin(1));
    await f.run(f.upload(0, f.encoded.windows[1].records.subarray(0, 700)));
    f.key.destroy();
    await recover(f);
  } finally {
    f.key.destroy();
  }
});

test("7451-gate binary32 multiply keeps241slots and rounds subnormal underflow entirely in SBF", async () => {
  const f = await setup("multiply", 3, 0x3f000000);
  try {
    let worstStep = 0n;
    for (let index = 0; index < f.encoded.windows.length; index++) {
      await f.admit(index);
      const r = await f.run(f.step(index));
      if (r.computeUnitsConsumed() > worstStep)
        worstStep = r.computeUnitsConsumed();
    }
    const verified = await output(f),
      result = f.key
        .decode(verified.labels)
        .reduce((n, x, i) => (n + (x ? 2 ** i : 0)) >>> 0, 0);
    assert.equal(result, 2);
    await recover(f);
    console.log(
      JSON.stringify({
        scope: "real encrypted binary32 multiplication subnormal RNE",
        gates: f.shape.gateCount,
        windows: f.encoded.windows.length,
        physicalSlots: f.shape.slotCount,
        worstStepCu: Number(worstStep),
        ...f.metrics,
        refundVerified: true,
      }),
    );
  } finally {
    f.key.destroy();
  }
});
test("authenticated but invalid destination generation fails atomically and remains owner-recoverable", async () => {
  const f = await setup("compare", 0, 1, "destination");
  try {
    await f.admit(0);
    const before = data(f.h, f.slots[0][0]);
    await failed(f, f.step(0));
    assert.ok(
      data(f.h, f.slots[0][0]).equals(before),
      "failed generation check mutated slot state",
    );
    assert.equal(data(f.h, f.session).readUInt32LE(208), 0);
    f.key.destroy();
    await recover(f);
  } finally {
    f.key.destroy();
  }
});

test("authenticated stale source generation cannot alter slots or consume window", async () => {
  const f = await setup("compare", 0, 1, "source");
  try {
    await f.admit(0);
    const before = [
      data(f.h, f.session),
      data(f.h, f.window),
      ...f.slots.map((s) => data(f.h, s[0])),
    ];
    await failed(f, f.step(0));
    assert.ok(
      [
        data(f.h, f.session),
        data(f.h, f.window),
        ...f.slots.map((s) => data(f.h, s[0])),
      ].every((value, index) => value.equals(before[index])),
      "failed source-generation check mutated persisted state",
    );
    await recover(f);
  } finally {
    f.key.destroy();
  }
});
test("partial slot0 allocation remains recoverable after expiry with no descriptor or decoding key", async () => {
  const f = await setup("compare", 0, 1, false, true);
  try {
    assert.equal(f.h.svm.getAccount(f.slots[1][0]).exists, false);
    f.key.destroy();
    f.h.svm.warpToSlot(f.binding.expirySlot + 1n);
    f.h.svm.addProgram(f.h.program, verifiedBinary("production"));
    await f.run(f.ix(Buffer.from([7]), [f.page]));
    await recover(f);
  } finally {
    f.key.destroy();
  }
});
test("production build with no evaluator closes streaming slot/window accounts after key loss", async () => {
  const f = await setup("compare", 0, 1);
  try {
    await f.admit(0);
    await f.run(f.step(0));
    f.key.destroy();
    // In-process test loader replacement only: proves cleanup code has no evaluator dependency.
    f.h.svm.addProgram(f.h.program, verifiedBinary("production"));
    await recover(f);
  } finally {
    f.key.destroy();
  }
});

test("maximum256 physical slots and32AND window stay within200kCU and32KiB heap", async () => {
  const f = await setup("and32", 0, 0, false, false, true);
  try {
    assert.equal(f.shape.slotCount, 256);
    assert.equal(data(f.h, f.slots[0][0]).length, 5376);
    assert.equal(data(f.h, f.slots[1][0]).length, 5376);
    await f.admit(0);
    const r = await f.run(f.step(0));
    const verified = await output(f);
    assert.deepEqual(f.key.decode(verified.labels), [false]);
    await recover(f);
    console.log(
      JSON.stringify({
        scope: "maximum streaming physical state",
        physicalSlots: 256,
        stateBytes: 10240,
        slotAccountBytes: 5376,
        stepCu: Number(r.computeUnitsConsumed()),
        ...f.metrics,
        refundVerified: true,
      }),
    );
  } finally {
    f.key.destroy();
  }
});
