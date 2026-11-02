import { address, generateKeyPairSigner } from "@solana/kit";
import { localSigner } from "../../lib/operator/signer";
import { readOperatorEnv } from "../../lib/operator/external";

type Settings = Record<string, string | undefined>;

/** Clone-only fallback. Explicit keys or addresses must never be silently replaced. */
export async function cloneSigners(
  settings: Settings = { ...process.env, ...readOperatorEnv() },
  loadSigner: typeof localSigner = localSigner,
) {
  const signers = [];
  for (const slot of [1, 2]) {
    const path = settings[`SLM_CLONE_KEYPAIR_PATH_${slot}`]?.trim();
    const configuredAddress = settings[`SLM_APPROVED_SIGNER_${slot}`]?.trim();
    const keySettings: Record<string, string> = path
      ? { SLM_KEYPAIR_PATH: path }
      : slot === 1
        ? {
            SLM_KEYPAIR_PATH: settings.SLM_KEYPAIR_PATH ?? "",
            SLM_PRIVATE_KEY: settings.SLM_PRIVATE_KEY ?? "",
          }
        : {};
    const signer = await loadSigner(() => keySettings);
    if (configuredAddress && !signer)
      throw Error(
        `SLM_APPROVED_SIGNER_${slot} requires a matching SLM_CLONE_KEYPAIR_PATH_${slot} for clone signing`,
      );
    if (configuredAddress && address(configuredAddress) !== signer!.address)
      throw Error(`Clone wallet does not match SLM_APPROVED_SIGNER_${slot}`);
    signers.push(signer ?? (await generateKeyPairSigner()));
  }
  if (signers[0].address === signers[1].address)
    throw Error(
      "Clone upload/restart verification requires two distinct wallets",
    );
  return { signer: signers[0], inferenceSigner: signers[1] };
}
