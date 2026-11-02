/** Public metadata only on disk; model/ELF fixtures remain in memory. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { address } from "@solana/kit";
import { prepareModelFixture } from "../harness/model-fixture";
import { modelCommitment } from "../protocol";
import {
  openRetainedLedger,
  fixtureCommitment,
  verifyRetainedFixture,
  checkRetainedPins,
  validateManifest,
  type RetainedManifest,
} from "../harness/retained-ledger";
import type { PrivateDirectory } from "../../lib/operator/external";
const sha = (bytes: Uint8Array | string) =>
    createHash("sha256").update(bytes).digest("hex"),
  code = Buffer.from("synthetic public ELF bytes"),
  loader = address("BPFLoader2111111111111111111111111111111111"),
  genesis = "11111111111111111111111111111111";
let prepared: ReturnType<typeof prepareModelFixture> | undefined;
const fixture = () => (prepared ??= prepareModelFixture());
async function environment() {
  const f = await fixture();
  const accounts = new Map<
    string,
    {
      owner: string;
      executable: boolean;
      data: [string, string];
      lamports: bigint;
    }
  >(
    f.accounts.map((a) => [
      a.address,
      {
        owner: f.program,
        executable: false,
        data: [Buffer.from(a.data).toString("base64"), "base64"],
        lamports: a.lamports,
      },
    ]),
  );
  accounts.set(f.program, {
    owner: loader,
    executable: true,
    data: [code.toString("base64"), "base64"],
    lamports: 1n,
  });
  let contextSlot = 10,
    genesisValue = genesis;
  const rpc = {
    async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
      if (method === "getGenesisHash") return genesisValue as T;
      assert.equal(method, "getMultipleAccounts");
      const config = params[1] as {
        commitment: string;
        minContextSlot: number;
      };
      assert.equal(config.commitment, "finalized");
      return {
        context: { slot: contextSlot },
        value: (params[0] as string[]).map((key) => accounts.get(key) ?? null),
      } as T;
    },
  };
  const pins = await verifyRetainedFixture(rpc, f, code),
    manifest: RetainedManifest = {
      version: 1,
      identity: f.identity,
      genesis: pins.genesis,
      program: f.program,
      binarySha256: sha(code),
      sourceSha256: f.binding.sourceSha,
      modelBinding: modelCommitment(f.binding),
      fixtureRoot: fixtureCommitment(f),
      programAccounts: pins.programAccounts,
      clone: {
        sourceAccount: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        sourceOwner: loader,
        sourceSlots: ["1", "2"],
        sourceSha256: "00".repeat(32),
        atomicHistoricalSnapshot: false,
      },
    };
  return {
    f,
    rpc,
    accounts,
    manifest,
    setSlot(n: number) {
      contextSlot = n;
    },
    setGenesis(s: string) {
      genesisValue = s;
    },
  };
}
function paths(root: string) {
  return {
    privateDirectory(p: string) {
      assert.ok(resolve(p).startsWith(root + "/"));
      mkdirSync(p, { recursive: true, mode: 0o700 });
      assert.equal(lstatSync(p).isSymbolicLink(), false);
      return p as PrivateDirectory;
    },
  };
}
test(
  "retained ledger lock and manifest preserve public identity without storing a signer",
  { timeout: 120000 },
  async () => {
    const { manifest } = await environment(),
      root = mkdtempSync("/tmp/slm-retained-test-"),
      ledger = join(root, "retained"),
      state = join(root, "run-1"),
      policy = paths(root);
    try {
      const first = openRetainedLedger(ledger, state, policy);
      assert.equal(first.manifest, undefined);
      assert.throws(
        () => openRetainedLedger(ledger, join(root, "run-2"), policy),
        /locked/,
      );
      mkdirSync(join(ledger, "ledger"), { mode: 0o700 });
      writeFileSync(
        join(ledger, "ledger", "genesis.bin"),
        "synthetic genesis",
        { mode: 0o600 },
      );
      first.save(manifest);
      assert.equal(
        statSync(join(ledger, "fixture-manifest.json")).mode & 0o777,
        0o600,
      );
      assert.throws(() => first.save(manifest), /already_exists/);
      first.close();
      assert.equal(existsSync(join(ledger, "retained.lock")), false);
      const second = openRetainedLedger(ledger, join(root, "run-3"), policy);
      assert.deepEqual(second.manifest, manifest);
      second.close();
      const serialized = readFileSync(
        join(ledger, "fixture-manifest.json"),
        "utf8",
      );
      assert.ok(
        !serialized.includes("keyPair") && !serialized.includes("secretKey"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test("retained ledger refuses stale locks, missing manifests and overlapping or symlink paths", () => {
  const root = mkdtempSync("/tmp/slm-retained-test-"),
    policy = paths(root),
    ledger = join(root, "retained"),
    state = join(root, "run");
  try {
    assert.throws(() => openRetainedLedger(ledger, ledger, policy), /overlap/);
    assert.throws(
      () => openRetainedLedger(ledger, join(ledger, "run"), policy),
      /overlap/,
    );
    writeFileSync(join(ledger, "retained.lock"), "stale fixture", {
      mode: 0o600,
    });
    assert.throws(() => openRetainedLedger(ledger, state, policy), /locked/);
    assert.equal(
      readFileSync(join(ledger, "retained.lock"), "utf8"),
      "stale fixture",
    );
    rmSync(join(ledger, "retained.lock"));
    mkdirSync(join(ledger, "ledger"), { mode: 0o700 });
    assert.throws(
      () => openRetainedLedger(ledger, state, policy),
      /missing_manifest/,
    );
    assert.equal(existsSync(join(ledger, "retained.lock")), false);
    symlinkSync(ledger, join(root, "link"));
    assert.throws(() => openRetainedLedger(join(root, "link"), state, policy));
    symlinkSync(ledger, join(root, "alias"));
    assert.throws(
      () =>
        openRetainedLedger(ledger, join(root, "alias", "nested-run"), policy),
      /overlap/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test(
  "retained verification rejects changed source, binary, genesis, accounts and executable program",
  { timeout: 120000 },
  async () => {
    const e = await environment();
    await verifyRetainedFixture(e.rpc, e.f, code, e.manifest);
    assert.doesNotThrow(() =>
      checkRetainedPins(e.f, code, {
        ...e.manifest,
        identity: {
          modelNonce: e.manifest.identity.modelNonce,
          modelOwner: e.manifest.identity.modelOwner,
        },
      }),
    );
    for (const field of [
      "binarySha256",
      "sourceSha256",
      "modelBinding",
      "fixtureRoot",
    ] as const)
      assert.throws(
        () =>
          checkRetainedPins(e.f, code, {
            ...e.manifest,
            [field]: "ff".repeat(32),
          }),
        /pin_mismatch/,
      );
    assert.throws(
      () =>
        validateManifest({
          ...e.manifest,
          secretKey: "must reject unknown fields",
        }),
      /schema/,
    );
    e.setGenesis(e.f.program);
    await assert.rejects(
      verifyRetainedFixture(e.rpc, e.f, code, e.manifest),
      /genesis_mismatch/,
    );
    e.setGenesis(genesis);
    const key = e.f.accounts[0].address,
      original = e.accounts.get(key)!;
    e.accounts.set(key, {
      ...original,
      data: [
        Buffer.from("changed public fixture").toString("base64"),
        "base64",
      ],
    });
    await assert.rejects(
      verifyRetainedFixture(e.rpc, e.f, code, e.manifest),
      /account_mismatch/,
    );
    e.accounts.set(key, original);
    const program = e.accounts.get(e.f.program)!;
    e.accounts.set(e.f.program, { ...program, executable: false });
    await assert.rejects(
      verifyRetainedFixture(e.rpc, e.f, code, e.manifest),
      /not_executable/,
    );
    e.accounts.set(e.f.program, {
      ...program,
      data: [Buffer.from("changed code").toString("base64"), "base64"],
    });
    await assert.rejects(
      verifyRetainedFixture(e.rpc, e.f, code, e.manifest),
      /elf_mismatch/,
    );
    e.accounts.set(e.f.program, program);
    e.setSlot(-1);
    await assert.rejects(
      verifyRetainedFixture(e.rpc, e.f, code, e.manifest),
      /context/,
    );
  },
);
