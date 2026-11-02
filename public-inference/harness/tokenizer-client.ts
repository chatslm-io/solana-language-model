/** Serializes raw UTF-8 only. Table account selection is checked independently in SBF. */
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  encodeTokenizerBinding,
  type TokenizerBinding,
  type TokenizerPage,
} from "../tokenizer-protocol";
import { sha256 } from "../protocol";
import { tokenizerBucket } from "../compiler/tokenizer";
import { u32, u64 } from "./client";
import type { PublicModelFixture } from "./model-fixture";
const enc = getAddressEncoder(),
  system = address("11111111111111111111111111111111"),
  cap = u64(100000000n);
export async function tokenizerClient(
  f: PublicModelFixture,
  binding: TokenizerBinding,
) {
  const pda = async (
    seeds: Parameters<typeof getProgramDerivedAddress>[0]["seeds"],
  ) =>
    (await getProgramDerivedAddress({ programAddress: f.program, seeds }))[0];
  const registry = await pda([
      Buffer.from("slm-pu-tokenizer"),
      enc.encode(f.client.model),
      Buffer.from(binding.tableRoot, "hex"),
    ]),
    scratch = await pda([
      Buffer.from("slm-pu-text"),
      enc.encode(f.client.session),
    ]),
    page = (index: number) =>
      pda([Buffer.from("slm-pu-tokpage"), enc.encode(registry), u32(index)]);
  const ix = (
    data: Uint8Array,
    parent: Address,
    extras: Address[] = [],
    signer = f.signer.address,
  ): Instruction => ({
    programAddress: f.program,
    accounts: [
      { address: signer, role: AccountRole.WRITABLE_SIGNER },
      { address: parent, role: AccountRole.WRITABLE },
      ...extras.map((a) => ({
        address: a,
        role: a === system ? AccountRole.READONLY : AccountRole.WRITABLE,
      })),
    ],
    data,
  });
  return {
    registry,
    scratch,
    page,
    createRegistry: () =>
      ix(
        Buffer.concat([
          Buffer.from([14]),
          encodeTokenizerBinding(binding),
          cap,
        ]),
        registry,
        [f.client.model, system],
      ),
    allocatePage: async (p: TokenizerPage) =>
      ix(
        Buffer.concat([
          Buffer.from([15]),
          u32(p.index),
          u32(p.payload.length),
          cap,
          Buffer.from(p.hash, "hex"),
          u32(1),
          ...p.proof.map((p) => Buffer.from(p, "hex")),
        ]),
        registry,
        [await page(p.index), system],
      ),
    writePage: async (index: number, offset: number, bytes: Uint8Array) =>
      ix(Buffer.concat([Buffer.from([16]), u32(offset), bytes]), registry, [
        await page(index),
      ]),
    sealPage: async (index: number) =>
      ix(Buffer.from([17]), registry, [await page(index)]),
    sealRegistry: () => ix(Buffer.from([18]), registry),
    closePage: async (index: number) =>
      ix(Buffer.from([19]), registry, [await page(index)]),
    closeRegistry: () => ix(Buffer.from([20]), registry),
    createText: (
      frame: Uint8Array,
      outputs: number,
      expiry: bigint,
      executor = f.signer.address,
    ) =>
      ix(
        Buffer.concat([
          Buffer.from([21]),
          f.client.sessionNonce,
          Buffer.from(enc.encode(executor)),
          u64(expiry),
          u32(outputs),
          u32(frame.length),
          Buffer.from(sha256(frame), "hex"),
          cap,
          cap,
        ]),
        f.client.session,
        [f.client.model, registry, scratch, system],
      ),
    writeRaw: (offset: number, bytes: Uint8Array) =>
      ix(
        Buffer.concat([Buffer.from([22]), u32(offset), bytes]),
        f.client.session,
        [scratch],
      ),
    sealRaw: () => ix(Buffer.from([23]), f.client.session, [scratch]),
    step: async (scratchBytes: Uint8Array) => {
      const d = Buffer.from(scratchBytes),
        work = d.subarray(804),
        phase = work.readUInt32LE(8);
      let desired: number | undefined;
      if (phase === 2) desired = 0;
      else if (phase === 3) {
        const scan = work.readUInt32LE(40),
          count = work.readUInt32LE(36);
        if (scan + 1 < count)
          desired =
            1 +
            tokenizerBucket(
              work.readUInt32LE(1280 + scan * 4),
              work.readUInt32LE(1280 + (scan + 1) * 4),
            );
      }
      return ix(
        Buffer.concat([
          Buffer.from([24]),
          d.subarray(216, 220),
          d.subarray(176, 208),
        ]),
        f.client.session,
        [
          scratch,
          registry,
          ...(desired === undefined ? [] : [await page(desired)]),
        ],
      );
    },
    closeText: () => ix(Buffer.from([25]), f.client.session, [scratch]),
  };
}
