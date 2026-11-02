import {
  readFile,
  mkdir,
  open,
  writeFile,
  realpath,
  lstat,
} from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createSolanaRpc, address } from "@solana/kit";
import { createHash } from "node:crypto";
import { account, verifyDeployment } from "../lib/chain/client";
import { canonical, type Manifest } from "../lib/model/manifest";
import { HEADER, shardAddress } from "../lib/chain/protocol";
import { safeError } from "../lib/server/security";
async function main() {
  const [program, wallet, id, manifestPath, output] = process.argv.slice(2);
  if (!output || !process.env.SOLANA_RPC_URL)
    throw new Error(
      "Usage: SOLANA_RPC_URL=... npm run verify -- <program> <wallet> <deployment-id> <manifest.json> <output-directory-outside-repo>",
    );
  await mkdir(resolve(output), { recursive: true, mode: 0o700 });
  if ((await lstat(resolve(output))).isSymbolicLink())
    throw new Error("Verification output cannot be a symlink");
  const destination = await realpath(resolve(output)),
    rel = relative(await realpath(process.cwd()), destination);
  if (!rel || (!rel.startsWith("../") && !isAbsolute(rel)))
    throw new Error("Verification output must be outside the repository");
  const m = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const hash = createHash("sha256").update(canonical(m)).digest("hex");
  const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL);
  await verifyDeployment(
    rpc,
    address(program),
    address(wallet),
    id,
    hash,
    m,
    (i, ok) =>
      process.stdout.write(`Shard ${i}: ${ok ? "verified" : "FAILED"}\n`),
  );
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const f = await open(
    resolve(destination, "selected-payload.bytes"),
    "wx",
    0o600,
  );
  try {
    for (const s of m.shards) {
      const a = await account(
        rpc,
        await shardAddress(address(program), address(wallet), id, s.index),
      );
      if (!a) throw new Error("Shard disappeared during reconstruction");
      const b = a.bytes.subarray(HEADER);
      if (
        b.length !== s.length ||
        createHash("sha256").update(b).digest("hex") !== s.sha256
      )
        throw new Error("Shard changed during reconstruction");
      await f.writeFile(b);
    }
    await f.sync();
  } finally {
    await f.close();
  }
  const payload = await open(
    resolve(destination, "selected-payload.bytes"),
    "r",
  );
  try {
    for (const entry of [...m.artifacts, ...m.tensors]) {
      const h = createHash("sha256");
      for (let at = 0; at < entry.length; at += 1048576) {
        const b = Buffer.alloc(Math.min(1048576, entry.length - at));
        const r = await payload.read(b, 0, b.length, entry.payloadOffset + at);
        if (r.bytesRead !== b.length)
          throw new Error("Truncated reconstructed payload");
        h.update(b);
      }
      if (h.digest("hex") !== entry.sha256)
        throw new Error("Reconstructed tensor or metadata hash mismatch");
    }
  } finally {
    await payload.close();
  }
  await writeFile(resolve(destination, "manifest.json"), canonical(m), {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `Verified and reconstructed ${m.payloadBytes} bytes. Manifest ${hash}\n`,
  );
}
main().catch((error) => {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
});
