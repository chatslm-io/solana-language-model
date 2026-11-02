import { approvedSigners } from "../lib/config/environment.mjs";
import {
  address,
  createSignerFromKeyPair,
  generateKeyPairSigner,
  getAddressEncoder,
} from "@solana/kit";

export const APPROVED_TEST_ADDRESSES = approvedSigners().map((value) =>
  address(value),
);

// Local VM impersonation only. These unrelated ephemeral keys cannot sign for
// the real wallets. Callers must explicitly disable LiteSVM signature checking.
export async function approvedTestSigner(index: 0 | 1 = 0) {
  const ephemeral = await generateKeyPairSigner();
  const publicKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(getAddressEncoder().encode(APPROVED_TEST_ADDRESSES[index])),
    { name: "Ed25519" },
    true,
    ["verify"],
  );
  return createSignerFromKeyPair({
    publicKey,
    privateKey: ephemeral.keyPair.privateKey,
  });
}
