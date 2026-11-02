/** Independent cleartext conformance oracle only. Never import into a coordinator or SBF path.
 * Explicit scalar IEEE754 binary32 rounding; no claim of parity with a SIMD/GPU reduction.
 */
const f = Math.fround;
function finite(values: readonly number[]) {
  if (values.some((x) => !Number.isFinite(x)))
    throw Error("reference_nonfinite");
}
export function f16(bits: number): number {
  if (!Number.isInteger(bits) || bits < 0 || bits > 65535)
    throw Error("reference_f16");
  const sign = bits & 0x8000 ? -1 : 1,
    exponent = (bits >>> 10) & 31,
    fraction = bits & 1023;
  return exponent === 31
    ? fraction
      ? NaN
      : sign * Infinity
    : sign *
        (exponent ? 1 + fraction / 1024 : fraction / 1024) *
        2 ** (exponent ? exponent - 15 : -14);
}
export function decodeQ8_0(bytes: Uint8Array): Float32Array {
  if (!bytes.length || bytes.length % 34)
    throw Error("reference_q8_block_length");
  const result = new Float32Array((bytes.length / 34) * 32);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; at += 34) {
    const scale = f16(view.getUint16(at, true));
    if (!Number.isFinite(scale)) throw Error("reference_q8_scale");
    for (let j = 0; j < 32; j++)
      result[(at / 34) * 32 + j] = f(scale * view.getInt8(at + 2 + j));
  }
  return result;
}
export function dot(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) throw Error("reference_shape");
  finite(a);
  finite(b);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum = f(sum + f(a[i] * b[i]));
  return sum;
}
export function rmsNorm(
  x: readonly number[],
  weight: readonly number[],
  epsilon: number,
): number[] {
  if (!Number.isFinite(epsilon) || epsilon <= 0 || x.length !== weight.length)
    throw Error("reference_norm");
  finite(weight);
  const denominator = f(
    1 / f(Math.sqrt(f(f(dot(x, x) / x.length) + f(epsilon)))),
  );
  return x.map((v, i) => f(f(v * denominator) * weight[i]));
}
export function softmax(x: readonly number[]): number[] {
  if (!x.length) throw Error("reference_shape");
  finite(x);
  let maximum = x[0];
  for (const value of x) maximum = Math.max(maximum, value);
  const exp = x.map((v) => f(Math.exp(f(v - maximum))));
  let sum = 0;
  for (const value of exp) sum = f(sum + value);
  return exp.map((value) => f(value / sum));
}
export function sigmoid(x: number): number {
  finite([x]);
  return x >= 0
    ? f(1 / f(1 + f(Math.exp(-x))))
    : f(f(Math.exp(x)) / f(1 + f(Math.exp(x))));
}
export function silu(x: number): number {
  return f(f(x) * sigmoid(f(x)));
}
/** Stable descending score ordering, lowest index wins ties. Selection bias does not affect weights. */
export function routeExperts(
  logits: readonly number[],
  bias: readonly number[],
  count: number,
): { indices: number[]; weights: number[] } {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > logits.length ||
    logits.length !== bias.length
  )
    throw Error("reference_route");
  finite(bias);
  const probabilities = logits.map(sigmoid);
  const indices = probabilities
    .map((_, i) => i)
    .sort(
      (a, b) =>
        f(probabilities[b] + bias[b]) - f(probabilities[a] + bias[a]) || a - b,
    )
    .slice(0, count);
  let sum = 0;
  for (const i of indices) sum = f(sum + probabilities[i]);
  if (!sum) throw Error("reference_route_underflow");
  return { indices, weights: indices.map((i) => f(probabilities[i] / sum)) };
}
export function causalAttention(
  query: readonly number[],
  keys: readonly (readonly number[])[],
  values: readonly (readonly number[])[],
): number[] {
  if (
    !keys.length ||
    keys.length !== values.length ||
    !values[0].length ||
    values.some((v) => v.length !== values[0].length)
  )
    throw Error("reference_shape");
  values.forEach(finite);
  const scale = f(1 / Math.sqrt(query.length));
  const probabilities = softmax(keys.map((k) => f(dot(query, k) * scale)));
  return values[0].map((_, col) => {
    let sum = 0;
    for (let row = 0; row < values.length; row++)
      sum = f(sum + f(probabilities[row] * values[row][col]));
    return sum;
  });
}

/** Round binary32 to binary16, nearest/ties-to-even. Used only by the reference. */
export function toF16Bits(value: number): number {
  const f32 = new Float32Array([value]);
  const bits = new Uint32Array(f32.buffer)[0],
    sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 255) - 127 + 15,
    mantissa = bits & 0x7fffff;
  if (((bits >>> 23) & 255) === 255) return sign | (mantissa ? 0x7e00 : 0x7c00);
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent < -10) return sign;
  const significand = exponent <= 0 ? mantissa | 0x800000 : mantissa;
  const shift = exponent <= 0 ? 14 - exponent : 13;
  let rounded = Math.floor(significand / 2 ** shift);
  const remainder = significand % 2 ** shift,
    halfway = 2 ** (shift - 1);
  if (remainder > halfway || (remainder === halfway && rounded & 1)) rounded++;
  return sign | ((exponent <= 0 ? 0 : exponent << 10) + rounded);
}
/** Independent ggml quantize_row_q8_0_ref semantics; optimized CPU rounding can differ. */
export function quantizeQ8_0Reference(values: readonly number[]): Uint8Array {
  if (!values.length || values.length % 32) throw Error("reference_q8_shape");
  finite(values);
  const bytes = new Uint8Array((values.length / 32) * 34),
    view = new DataView(bytes.buffer);
  for (let block = 0; block < values.length / 32; block++) {
    let maximum = 0;
    for (let j = 0; j < 32; j++)
      maximum = Math.max(maximum, Math.abs(f(values[block * 32 + j])));
    const scale = f(maximum / 127),
      inverse = scale ? f(1 / scale) : 0;
    view.setUint16(block * 34, toF16Bits(scale), true);
    for (let j = 0; j < 32; j++) {
      const value = f(f(values[block * 32 + j]) * inverse);
      view.setInt8(
        block * 34 + 2 + j,
        Math.sign(value) * Math.floor(Math.abs(value) + 0.5),
      );
    }
  }
  return bytes;
}
export function dotQ8_0Reference(a: Uint8Array, b: Uint8Array): number {
  if (!a.length || a.length !== b.length || a.length % 34)
    throw Error("reference_q8_shape");
  const av = new DataView(a.buffer, a.byteOffset, a.byteLength),
    bv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let total = 0;
  for (let at = 0; at < a.length; at += 34) {
    let integer = 0;
    for (let j = 0; j < 32; j++)
      integer += av.getInt8(at + 2 + j) * bv.getInt8(at + 2 + j);
    const scale = f(f16(av.getUint16(at, true)) * f16(bv.getUint16(at, true)));
    if (!Number.isFinite(scale)) throw Error("reference_q8_scale");
    total = f(total + f(scale * integer));
  }
  return total;
}
