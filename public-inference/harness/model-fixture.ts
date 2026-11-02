/** Explicit inference-only genesis fixture. Model account lamports are synthetic
 * genesis balances, never owner-paid deposits. No signer is serialized. */
import { randomBytes } from "node:crypto";
import {
  generateKeyPairSigner,
  address,
  getAddressEncoder,
  getAddressDecoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import { compilePublicModel } from "../compiler/compile";
import { loadTarget } from "../reference/load-target";
import {
  buildArtifacts,
  encodeModelBinding,
  modelCommitment,
  sha256,
  type ModelBinding,
} from "../protocol";
import { canonical } from "../../lib/model/manifest";
import { publicClient, u32 } from "./client";
const TEST_PROGRAM = getAddressDecoder().decode(new Uint8Array(32).fill(183));
export type PublicFixtureIdentity = { modelOwner: Address; modelNonce: string };
export async function prepareModelFixture(
  bytes?: Uint8Array,
  progress: (message: string) => void = () => {},
  identity?: PublicFixtureIdentity,
  suppliedSigner?: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  program: Address = TEST_PROGRAM,
) {
  if (
    identity &&
    (Object.keys(identity).sort().join(",") !== "modelNonce,modelOwner" ||
      !/^[0-9a-f]{64}$/.test(identity.modelNonce))
  )
    throw Error("public_fixture_identity");
  const compiled = await compilePublicModel(
      bytes ?? (await loadTarget(progress)),
    ),
    signer = suppliedSigner ?? (await generateKeyPairSigner()),
    modelOwner = identity ? address(identity.modelOwner) : signer.address,
    nonce = identity
      ? Buffer.from(identity.modelNonce, "hex")
      : randomBytes(32),
    client = await publicClient(
      program,
      signer.address,
      nonce,
      randomBytes(32),
      modelOwner,
    ),
    enc = getAddressEncoder();
  const artifacts = buildArtifacts([
    ...compiled.weights.pages.map((payload) => ({ kind: 1 as const, payload })),
    ...compiled.planPages.map((payload) => ({ kind: 2 as const, payload })),
  ]);
  const binding: ModelBinding = {
    nonce: nonce.toString("hex"),
    sourceSha: compiled.plan.source.sha256,
    inventoryRoot: compiled.planRoot,
    artifactRoot: artifacts.root,
    numericRoot: sha256(canonical(compiled.plan.numeric)),
    totalPages: artifacts.pages.length,
    weightPages: compiled.weights.pages.length,
    planPageStart: compiled.weights.pages.length,
    planPages: compiled.planPages.length,
    commandCount: compiled.commands.length,
    context: 16,
    vocab: 8196,
    layers: 4,
    dim: 128,
    maxTokens: 16,
  };
  const bind = Buffer.from(modelCommitment(binding), "hex"),
    accounts: { address: Address; data: Uint8Array; lamports: bigint }[] = [];
  const [, bump] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [Buffer.from("slm-pu-model"), enc.encode(modelOwner), nonce],
  });
  const d = Buffer.alloc(384);
  d.write("SLMPUM01");
  d[8] = 1;
  d[9] = 1;
  d[10] = 1;
  d[11] = bump;
  d.set(enc.encode(modelOwner), 16);
  d.set(nonce, 48);
  d.set(bind, 80);
  d.set(Buffer.from(artifacts.root, "hex"), 112);
  [
    artifacts.pages.length,
    artifacts.pages.length,
    artifacts.pages.length,
  ].forEach((v, i) => d.writeUInt32LE(v, 144 + i * 4));
  d.set(encodeModelBinding(binding), 160);
  accounts.push({ address: client.model, data: d, lamports: 100000000n });
  for (const page of artifacts.pages) {
    const [address, bump] = await getProgramDerivedAddress({
        programAddress: program,
        seeds: [
          Buffer.from("slm-pu-artifact"),
          enc.encode(client.model),
          u32(page.index),
        ],
      }),
      d = Buffer.alloc(192 + page.payload.length);
    d.write("SLMPUA01");
    d[8] = 1;
    d[9] = 2;
    d[10] = 1;
    d[11] = bump;
    d.set(enc.encode(modelOwner), 16);
    d.set(enc.encode(client.model), 48);
    [page.index, page.payload.length, page.payload.length, page.kind].forEach(
      (v, i) => d.writeUInt32LE(v, 80 + i * 4),
    );
    d.set(Buffer.from(page.hash, "hex"), 96);
    d.set(bind, 128);
    d.set(page.payload, 192);
    accounts.push({ address, data: d, lamports: 100000000n });
  }
  return {
    signer,
    identity: { modelOwner, modelNonce: nonce.toString("hex") },
    compiled,
    artifacts,
    binding,
    client,
    accounts,
    program,
  };
}
export type PublicModelFixture = Awaited<
  ReturnType<typeof prepareModelFixture>
>;
