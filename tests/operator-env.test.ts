import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  rmdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { readOperatorEnv } from "../lib/operator/external";

test("blank operator settings preserve environment values; explicit settings override them", () => {
  const root = resolve(".local");
  const existed = existsSync(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, "env-test-"));
  const previous = process.env.SLM_SIGNER_ENV_FILE;
  try {
    const path = join(dir, "operator.env");
    writeFileSync(
      path,
      'SLM_APPROVED_SIGNER_1=\nSLM_RPC_RPS="   "\nSLM_MAX_TRANSACTIONS=250\nSLM_PUBLIC_FULL_UPLOAD=0\n',
      { mode: 0o600 },
    );
    process.env.SLM_SIGNER_ENV_FILE = path;
    const result = {
      ...{
        SLM_APPROVED_SIGNER_1: "configured-address",
        SLM_RPC_RPS: "50",
        SLM_MAX_TRANSACTIONS: "100",
      },
      ...readOperatorEnv(),
    };
    assert.equal(result.SLM_APPROVED_SIGNER_1, "configured-address");
    assert.equal(result.SLM_RPC_RPS, "50");
    assert.equal(result.SLM_MAX_TRANSACTIONS, "250");
    assert.equal(readOperatorEnv().SLM_PUBLIC_FULL_UPLOAD, "0");
  } finally {
    if (previous === undefined) delete process.env.SLM_SIGNER_ENV_FILE;
    else process.env.SLM_SIGNER_ENV_FILE = previous;
    rmSync(dir, { recursive: true });
    if (!existed) rmdirSync(root);
  }
});
