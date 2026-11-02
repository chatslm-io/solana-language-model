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
import { publicClient, u32 } from "../harness/client";
import { command, encodeCommand } from "../protocol";
import { executionInstruction, INSTRUCTIONS_SYSVAR } from "../execution-mode";

// Synthetic sealed model metadata tests dispatch, session state and rent recovery.
// Full model arithmetic remains covered by the separate model lifecycle suite.
async function fixture() {
  const h = await createLifecycleHarness();
  const nonce = Buffer.alloc(32, 17);
  const client = await publicClient(
    h.program,
    h.owner.address,
    nonce,
    Buffer.alloc(32, 18),
  );
  const enc = getAddressEncoder();
  const [, bump] = await getProgramDerivedAddress({
    programAddress: h.program,
    seeds: [Buffer.from("slm-pu-model"), enc.encode(h.owner.address), nonce],
  });
  const model = Buffer.alloc(384);
  model.write("SLMPUM01");
  model[8] = 1;
  model[9] = 1;
  model[10] = 1;
  model[11] = bump;
  model.set(enc.encode(h.owner.address), 16);
  model.set(nonce, 48);
  model.fill(23, 80, 112);
  h.svm.setAccount({
    address: client.model,
    programAddress: h.program,
    data: model,
    lamports: lamports(10000000n),
    space: 384n,
    executable: false,
  });
  const create = client.createSession(
    [11, 22],
    1,
    h.svm.getClock().slot + 100000n,
  );
  return { h, client, create };
}
function success(
  result: Awaited<
    ReturnType<Awaited<ReturnType<typeof createLifecycleHarness>>["execute"]>
  >["result"],
) {
  if (result instanceof FailedTransactionMetadata)
    assert.fail(result.meta().logs().join("\n"));
  return result;
}

test("mode 0 dispatches real SBF state transitions, matches legacy state and refunds rent", async () => {
  const { h, client, create } = await fixture();
  const legacy = await fixture();
  const balance = h.svm.getBalance(h.owner.address)!;
  const operations = [
    create,
    ...Array.from({ length: 5 }, (_, i) => client.allocateState(i)),
    client.start(),
    ...Array.from({ length: 5 }, (_, i) => client.closeState(i)),
    client.closeSession(),
  ];
  for (const ix of operations) {
    const wrapped = executionInstruction(ix, 0);
    assert.equal(wrapped.data!.length, ix.data!.length + 63);
    const result = success((await h.execute(wrapped)).result);
    success((await legacy.h.execute(ix)).result);
    const report = Buffer.from(result.returnData().data());
    assert.equal(report.length, 64);
    assert.equal(report[6], 0);
    const session = h.svm.getAccount(client.session);
    assert.deepEqual(session, legacy.h.svm.getAccount(client.session));
    for (const state of client.states)
      assert.deepEqual(h.svm.getAccount(state), legacy.h.svm.getAccount(state));
    if (session.exists) {
      const data = Buffer.from(session.data);
      assert.deepEqual(report.subarray(24, 56), data.subarray(208, 240));
      assert.deepEqual(report.subarray(56, 60), data.subarray(184, 188));
      assert.deepEqual(report.subarray(60, 64), data.subarray(248, 252));
      assert.equal(report.readUInt32LE(56), 11);
    } else assert.ok(report.subarray(24).every((value) => value === 0));
  }
  assert.equal(h.svm.getAccount(client.session).exists, false);
  for (const state of client.states)
    assert.equal(h.svm.getAccount(state).exists, false);
  assert.equal(
    balance - h.svm.getBalance(h.owner.address)!,
    BigInt(operations.length) * 5000n,
  );
});

test("every reserved mode fails before allocation, state changes or execution results", async () => {
  const { h, client, create } = await fixture();
  const original = executionInstruction(create, 0);
  const modelBefore = h.svm.getAccount(client.model);
  for (let mode = 1; mode <= 255; mode++) {
    const data = Buffer.from(original.data!);
    data[6] = mode;
    const { result } = await h.execute({ ...original, data });
    assert.ok(
      result instanceof FailedTransactionMetadata,
      `reserved mode ${mode} succeeded`,
    );
    assert.ok(
      !result
        .meta()
        .logs()
        .some((line) => line.startsWith("Program data: ")),
    );
    assert.equal(h.svm.getAccount(client.session).exists, false);
    assert.deepEqual(h.svm.getAccount(client.model), modelBefore);
  }
});

