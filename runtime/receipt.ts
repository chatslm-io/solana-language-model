import { createHash, randomBytes } from "node:crypto";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { strictJson } from "../lib/model/formats";
export const HASH = /^[0-9a-f]{64}$/;
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PREFIX = "slm-response-receipt:v1\n";
export type Payload = {
  version: 1;
  deployment: string;
  manifestSha256: string;
  reply: string;
  nonce: string;
};
export type Receipt = {
  payload: Payload;
  receiptHash: string;
  transactionSignature: string;
};
export function exact(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !== keys.sort().join("|")
  )
    throw new Error("invalid_input");
}
export function unicode(s: string) {
  if (!s.isWellFormed()) throw new Error("invalid_unicode");
}
export function parseStrict(
  input: Uint8Array | string,
  limit = 524288,
): unknown {
  if (typeof input === "string") {
    unicode(input);
    if (Buffer.byteLength(input) > limit) throw new Error("input_too_large");
  } else if (input.byteLength > limit) throw new Error("input_too_large");
  const text =
    typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          input,
        );
  if (text.charCodeAt(0) === 0xfeff) throw new Error("invalid_input");
  const result = strictJson(text);
  function visit(v: unknown, depth = 0) {
    if (depth > 32) throw new Error("invalid_input");
    if (typeof v === "string") unicode(v);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        unicode(k);
        visit(x, depth + 1);
      }
  }
  visit(result);
  return result;
}
export function validatePayload(value: unknown): Payload {
  exact(value, ["version", "deployment", "manifestSha256", "reply", "nonce"]);
  if (
    value.version !== 1 ||
    ![value.deployment, value.manifestSha256, value.nonce].every(
      (v) => typeof v === "string" && HASH.test(v),
    ) ||
    typeof value.reply !== "string" ||
    !value.reply.length ||
    Buffer.byteLength(value.reply) > 65536
  )
    throw new Error("invalid_receipt");
  unicode(value.reply);
  return value as Payload;
}
export function canonicalPayload(value: unknown) {
  const p = validatePayload(value);
  return JSON.stringify({
    deployment: p.deployment,
    manifestSha256: p.manifestSha256,
    nonce: p.nonce,
    reply: p.reply,
    version: 1,
  });
}
export function hashPayload(value: unknown) {
  return createHash("sha256")
    .update(PREFIX)
    .update(canonicalPayload(value), "utf8")
    .digest("hex");
}
export function memo(hash: string) {
  if (!HASH.test(hash)) throw new Error("invalid_hash");
  return `slm:receipt:v1:${hash}`;
}
export function validSignature(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value))
    return false;
  const bytes = getBase58Encoder().encode(value);
  return bytes.length === 64 && getBase58Decoder().decode(bytes) === value;
}
export function validateReceipt(value: unknown): Receipt {
  exact(value, ["payload", "receiptHash", "transactionSignature"]);
  const payload = validatePayload(value.payload);
  if (
    value.receiptHash !== hashPayload(payload) ||
    !validSignature(value.transactionSignature)
  )
    throw new Error("invalid_receipt");
  return value as Receipt;
}
export function makePayload(
  deployment: string,
  manifestSha256: string,
  reply: string,
): Payload {
  return validatePayload({
    version: 1,
    deployment,
    manifestSha256,
    reply,
    nonce: randomBytes(32).toString("hex"),
  });
}
