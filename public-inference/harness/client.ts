/** Instruction construction only. Numeric work is performed by the SBF program. */
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  encodeModelBinding,
  decodeCommand,
  NONE,
  BATCH,
  type ModelBinding,
  type ArtifactPage,
} from "../protocol";
const enc = getAddressEncoder(),
  system = address("11111111111111111111111111111111");
export const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
export const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const cap = u64(100000000n);
export async function publicClient(
  program: Address,
  owner: Address,
  modelNonce: Uint8Array,
  sessionNonce: Uint8Array,
  modelOwner: Address = owner,
) {
  const pda = async (
    seeds: Parameters<typeof getProgramDerivedAddress>[0]["seeds"],
  ) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
  const model = await pda([
      Buffer.from("slm-pu-model"),
      enc.encode(modelOwner),
      modelNonce,
    ]),
    session = await pda([
      Buffer.from("slm-pu-session"),
      enc.encode(owner),
      sessionNonce,
    ]);
  const artifact = (i: number) =>
      pda([Buffer.from("slm-pu-artifact"), enc.encode(model), u32(i)]),
    states = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        pda([Buffer.from("slm-pu-state"), enc.encode(session), u32(i)]),
      ),
    );
  const ix = (
    data: Uint8Array,
    parent: Address,
    extra: Address[] = [],
    signer = owner,
  ): Instruction => ({
    programAddress: program,
    accounts: [
      { address: signer, role: AccountRole.WRITABLE_SIGNER },
      { address: parent, role: AccountRole.WRITABLE },
      ...extra.map((a) => ({
        address: a,
        role: a === system ? AccountRole.READONLY : AccountRole.WRITABLE,
      })),
    ],
    data,
  });
  return {
    model,
    session,
    sessionNonce: Uint8Array.from(sessionNonce),
    artifact,
    states,
    createModel: (m: ModelBinding) =>
      ix(Buffer.concat([Buffer.from([0]), encodeModelBinding(m), cap]), model, [
        system,
      ]),
    allocateArtifact: async (p: ArtifactPage) =>
      ix(
        Buffer.concat([
          Buffer.from([1]),
          u32(p.index),
          u32(p.payload.length),
          cap,
          Buffer.from(p.hash, "hex"),
          u32(p.kind),
          ...p.proof.map((v) => Buffer.from(v, "hex")),
        ]),
        model,
        [await artifact(p.index), system],
      ),
    writeArtifact: async (i: number, offset: number, bytes: Uint8Array) =>
      ix(Buffer.concat([Buffer.from([2]), u32(offset), bytes]), model, [
        await artifact(i),
      ]),
    sealArtifact: async (i: number) =>
      ix(Buffer.from([3]), model, [await artifact(i)]),
    sealModel: () => ix(Buffer.from([4]), model),
    createSession: (
      prompt: readonly number[],
      outputs: number,
      expiry: bigint,
      executor = owner,
    ) => {
      if (
        prompt.length < 1 ||
        prompt.length > 15 ||
        outputs < 1 ||
        outputs + prompt.length > 16
      )
        throw Error("public_session_bound");
      const tokens = Buffer.alloc(64);
      prompt.forEach((t, i) => tokens.writeUInt32LE(t, i * 4));
      return ix(
        Buffer.concat([
          Buffer.from([7]),
          sessionNonce,
          Buffer.from(enc.encode(executor)),
          u64(expiry),
          u32(outputs),
          u32(prompt.length),
          tokens,
          cap,
        ]),
        session,
        [model, system],
      );
    },
    allocateState: (i: number) =>
      ix(Buffer.concat([Buffer.from([8]), u32(i), cap]), session, [
        states[i],
        system,
      ]),
    start: () => ix(Buffer.from([9]), session, [model]),
    step: async (
      sessionBytes: Uint8Array,
      globalBytes: Uint8Array,
      commandBytes: Uint8Array,
      weightPages: number,
      executor = owner,
    ) => {
      const s = Buffer.from(sessionBytes),
        g = Buffer.from(globalBytes),
        c = decodeCommand(commandBytes),
        pc = s.readUInt32LE(176),
        token = s.readUInt32LE(184),
        extras = [
          model,
          await artifact(weightPages + Math.floor(pc / 128)),
          states[0],
        ];
      if ([1, 3, 5, 14, 19].includes(c.op)) {
        let selected = c.weightPage;
        if (c.op === 1) {
          const rowBytes =
            c.format === 1
              ? (c.cols / 32) * 34
              : c.cols * (c.format === 2 ? 2 : 4);
          selected += Math.floor(token / Math.floor(8192 / rowBytes));
        } else if (c.selector !== NONE) {
          const id = g.readFloatLE(192 + c.selector * 4);
          if (!Number.isInteger(id) || id < 0 || id >= 8)
            throw Error("public_expert_state");
          selected += id * c.expertStride;
        }
        extras.push(await artifact(selected));
      }
      if ([10, 11, 13].includes(c.op)) extras.push(states[c.aux0 + 1]);
      return ix(
        Buffer.concat([
          Buffer.from([10]),
          s.subarray(240, 244),
          u32(pc),
          s.subarray(208, 240),
        ]),
        session,
        extras,
        executor,
      );
    },
    batch: async (
      sessionBytes: Uint8Array,
      globalBytes: Uint8Array,
      commandBytes: readonly Uint8Array[],
      weightPages: number,
      executor = owner,
    ): Promise<Instruction> => {
      if (commandBytes.length < 1 || commandBytes.length > BATCH.maxCommands)
        throw Error("public_batch_count");
      const sessionData = Buffer.from(sessionBytes),
        globalData = Buffer.from(globalBytes),
        pc = sessionData.readUInt32LE(176),
        token = sessionData.readUInt32LE(184);
      const accounts: { address: Address; role: AccountRole }[] = [
        { address: executor, role: AccountRole.WRITABLE_SIGNER },
        { address: session, role: AccountRole.WRITABLE },
        { address: model, role: AccountRole.READONLY },
        { address: states[0], role: AccountRole.WRITABLE },
      ];
      const add = (a: Address, writable = false) => {
        const found = accounts.findIndex((v) => v.address === a);
        if (found >= 0) {
          if (found < 4) throw Error("public_batch_account_alias");
          if (writable) accounts[found].role = AccountRole.WRITABLE;
          return found;
        }
        if (accounts.length >= BATCH.maxAccounts)
          throw Error("public_batch_account_bound");
        accounts.push({
          address: a,
          role: writable ? AccountRole.WRITABLE : AccountRole.READONLY,
        });
        return accounts.length - 1;
      };
      const maps = Buffer.alloc(commandBytes.length * 3, 255);
      for (let i = 0; i < commandBytes.length; i++) {
        const c = decodeCommand(commandBytes[i]);
        if ((c.op === 14 || c.op === 17) && i + 1 !== commandBytes.length)
          throw Error("public_batch_state_boundary");
        maps[i * 3] = add(
          await artifact(weightPages + Math.floor((pc + i) / 128)),
        );
        if ([1, 3, 5, 14, 19].includes(c.op)) {
          let selected = c.weightPage;
          if (c.op === 1) {
            const rowBytes =
              c.format === 1
                ? (c.cols / 32) * 34
                : c.cols * (c.format === 2 ? 2 : 4);
            selected += Math.floor(token / Math.floor(8192 / rowBytes));
          } else if (c.selector !== NONE) {
            const id = globalData.readFloatLE(192 + c.selector * 4);
            if (!Number.isInteger(id) || id < 0 || id >= 8)
              throw Error("public_expert_state");
            selected += id * c.expertStride;
          }
          maps[i * 3 + 1] = add(await artifact(selected));
        }
        if ([10, 11, 13].includes(c.op))
          maps[i * 3 + 2] = add(states[c.aux0 + 1], true);
      }
      return {
        programAddress: program,
        accounts,
        data: Buffer.concat([
          Buffer.from([BATCH.tag]),
          sessionData.subarray(240, 244),
          u32(pc),
          sessionData.subarray(208, 240),
          Buffer.from([commandBytes.length]),
          maps,
        ]),
      };
    },
    closeState: (i: number) =>
      ix(Buffer.concat([Buffer.from([12]), u32(i)]), session, [states[i]]),
    closeSession: () => ix(Buffer.from([13]), session),
    closeArtifact: async (i: number) =>
      ix(Buffer.from([5]), model, [await artifact(i)]),
    closeModel: () => ix(Buffer.from([6]), model),
  };
}