test("mode 0 rejects synthetic results, malformed envelopes, missing authority/sysvar and mixed transactions", async () => {
  const { h, client, create } = await fixture();
  const ix = executionInstruction(create, 0);
  const mutate = (at: number, value: number): Instruction => {
    const data = Buffer.from(ix.data!);
    data[at] = value;
    return { ...ix, data };
  };
  const bad: (Instruction | readonly Instruction[])[] = [
    mutate(5, 2),
    mutate(7, 1),
    mutate(24, 1),
    mutate(56, 1),
    mutate(60, 1),
    { ...ix, data: Buffer.from(ix.data!).subarray(0, 63) },
    { ...ix, data: Buffer.concat([Buffer.from(ix.data!), Buffer.of(0)]) },
    { ...ix, accounts: ix.accounts!.slice(0, -1) },
    {
      ...ix,
      accounts: [
        ...ix.accounts!.slice(0, -1),
        { address: h.other.address, role: AccountRole.READONLY },
      ],
    },
    {
      ...ix,
      accounts: [
        { address: h.other.address, role: AccountRole.WRITABLE },
        ...ix.accounts!.slice(1),
      ],
    },
    {
      ...ix,
      accounts: [
        ...ix.accounts!,
        { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
      ],
    },
    [ix, mutate(6, 1)],
    [ix, create],
  ];
  for (const [index, instruction] of bad.entries()) {
    const { result } = await h.execute(instruction);
    assert.ok(
      result instanceof FailedTransactionMetadata,
      `invalid case ${index} succeeded`,
    );
    assert.equal(h.svm.getAccount(client.session).exists, false);
  }
  // An old mode-0 marker with plausible result fields is no longer accepted.
  const synthetic = Buffer.from(ix.data!);
  synthetic.fill(7, 24, 56);
  assert.ok(
    (await h.execute({ ...ix, data: synthetic })).result instanceof
      FailedTransactionMetadata,
  );
});

test("mode 0 runs the numeric SBF executor and reports its resulting state hash", async () => {
  const { h, client, create } = await fixture();
  const read = (key: Address) => {
    const account = h.svm.getAccount(key);
    assert.ok(account.exists);
    return Buffer.from(account.data);
  };
  const enc = getAddressEncoder();
  const commands = [
    encodeCommand(command(4, { src: 0, dst: 128, len: 32, aux0: 0x3f800000 })),
    encodeCommand(command(17)),
  ];
  const modelAccount = h.svm.getAccount(client.model);
  assert.ok(modelAccount.exists);
  const model = Buffer.from(modelAccount.data);
  model.writeUInt32LE(2, 144);
  model.writeUInt32LE(1, 332);
  model.writeUInt32LE(1, 336);
  model.writeUInt32LE(2, 344);
  h.svm.setAccount({ ...modelAccount, address: client.model, data: model });
  const [plan, bump] = await getProgramDerivedAddress({
    programAddress: h.program,
    seeds: [Buffer.from("slm-pu-artifact"), enc.encode(client.model), u32(1)],
  });
  const data = Buffer.alloc(192 + 128);
  data.write("SLMPUA01");
  data[8] = 1;
  data[9] = 2;
  data[10] = 1;
  data[11] = bump;
  data.set(enc.encode(h.owner.address), 16);
  data.set(enc.encode(client.model), 48);
  data.writeUInt32LE(1, 80);
  data.writeUInt32LE(128, 84);
  data.writeUInt32LE(2, 92);
  data.set(model.subarray(80, 112), 128);
  data.set(Buffer.concat(commands), 192);
  h.svm.setAccount({
    address: plan,
    programAddress: h.program,
    data,
    executable: false,
    space: BigInt(data.length),
    lamports: lamports(10000000n),
  });
  for (const ix of [
    create,
    ...Array.from({ length: 5 }, (_, i) => client.allocateState(i)),
    client.start(),
  ])
    success((await h.execute(executionInstruction(ix))).result);
  const session = read(client.session);
  const global = read(client.states[0]);
  assert.equal(global.readFloatLE(192 + 128 * 4), 0);
  const step = await client.step(session, global, commands[0], 1);
  const result = success((await h.execute(executionInstruction(step))).result);
  const next = read(client.session);
  assert.equal(read(client.states[0]).readFloatLE(192 + 128 * 4), 1);
  assert.equal(next.readUInt32LE(176), 1);
  assert.equal(next.readUInt32LE(240), 1);
  assert.notDeepEqual(next.subarray(208, 240), session.subarray(208, 240));
  assert.deepEqual(
    Buffer.from(result.returnData().data()).subarray(24, 56),
    next.subarray(208, 240),
  );
});
