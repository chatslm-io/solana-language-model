import { createHash, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { ristretto255 } from "@noble/curves/ed25519";
import {
  AccountRole,
  address,
  getAddressEncoder,
  type Instruction,
} from "@solana/kit";

/** Experimental encrypted affine score, NOT FHE or language-model inference. */
export const INPUT_COUNT = 4;
export const INPUT_LIMIT = 255;
export const SCORE_LIMIT = 2812;
export const WEIGHTS = Object.freeze([3, -2, 5, 1] as const);
export const BIAS = 7;
export const REQUEST_BYTES = 328;
export const OUTPUT_BYTES = 136;
export const MODEL_DESCRIPTION =
  "slm-private-linear:v1;inputs=4;weights=3,-2,5,1;bias=7;input-range=-255..255";
export const MODEL_ID = createHash("sha256")
  .update(MODEL_DESCRIPTION, "utf8")
  .digest("hex");
const REQUEST_MAGIC = Buffer.from("SLMHEI01", "ascii");
const OUTPUT_MAGIC = Buffer.from("SLMHEO01", "ascii");
const DOMAIN = Buffer.from("slm-private-linear:v1\n", "utf8");
const Point = ristretto255.Point;
type PointValue = InstanceType<typeof Point>;

function bytes(value: Uint8Array, length: number): Buffer {
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw Error("private_linear_invalid_bytes");
  return Buffer.from(value);
}
function point(value: Uint8Array, nonidentity = false): PointValue {
  const encoded = bytes(value, 32);
  try {
    const decoded = Point.fromBytes(encoded);
    if (
      !Buffer.from(decoded.toBytes()).equals(encoded) ||
      (nonidentity && decoded.is0())
    )
      throw Error("invalid");
    return decoded;
  } catch {
    throw Error("private_linear_invalid_point");
  }
}
function scalar(value: Uint8Array): bigint {
  let result = 0n;
  for (let i = value.length - 1; i >= 0; i--)
    result = (result << 8n) | BigInt(value[i]);
  return result;
}
function freshScalar(): Uint8Array {
  // Rejection sampling in a 253-bit domain: unbiased, nonzero group scalar.
  for (;;) {
    const candidate = randomBytes(32);
    candidate[31] &= 31;
    const n = scalar(candidate);
    if (n > 0n && n < Point.Fn.ORDER) return candidate;
    candidate.fill(0);
  }
}
function times(p: PointValue, n: number): PointValue {
  if (!n) return Point.ZERO;
  const result = p.multiply(BigInt(Math.abs(n)));
  return n < 0 ? result.negate() : result;
}
export type ParsedRequest = {
  publicKey: Uint8Array;
  requestId: Uint8Array;
  inputs: { r: Uint8Array; c: Uint8Array }[];
};
/** Checks public wire syntax only; it cannot establish encrypted plaintext ranges. */
export function parseRequest(request: Uint8Array): ParsedRequest {
  const data = bytes(request, REQUEST_BYTES);
  if (!data.subarray(0, 8).equals(REQUEST_MAGIC))
    throw Error("private_linear_request_magic");
  point(data.subarray(8, 40), true);
  const seenRandomness = new Set<string>();
  let aggregate = Point.ZERO;
  const inputs = Array.from({ length: INPUT_COUNT }, (_, i) => {
    const offset = 72 + i * 64;
    const r = data.subarray(offset, offset + 32),
      c = data.subarray(offset + 32, offset + 64);
    aggregate = aggregate.add(times(point(r, true), WEIGHTS[i]));
    const encodedR = r.toString("hex");
    if (seenRandomness.has(encodedR))
      throw Error("private_linear_reused_randomness");
    seenRandomness.add(encodedR);
    point(c); // C may legitimately be the identity.
    return { r: Uint8Array.from(r), c: Uint8Array.from(c) };
  });
  if (aggregate.is0()) throw Error("private_linear_zero_aggregate_randomness");
  return {
    publicKey: Uint8Array.from(data.subarray(8, 40)),
    requestId: Uint8Array.from(data.subarray(40, 72)),
    inputs,
  };
}
export function requestDigest(caller: string, request: Uint8Array): Uint8Array {
  parseRequest(request);
  return createHash("sha256")
    .update(DOMAIN)
    .update(Buffer.from(getAddressEncoder().encode(address(caller))))
    .update(request)
    .digest();
}
export function privateLinearInstruction(
  program: string,
  caller: string,
  request: Uint8Array,
): Instruction {
  parseRequest(request);
  return {
    programAddress: address(program),
    accounts: [{ address: address(caller), role: AccountRole.READONLY_SIGNER }],
    data: Uint8Array.from(request),
  };
}

export interface PrivateLinearKey {
  /** A fresh copy of the public encryption key. No secret-export operation exists. */
  readonly publicKey: Uint8Array;
  encrypt(inputs: readonly number[], requestId?: Uint8Array): Uint8Array;
  destroy(): void;
  toJSON(): never;
}
type Secret = { value: Uint8Array; destroyed: boolean };
const secrets = new WeakMap<PrivateLinearKey, Secret>();
function active(key: PrivateLinearKey): Secret {
  const secret = secrets.get(key);
  if (!secret || secret.destroyed)
    throw Error("private_linear_key_unavailable");
  return secret;
}
/** Keep only in memory. JS cannot guarantee removal of temporary BigInt/JIT copies. */
export function createPrivateLinearKey(): PrivateLinearKey {
  const secret: Secret = { value: freshScalar(), destroyed: false };
  const publicPoint = Point.BASE.multiply(scalar(secret.value));
  const publicBytes = publicPoint.toBytes();
  const key: PrivateLinearKey = {
    get publicKey() {
      active(key);
      return Uint8Array.from(publicBytes);
    },
    encrypt(inputs, requestId = randomBytes(32)) {
      active(key);
      if (
        !Array.isArray(inputs) ||
        inputs.length !== INPUT_COUNT ||
        Array.from(inputs).some(
          (n) => !Number.isSafeInteger(n) || Math.abs(n) > INPUT_LIMIT,
        )
      )
        throw Error("private_linear_input_range");
      for (;;) {
        const result = Buffer.alloc(REQUEST_BYTES);
        REQUEST_MAGIC.copy(result);
        result.set(publicBytes, 8);
        result.set(bytes(requestId, 32), 40);
        const seenRandomness = new Set<string>();
        for (let i = 0; i < INPUT_COUNT; i++) {
          const randomness = freshScalar();
          try {
            const r = scalar(randomness);
            const R = Point.BASE.multiply(r);
            const encodedR = Buffer.from(R.toBytes()).toString("hex");
            if (seenRandomness.has(encodedR)) {
              i--;
              continue;
            }
            seenRandomness.add(encodedR);
            const C = times(Point.BASE, inputs[i]).add(publicPoint.multiply(r));
            result.set(R.toBytes(), 72 + i * 64);
            result.set(C.toBytes(), 104 + i * 64);
          } finally {
            randomness.fill(0);
          }
        }
        try {
          parseRequest(result);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "private_linear_zero_aggregate_randomness"
          )
            continue;
          throw error;
        }
        return result;
      }
    },
    destroy() {
      secret.value.fill(0);
      secret.destroyed = true;
    },
    toJSON() {
      throw Error("private_linear_key_not_serializable");
    },
  };
  Object.defineProperty(key, inspect.custom, {
    value: () => "[PrivateLinearKey: redacted]",
  });
  secrets.set(key, secret);
  return Object.freeze(key);
}

