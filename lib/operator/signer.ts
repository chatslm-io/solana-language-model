import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { resolve } from "node:path";
import { privateRead, readOperatorEnv } from "./external";

// Runtime-only, imported exclusively by server/CLI entrypoints. The external
// environment is parsed locally, never copied into process.env or a client prop.
export async function localSigner(readSettings = readOperatorEnv) {
  const settings = readSettings();
  const raw = settings.SLM_PRIVATE_KEY?.trim();
  const path = settings.SLM_KEYPAIR_PATH?.trim();
  if (!raw && !path) return null;
  if (raw && path) throw new Error("Configure one local key source, not both");
  let file: Buffer | undefined, bytes: Uint8Array | undefined;
  try {
    file = path ? privateRead(resolve(path), 4096) : undefined;
    const value = file ? file.toString("utf8").trim() : raw!;
    if (value.startsWith("[")) {
      const array: unknown = JSON.parse(value);
      if (
        !Array.isArray(array) ||
        array.length !== 64 ||
        !array.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      )
        throw new Error("Invalid key format");
      bytes = Uint8Array.from(array);
      array.fill(0);
    } else {
      if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value))
        throw new Error("Invalid key format");
      bytes = Uint8Array.from(getBase58Encoder().encode(value));
    }
    if (bytes.length !== 64)
      throw new Error("Expected a 64-byte Solana secret key");
    return await createKeyPairSignerFromBytes(bytes, false);
  } catch {
    // Parser/crypto errors can include their inputs. Do not propagate a cause.
    throw new Error(
      "Cannot load the local signer. Check the external file location, chmod 600 permissions, and 64-byte Solana key format.",
    );
  } finally {
    file?.fill(0);
    bytes?.fill(0);
    delete settings.SLM_PRIVATE_KEY;
  }
}
