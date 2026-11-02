import test from "node:test";
import assert from "node:assert/strict";
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { prepareSingleUseAnd } from "../client/halfgates";
import { createLifecycleHarness } from "../harness/local-sbf";
import {
  encodeSession,
  sessionCommitment,
  pageCommitment,
  pagesCommitment,
  encodeStep,
  type SessionBinding,
} from "../protocol";
import { recoveryPlan } from "../coordinator/recovery";
import { type PrivateDirectory } from "../../lib/operator/external";
import { TransactionCoordinator } from "../coordinator/transactions";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
const enc = getAddressEncoder(),
  system = address("11111111111111111111111111111111");
const hex = (a: Address) => Buffer.from(enc.encode(a)).toString("hex");
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const zero = "00".repeat(32);
function accountData(
  h: Awaited<ReturnType<typeof createLifecycleHarness>>,
  a: Address,
) {
  const v = h.svm.getAccount(a);
  assert.ok(v.exists);
  return v.data;
}
async function fixture(real?: { a: boolean; b: boolean }, production = false) {
  const h = await createLifecycleHarness(
    real ? "experimental" : production ? "production" : "mock",
  );
  const key = real
    ? await prepareSingleUseAnd(Buffer.from("11".repeat(32), "hex"), 0)
    : null;
  const payload = key
    ? Buffer.from(key.encode(real!.a, real!.b))
    : Buffer.from("PUBLIC SYNTHETIC LIFECYCLE FIXTURE; MOCK IS NOT INFERENCE");
  const digest = pageCommitment(0, 1, payload);
  const binding: SessionBinding = {
    genesis: zero,
    program: hex(h.program),
    codeHash: zero,
    owner: hex(h.owner.address),
    executor: hex(h.other.address),
    sessionNonce: "11".repeat(32),
    deployment: zero,
    storageManifest: zero,
    modelPlanRoot: zero,
    paramsRoot: zero,
    evalKeyRoot: zero,
    inputRoot: pagesCommitment([digest]),
    inputBound: 64,
    outputBound: 8,
    maxSteps: real ? 1 : 2,
    expirySlot: h.svm.getClock().slot + 1000000n,
  };
  const [session] = await getProgramDerivedAddress({
    programAddress: h.program,
    seeds: [
      Buffer.from("slm-pi-session"),
      enc.encode(h.owner.address),
      Buffer.from(binding.sessionNonce, "hex"),
    ],
  });
  const [page] = await getProgramDerivedAddress({
    programAddress: h.program,
    seeds: [Buffer.from("slm-pi-page"), enc.encode(session), u32(0)],
  });
  const ix = (
    data: Uint8Array,
    extras: Address[] = [],
    who = h.owner.address,
  ): Instruction => ({
    programAddress: h.program,
    accounts: [
      { address: who, role: AccountRole.WRITABLE_SIGNER },
      { address: session, role: AccountRole.WRITABLE },
      ...extras.map((a) => ({
        address: a,
        role: a === system ? AccountRole.READONLY : AccountRole.WRITABLE,
      })),
    ],
    data,
  });
  const create = () =>
    ix(
      Buffer.concat([
        Buffer.from([0]),
        encodeSession(binding),
        u32(1),
        u64(100_000_000n),
      ]),
      [system],
    );
  const createPage = () =>
    ix(
      Buffer.concat([
        Buffer.from([1]),
        u32(0),
        u32(1),
        u32(payload.length),
        Buffer.from(digest, "hex"),
        u64(100_000_000n),
      ]),
      [page, system],
    );
  const write = (offset = 0, data = payload) =>
    ix(Buffer.concat([Buffer.from([2]), u32(offset), data]), [page]);
  const step = (sequence: number) =>
    ix(
      Buffer.concat([
        Buffer.from([5]),
        encodeStep({
          bindingHash: sessionCommitment(binding),
          expectedStateRoot: Buffer.from(accountData(h, session))
            .subarray(176, 208)
            .toString("hex"),
          sequence,
          workUnits: 1,
        }),
      ]),
    );
  return {
    h,
    key,
    payload,
    binding,
    session,
    page,
    ix,
    create,
    createPage,
    write,
    step,
  };
}
type Execution = ReturnType<
  Awaited<ReturnType<typeof createLifecycleHarness>>["execute"]