export type OutputBinding = {
  request: Uint8Array;
  caller: string;
  program: string;
  returnProgram: string;
};
export type VerifiedOutput = { r: Uint8Array; c: Uint8Array };
/**
 * Binding/syntax validation only, NOT a chain proof. Before calling, authenticate
 * successful finalized execution of this exact instruction by the expected
 * program (or execute it in a trusted local VM). ElGamal is malleable, not CCA.
 */
export function verifyOutput(
  output: Uint8Array,
  binding: OutputBinding,
): VerifiedOutput {
  if (address(binding.program) !== address(binding.returnProgram))
    throw Error("private_linear_wrong_return_program");
  const data = bytes(output, OUTPUT_BYTES);
  if (!data.subarray(0, 8).equals(OUTPUT_MAGIC))
    throw Error("private_linear_output_magic");
  if (!data.subarray(8, 40).equals(Buffer.from(MODEL_ID, "hex")))
    throw Error("private_linear_model_mismatch");
  if (
    !data
      .subarray(40, 72)
      .equals(Buffer.from(requestDigest(binding.caller, binding.request)))
  )
    throw Error("private_linear_request_mismatch");
  // A zero aggregate nonce would expose the bounded score as an unmasked point.
  point(data.subarray(72, 104), true);
  point(data.subarray(104, 136));
  return {
    r: Uint8Array.from(data.subarray(72, 104)),
    c: Uint8Array.from(data.subarray(104, 136)),
  };
}
const WIDTH = SCORE_LIMIT * 2 + 1;
const STEP = Math.ceil(Math.sqrt(WIDTH));
let babySteps: Map<string, number> | undefined;
function discreteScore(value: PointValue): number {
  if (!babySteps) {
    babySteps = new Map();
    let p = Point.ZERO;
    for (let i = 0; i < STEP; i++) {
      babySteps.set(Buffer.from(p.toBytes()).toString("hex"), i);
      p = p.add(Point.BASE);
    }
  }
  let current = value.add(times(Point.BASE, SCORE_LIMIT));
  const stride = times(Point.BASE, STEP);
  for (let i = 0; i < STEP; i++) {
    const small = babySteps.get(Buffer.from(current.toBytes()).toString("hex"));
    if (small !== undefined) {
      const offset = i * STEP + small;
      if (offset < WIDTH) return offset - SCORE_LIMIT;
    }
    current = current.subtract(stride);
  }
  throw Error("private_linear_score_out_of_range");
}
/** Local decryption only. Never expose this as a public decryption oracle. */
export function decryptOutput(
  key: PrivateLinearKey,
  output: Uint8Array,
  binding: OutputBinding,
): number {
  const secret = active(key);
  const parsed = parseRequest(binding.request);
  if (!Buffer.from(parsed.publicKey).equals(Buffer.from(key.publicKey)))
    throw Error("private_linear_wrong_key");
  const verified = verifyOutput(output, binding);
  const R = point(verified.r),
    C = point(verified.c);
  const shared = R.is0() ? Point.ZERO : R.multiply(scalar(secret.value));
  return discreteScore(C.subtract(shared));
}
