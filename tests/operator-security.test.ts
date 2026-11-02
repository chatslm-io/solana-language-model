import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createPrivateKey, createPublicKey } from "node:crypto";
import {
  getBase58Decoder,
  generateKeyPairSigner,
  signTransaction,
  getTransactionEncoder,
  blockhash,
} from "@solana/kit";
import { inspectSecrets } from "../scripts/secret-rules.mjs";
import { privateRead, readProtectedFile } from "../lib/operator/external";
import { localSigner } from "../lib/operator/signer";
import { transaction } from "../lib/chain/client";
import { instruction } from "../lib/chain/protocol";
import { TEST_PROGRAM } from "./vm-rpc";

test("operator configuration rejects Git paths, permissive files and symlinks; invalid secret text never escapes errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "slm-external-config-")),
    file = join(root, "operator.env"),
    previous = process.env.SLM_SIGNER_ENV_FILE;
  try {
    writeFileSync(file, "SLM_PRIVATE_KEY=invalid-secret-input", {
      mode: 0o600,
    });
    process.env.SLM_SIGNER_ENV_FILE = file;
    await assert.rejects(
      localSigner(() => ({ SLM_PRIVATE_KEY: "invalid-secret-input" })),
      (e) =>
        e instanceof Error &&
        !e.message.includes("invalid-secret-input") &&
        /Cannot load/.test(e.message),
    );
    chmodSync(file, 0o644);
    assert.throws(() => readProtectedFile(file), /private/);
    chmodSync(file, 0o600);
    symlinkSync(file, join(root, "linked.env"));
    assert.throws(() => privateRead(join(root, "linked.env")));
    mkdirSync(join(root, ".git"));
    assert.throws(() => privateRead(file), /outside every Git/);
  } finally {
    if (previous === undefined) delete process.env.SLM_SIGNER_ENV_FILE;
    else process.env.SLM_SIGNER_ENV_FILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret gate detects Solana key encodings in memory without flagging public transaction signatures", async () => {
  // Secret material never touches a file, log, Git index or exported key API.
  const seed = randomBytes(32),
    der = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const pub = createPublicKey(key)
    .export({ type: "spki", format: "der" })
    .subarray(-32);
  const bytes = Buffer.concat([seed, pub]);
  try {
    const encoded = getBase58Decoder().decode(bytes);
    assert.ok(
      inspectSecrets("accident.txt", Buffer.from(encoded)).includes(
        "Solana signing key",
      ),
    );
    assert.ok(
      inspectSecrets(
        "accident.txt",
        Buffer.from(JSON.stringify([...bytes])),
      ).includes("64-byte signing-key-shaped array"),
    );
    assert.ok(inspectSecrets("operator.env", Buffer.from("EMPTY=")).length);
    const signer = await generateKeyPairSigner(false);
    const tx = transaction(
      signer.address,
      instruction(TEST_PROGRAM, signer.address, signer.address, "seal"),
      blockhash("11111111111111111111111111111111"),
      1n,
    );
    const signed = await signTransaction([signer.keyPair], tx.tx);
    const wire = getTransactionEncoder().encode(signed);
    assert.deepEqual(
      inspectSecrets(
        "proof.txt",
        Buffer.from(getBase58Decoder().decode(wire.slice(1, 65))),
      ),
      [],
    );
  } finally {
    seed.fill(0);
    der.fill(0);
    bytes.fill(0);
  }
});