>;
async function success(p: Execution) {
  const { result, wireBytes } = await p;
  if (result instanceof FailedTransactionMetadata)
    assert.fail(
      result.err().toString() + " " + result.meta().logs().join("\n"),
    );
  assert.ok(result.computeUnitsConsumed() <= 200_000n);
  assert.ok(wireBytes <= 1232);
  return result;
}
async function fails(p: Execution) {
  assert.ok((await p).result instanceof FailedTransactionMetadata);
}
test("compiled SBF mock lifecycle restart, exact input sealing, stale-step rejection and full rent refund", async () => {
  const f = await fixture(),
    { h } = f;
  const before = h.svm.getBalance(h.owner.address)!;
  let fees = 0n;
  const run = async (ix: Instruction) => {
    const r = await success(h.execute(ix));
    fees += 5000n;
    return r;
  };
  await run(f.create());
  assert.equal(
    Buffer.from(accountData(h, f.session)).subarray(112, 144).toString("hex"),
    sessionCommitment(f.binding),
  );
  await run(f.createPage());
  await run(f.write());
  await run(f.write());
  await run(f.ix(Buffer.from([3]), [f.page]));
  await run(f.ix(Buffer.from([4]), [f.page]));
  const stale = f.step(0);
  const r = await run(stale);
  h.restart();
  await fails(h.execute(stale));
  fees += 5000n;
  await run(f.step(1));
  assert.equal(accountData(h, f.session)[10], 3);
  await run(f.ix(Buffer.from([7]), [f.page]));
  await run(f.ix(Buffer.from([8])));
  assert.equal(h.svm.getAccount(f.page).exists, false);
  assert.equal(h.svm.getAccount(f.session).exists, false);
  assert.equal(before - h.svm.getBalance(h.owner.address)!, fees);
  console.log(
    JSON.stringify({
      scope: "TEST ONLY MOCK lifecycle",
      stepCu: Number(r.computeUnitsConsumed()),
      refundVerified: true,
      fees: Number(fees),
    }),
  );
});
test("compiled SBF rejects wrong authority and partial/conflicting uploads; owner recovers after expiry", async () => {
  const f = await fixture(),
    { h } = f;
  await success(h.execute(f.create()));
  await success(h.execute(f.createPage()));
  await fails(
    h.execute(f.ix(Buffer.from([7]), [f.page], h.other.address), h.other),
  );
  await fails(h.execute(f.ix(Buffer.from([8]))));
  await fails(h.execute(f.write(1)));
  await success(h.execute(f.write(0, f.payload.subarray(0, 8))));
  await fails(h.execute(f.write(0, Buffer.alloc(8))));
  await fails(h.execute(f.ix(Buffer.from([3]), [f.page])));
  await fails(h.execute(f.ix(Buffer.from([4]), [f.page])));
  h.svm.warpToSlot(f.binding.expirySlot + 1n);
  await fails(h.execute(f.write(8, f.payload.subarray(8))));
  await success(h.execute(f.ix(Buffer.from([7]), [f.page])));
  await success(h.execute(f.ix(Buffer.from([8]))));
});
test("journal reserves before broadcast; lost replies cannot re-sign or spend cleanup reserve", async () => {
  const dir = await mkdtemp("/tmp/slm-private-journal-");
  const path = join(dir, "journal.json");
  let sends = 0;
  const transport = {
    localOnly: true as const,
    async sendExact(): Promise<string> {
      sends++;
      const saved = JSON.parse(await readFile(path, "utf8"));
      assert.equal(saved.transactions[0].state, "reserved");
      throw Error("lost reply");
    },
    async status() {
      return "finalized" as const;
    },
  };
  try {
    const c = new TransactionCoordinator(path, transport, {
      // Public synthetic journal only: sandbox marks all /tmp as Git. Never used for validator/real journals.
      outsideGit() {},
      privateDirectory(p) {
        assert.equal(p, dir);
        return p as PrivateDirectory;
      },
    });
    await c.initialize({
      feeAllowance: "20",
      rentAllowance: "100",
      cleanupReserve: "50",
      available: "170",
    });
    const tx = {
      operation: "step0",
      signature: "public-test-signature",
      wireBase64: Buffer.from("public mock signed bytes").toString("base64"),
      fee: "10",
      rent: "100",
    };
    const competing = await Promise.allSettled([c.submit(tx), c.submit(tx)]);
    assert.ok(competing.every((v) => v.status === "rejected"));
    assert.equal(sends, 1);
    await assert.rejects(
      c.submit({ ...tx, operation: "x".repeat(129) }),
      /invalid_transaction/,
    );
    assert.equal(await c.submit(tx), "reserved");
    assert.equal(sends, 1);
    await assert.rejects(
      c.submit({ ...tx, signature: "replacement" }),
      /cannot_be_replaced/,
    );
    assert.equal(await c.reconcile("step0"), "finalized");
    await assert.rejects(
      c.submit({ ...tx, operation: "step1", rent: "1", fee: "11" }),
      /budget_or_cleanup/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("real encrypted AND traverses authenticated accounts, resume, decode and recovery for every truth-table row", async () => {
  for (const a of [false, true])
    for (const b of [false, true]) {
      const f = await fixture({ a, b }),
        { h } = f;
      try {
        for (const ix of [
          f.create(),
          f.createPage(),
          f.write(),
          f.ix(Buffer.from([3]), [f.page]),
          f.ix(Buffer.from([4]), [f.page]),
        ])
          await success(h.execute(ix));
        h.restart();
        const raw = f.step(0);
        const realIx = {
          ...raw,
          accounts: [
            ...raw.accounts!,
            { address: f.page, role: AccountRole.READONLY },
          ],
        };
        const result = await success(h.execute(realIx));
        assert.equal(
          f.key!.decode(accountData(h, f.session).subarray(176, 208)),
          a && b,
        );
        await fails(h.execute(realIx));
        const before = h.svm.getBalance(h.owner.address)!;
        const deposits =
          h.svm.getBalance(f.page)! + h.svm.getBalance(f.session)!;
        await success(h.execute(f.ix(Buffer.from([7]), [f.page])));
        await success(h.execute(f.ix(Buffer.from([8]))));
        assert.equal(
          h.svm.getBalance(h.owner.address)! - before,
          deposits - 10000n,
        );
        console.log(
          JSON.stringify({
            scope: "experimental real encrypted AND account lifecycle",
            computeUnits: Number(result.computeUnitsConsumed()),
            refundVerified: true,
          }),
        );
      } finally {
        f.key?.destroy();
      }
    }
});

test("production binary refuses mock execution; recovery remains available", async () => {
  const f = await fixture(undefined, true),
    { h } = f;
  for (const ix of [
    f.create(),
    f.createPage(),
    f.write(),
    f.ix(Buffer.from([3]), [f.page]),
    f.ix(Buffer.from([4]), [f.page]),
  ])
    await success(h.execute(ix));
  await fails(h.execute(f.step(0)));
  await success(h.execute(f.ix(Buffer.from([7]), [f.page])));
  await success(h.execute(f.ix(Buffer.from([8]))));
});
test("compiled SBF rejects cap, delegate allocation, altered bindings and accounts; sealed uploads immutable", async () => {
  const f = await fixture(),
    { h } = f;
  const create = f.create();
  const cap = Buffer.from(create.data!);
  cap.writeBigUInt64LE(0n, 417);
  await fails(h.execute({ ...create, data: cap }));
  await success(h.execute(create));
  const delegated = f.createPage();
  await fails(
    h.execute(
      {
        ...delegated,
        accounts: [
          { address: h.other.address, role: AccountRole.WRITABLE_SIGNER },
          ...delegated.accounts!.slice(1),
        ],
      },
      h.other,
    ),
  );
  await success(h.execute(f.createPage()));
  await success(h.execute(f.write()));
  await success(h.execute(f.ix(Buffer.from([3]), [f.page])));
  await success(h.execute(f.ix(Buffer.from([3]), [f.page])));
  await fails(h.execute(f.write()));
  await fails(h.execute(f.ix(Buffer.from([4]), [f.session])));
  await success(h.execute(f.ix(Buffer.from([4]), [f.page])));
  for (const offset of [9, 41, 73, 77]) {
    const original = f.step(0);
    const bad = Buffer.from(original.data!);
    bad[offset] ^= 1;
    await fails(h.execute({ ...original, data: bad }));
  }
  await success(h.execute(f.step(0)));
  await fails(h.execute(f.step(0)));
  await success(h.execute(f.ix(Buffer.from([7]), [f.page])));
  await success(h.execute(f.ix(Buffer.from([8]))));
});

test("discovery-only recovery validates every PDA and refuses incomplete inventory", async () => {
  const f = await fixture(),
    { h } = f;
  await success(h.execute(f.create()));
  await success(h.execute(f.createPage()));
  const inventory = [f.session, f.page].map((a) => ({
    address: a,
    owner: h.program,
    data: accountData(h, a),
    lamports: h.svm.getBalance(a)!,
  }));
  await assert.rejects(
    recoveryPlan(h.program, h.owner.address, inventory.slice(0, 1)),
    /incomplete_discovery/,
  );
  for (let i = 0; i < inventory.length; i++) {
    const bad = inventory.map((a) => ({ ...a, data: Uint8Array.from(a.data) }));
    bad[i].data[0] |= 128;
    await assert.rejects(
      recoveryPlan(h.program, h.owner.address, bad),
      /recovery_account_layout/,
    );
  }
  const plan = await recoveryPlan(h.program, h.owner.address, inventory);
  const before = h.svm.getBalance(h.owner.address)!;
  for (const ix of plan.instructions) await success(h.execute(ix));
  assert.equal(
    h.svm.getBalance(h.owner.address)! - before,
    plan.refundableLamports - 10000n,
  );
});
