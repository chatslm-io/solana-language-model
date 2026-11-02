/** Public genesis fixture only. Use tokenizerClient upload methods for rent/upload gate. */
import { getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import {
  compileTokenizer,
  TOKENIZER_UNICODE_SHA256,
} from "../compiler/tokenizer";
import {
  buildTokenizerPages,
  encodeTokenizerBinding,
  tokenizerCommitment,
  TOKENIZER_PROFILE_ROOT,
  type TokenizerBinding,
} from "../tokenizer-protocol";
import { modelCommitment } from "../protocol";
import { u32 } from "./client";
import { tokenizerClient } from "./tokenizer-client";
import type { PublicModelFixture } from "./model-fixture";
export async function prepareTokenizerFixture(f: PublicModelFixture) {
  const compiled = await compileTokenizer(f.compiled.modelBytes),
    tables = buildTokenizerPages(compiled.pages),
    enc = getAddressEncoder();
  const binding: TokenizerBinding = {
      model: Buffer.from(enc.encode(f.client.model)).toString("hex"),
      modelBinding: modelCommitment(f.binding),
      sourceSha: f.binding.sourceSha,
      tableRoot: tables.root,
      profileRoot: TOKENIZER_PROFILE_ROOT,
      unicodeSha: TOKENIZER_UNICODE_SHA256,
      pageCount: 33,
      maxInputBytes: 512,
      maxMessages: 4,
      vocabulary: 8196,
    },
    client = await tokenizerClient(f, binding),
    accounts: PublicModelFixture["accounts"] = [],
    hash = Buffer.from(tokenizerCommitment(binding), "hex");
  const [, bump] = await getProgramDerivedAddress({
    programAddress: f.program,
    seeds: [
      Buffer.from("slm-pu-tokenizer"),
      enc.encode(f.client.model),
      Buffer.from(tables.root, "hex"),
    ],
  });
  const d = Buffer.alloc(384);
  d.write("SLMPTR01");
  d[8] = 1;
  d[9] = 5;
  d[10] = 1;
  d[11] = bump;
  d.set(enc.encode(f.identity.modelOwner), 16);
  d.set(enc.encode(f.client.model), 48);
  d.set(hash, 80);
  d.set(Buffer.from(tables.root, "hex"), 112);
  [33, 33, 33].forEach((v, i) => d.writeUInt32LE(v, 144 + 4 * i));
  d.set(encodeTokenizerBinding(binding), 160);
  accounts.push({ address: client.registry, data: d, lamports: 100000000n });
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
    d.set(enc.encode(f.identity.modelOwner), 16);
    d.set(enc.encode(client.registry), 48);
    [page.index, page.payload.length, page.payload.length, 1].forEach((v, i) =>
      d.writeUInt32LE(v, 80 + 4 * i),
    );
    d.set(Buffer.from(page.hash, "hex"), 96);
    d.set(hash, 128);
    d.set(page.payload, 192);
    accounts.push({ address, data: d, lamports: 100000000n });
  }
  return { compiled, tables, binding, client, accounts };
}
export type TokenizerFixture = Awaited<
  ReturnType<typeof prepareTokenizerFixture>
>;
