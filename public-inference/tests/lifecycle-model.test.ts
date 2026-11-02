import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  type Address,
  type Instruction,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { createLifecycleHarness } from "../harness/local-sbf";
const enc = getAddressEncoder(),
  system = address("11111111111111111111111111111111");
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
const hash = (...v: Uint8Array[]) => {
  const h = createHash("sha256");
  v.forEach((x) => h.update(x));
  return h.digest();
};
const leaf = (i: number, kind: number, p: Uint8Array) =>
  hash(
    Buffer.from("slm-public:artifact:v1\n"),
    u32(i),
    u32(kind),
    u32(p.length),
    hash(p),
  );
async function fixture() {
  const h = await createLifecycleHarness(),
    weights = Buffer.from("public synthetic weight bytes"),
    plan = Buffer.alloc(64),
    payloads = [weights, plan],
    leaves = payloads.map((p, i) => leaf(i, i + 1, p)),
    root = hash(Buffer.from("slm-public:artifact-node:v1\n"), ...leaves),
    binding = Buffer.alloc(224);
  binding.write("SLMPUB01");
  binding.fill(11, 8, 40);
  root.copy(binding, 104);
  [2, 1, 1, 1, 1, 16, 8196, 4, 128, 16].forEach((v, i) =>
    binding.writeUInt32LE(v, 168 + i * 4),
  );
  const [model] = await getProgramDerivedAddress({
      programAddress: h.program,
      seeds: [
        Buffer.from("slm-pu-model"),
        enc.encode(h.owner.address),
        binding.subarray(8, 40),
      ],
    }),
    pages = await Promise.all(
      [0, 1].map(
        async (i) =>
          (
            await getProgramDerivedAddress({
              programAddress: h.program,
              seeds: [
                Buffer.from("slm-pu-artifact"),
                enc.encode(model),
                u32(i),
              ],
            })
          )[0],
      ),
    );
  const ix = (
    data: Uint8Array,
    extra: Address[] = [],
    who = h.owner.address,
  ): Instruction => ({
    programAddress: h.program,
    accounts: [
      { address: who, role: AccountRole.WRITABLE_SIGNER },
      { address: model, role: AccountRole.WRITABLE },
      ...extra.map((a) => ({
        address: a,
        role: a === system ? AccountRole.READONLY : AccountRole.WRITABLE,
      })),
    ],
    data,
  });
  const send = async (
    data: Uint8Array,
    extra: Address[] = [],
    fails = false,
    other = false,
  ) => {
    const r = await h.execute(
      ix(data, extra, other ? h.other.address : h.owner.address),
      other ? h.other : h.owner,
    );
    assert.equal(
      r.result instanceof FailedTransactionMetadata,
      fails,
      r.result instanceof FailedTransactionMetadata
        ? String(r.result.err())
        : "unexpected success",
    );
    return r;
  };
  const alloc = (i: number, proof = leaves[1 - i]) =>
    Buffer.concat([
      Buffer.from([1]),
      u32(i),
      u32(payloads[i].length),
      u64(100000000n),
      hash(payloads[i]),
      u32(i + 1),
      proof,
    ]);
  const initialBalance = h.svm.getBalance(h.owner.address)!;
  await send(Buffer.concat([Buffer.from([0]), binding, u64(100000000n)]), [
    system,
  ]);
  return { h, model, pages, payloads, send, alloc, initialBalance };
}
test("compiled SBF Merkle-bound model upload survives restart; owner-only full refund including donations", async () => {
  const f = await fixture();
  let fees = 5000n;
  for (let i = 0; i < 2; i++) {
    await f.send(f.alloc(i), [f.pages[i], system]);
    await f.send(Buffer.concat([Buffer.from([2]), u32(0), f.payloads[i]]), [
      f.pages[i],
    ]);
    await f.send(Buffer.from([3]), [f.pages[i]]);
    fees += 15000n;
  }
  await f.send(Buffer.from([4]));
  fees += 5000n;
  f.h.svm.airdrop(f.pages[0], lamports(12345n));
  f.h.restart();
  await f.send(
    Buffer.concat([Buffer.from([2]), u32(0), Buffer.from([99])]),
    [f.pages[0]],
    true,
  );
  fees += 5000n;
  await f.send(Buffer.from([5]), [f.pages[0]], true, true);
  for (const page of f.pages) {
    await f.send(Buffer.from([5]), [page]);
    fees += 5000n;
    assert.equal(f.h.svm.getAccount(page).exists, false);
  }
  await f.send(Buffer.from([6]));
  fees += 5000n;
  assert.equal(f.h.svm.getAccount(f.model).exists, false);
  // LiteSVM fixture uses its default fixed5000-lamport signature fee.
  assert.equal(
    f.h.svm.getBalance(f.h.owner.address),
    f.initialBalance + 12345n - fees,
  );
});
test("Merkle substitution, duplicate seal and incomplete model rejected; partial upload independently recoverable", async () => {
  const f = await fixture();
  await f.send(f.alloc(0, Buffer.alloc(32)), [f.pages[0], system], true);
  assert.equal(f.h.svm.getAccount(f.pages[0]).exists, false);
  await f.send(f.alloc(0), [f.pages[0], system]);
  await f.send(Buffer.from([4]), [], true);
  await f.send(Buffer.from([6]), [], true);
  await f.send(Buffer.concat([Buffer.from([2]), u32(0), f.payloads[0]]), [
    f.pages[0],
  ]);
  await f.send(Buffer.from([3]), [f.pages[0]]);
  await f.send(Buffer.from([3]), [f.pages[0]], true);
  f.h.restart();
  await f.send(Buffer.from([5]), [f.pages[0]]);
  await f.send(f.alloc(1), [f.pages[1], system], true);
  await f.send(Buffer.from([6]));
});
