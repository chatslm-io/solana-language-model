import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { sha256 } from "@/lib/chain/protocol";
import { configuredPath } from "../config/environment.mjs";
import { privateRead, readOperatorEnv } from "./external";

export async function programBinary(): Promise<Uint8Array> {
  let file;
  try {
    const env = { ...process.env, ...readOperatorEnv() };
    const manifest = JSON.parse(
      privateRead(configuredPath("SLM_PROGRAM_BUILD_FILE", env)).toString(
        "utf8",
      ),
    );
    if (
      !Number.isSafeInteger(manifest.bytes) ||
      manifest.bytes < 1 ||
      typeof manifest.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256)
    )
      throw new Error("Invalid reviewed binary metadata");
    file = await open(
      /* turbopackIgnore: true */ configuredPath("SLM_PROGRAM_BINARY", env),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== manifest.bytes)
      throw new Error("Binary size mismatch");
    const bytes = await file.readFile();
    if ((await sha256(bytes)) !== manifest.sha256)
      throw new Error("Binary hash mismatch");
    return bytes;
  } catch {
    throw new Error(
      "Set SLM_PROGRAM_BINARY and SLM_PROGRAM_BUILD_FILE to your binary and reviewed size/SHA-256 metadata",
    );
  } finally {
    await file?.close();
  }
}
