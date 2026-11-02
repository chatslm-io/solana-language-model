import { readFile, realpath } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import {
  canonical,
  validateManifest,
  type Manifest,
} from "../lib/model/manifest";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--env-file") {
    const path = await realpath(args[1]);
    const rel = relative(await realpath(process.cwd()), path);
    if (!rel || (!rel.startsWith("../") && !isAbsolute(rel)))
      throw new Error("Environment file must be outside the repository");
    loadEnvFile(path);
    args.splice(0, 2);
  }
  const check = args[0] === "--check";
  if (check) args.shift();
  if (args.length !== 1)
    throw new Error(
      "Usage: npm run manifest:publish -- [--env-file /external/proof.env] [--check] /external/manifest.json",
    );
  const expected = process.env.SLM_PROOF_MANIFEST_SHA256;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error(
      "Set SLM_PROOF_MANIFEST_SHA256 to the intended manifest commitment",
    );
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(args[0], "utf8")) as Manifest;
    validateManifest(manifest);
  } catch {
    throw new Error("Cannot read a valid manifest JSON file");
  }
  const json = canonical(manifest);
  const hash = createHash("sha256").update(json).digest("hex");
  if (hash !== expected)
    throw new Error(
      "Manifest checksum does not match the configured commitment",
    );
  if (check) {
    console.log(
      `Manifest validated: ${hash}; ${manifest.shards.length} shards. No database writes.`,
    );
    return;
  }
  if (!process.env.DATABASE_URL)
    throw new Error("Set DATABASE_URL in the external environment file");
  // Never print driver errors: connection strings and query data may be embedded.
  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`CREATE TABLE IF NOT EXISTS public.slm_proof_manifests (
      sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      canonical_json text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`INSERT INTO public.slm_proof_manifests (sha256, canonical_json)
      VALUES (${hash}, ${json}) ON CONFLICT (sha256) DO NOTHING`;
    const rows =
      await sql`SELECT canonical_json FROM public.slm_proof_manifests WHERE sha256 = ${hash}`;
    if (rows.length !== 1 || rows[0].canonical_json !== json)
      throw new Error("Stored manifest mismatch");
  } catch {
    throw new Error(
      "Neon publication or readback failed. Check connectivity, credentials, table permissions and schema. No credential details logged.",
    );
  }
  console.log(`Database manifest published and verified by readback: ${hash}.`);
}
main().catch((error: unknown) => {
  // Only allow our explicit diagnostics; filesystem/environment exceptions may contain secrets.
  const message = error instanceof Error ? error.message : "";
  const allowed = [
    "Usage:",
    "Environment file must",
    "Set SLM_",
    "Cannot read a valid",
    "Manifest checksum",
    "Set DATABASE_URL",
    "Neon publication",
  ];
  console.error(
    allowed.some((prefix) => message.startsWith(prefix))
      ? message
      : "Manifest publication failed. Check the external environment file and manifest path.",
  );
  process.exitCode = 1;
});
