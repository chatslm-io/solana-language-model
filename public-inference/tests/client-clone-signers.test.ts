import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner } from "@solana/kit";
import { cloneSigners } from "../harness/clone-signers";

test("unconfigured clone wallets are fresh, distinct, in-memory signers", async () => {
  const first = await cloneSigners({});
  const second = await cloneSigners({});
  assert.notEqual(first.signer.address, first.inferenceSigner.address);
  assert.notEqual(first.signer.address, second.signer.address);
});

test("clone uses configured wallets and validates the compiled allowlist", async () => {
  const first = await generateKeyPairSigner();
  const second = await generateKeyPairSigner();
  const settings = {
    SLM_KEYPAIR_PATH: "operator-wallet",
    SLM_CLONE_KEYPAIR_PATH_2: "second-wallet",
    SLM_APPROVED_SIGNER_1: first.address,
    SLM_APPROVED_SIGNER_2: second.address,
  };
  const loader = async (read = () => ({}) as Record<string, string>) =>
    read().SLM_KEYPAIR_PATH === "operator-wallet" ? first : second;
  const result = await cloneSigners(settings, loader);
  assert.equal(result.signer, first);
  assert.equal(result.inferenceSigner, second);
  await assert.rejects(
    cloneSigners(
      { ...settings, SLM_APPROVED_SIGNER_1: second.address },
      loader,
    ),
    /does not match/,
  );
  await assert.rejects(
    cloneSigners({ SLM_APPROVED_SIGNER_1: first.address }),
    /requires a matching/,
  );
});

test("only the unspecified clone slot falls back; invalid keys propagate", async () => {
  const first = await generateKeyPairSigner();
  const result = await cloneSigners(
    { SLM_CLONE_KEYPAIR_PATH_1: "configured" },
    async (read) => (read!().SLM_KEYPAIR_PATH === "configured" ? first : null),
  );
  assert.equal(result.signer, first);
  assert.notEqual(result.inferenceSigner.address, first.address);
  await assert.rejects(
    cloneSigners({ SLM_CLONE_KEYPAIR_PATH_1: "bad" }, async () => {
      throw Error("invalid key");
    }),
    /invalid key/,
  );
});
