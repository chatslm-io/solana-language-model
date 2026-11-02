/** Experimental trusted-client garbling of one AND, not a model compiler.
 * ZRE15 half-gates equations with SHA256 modeled as a random oracle; see crypto-core/SECURITY.md.
 * All private labels, delta and output decoding material remain in this closure.
 */
const domain = new TextEncoder().encode("slm:half-gates:sha256:v1\0");
const xor = (...values: Uint8Array[]) =>
  Uint8Array.from({ length: 32 }, (_, i) =>
    values.reduce((v, label) => v ^ label[i], 0),
  );
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) return false;
  let different = 0;
  for (let i = 0; i < 32; i++) different |= a[i] ^ b[i];
  return different === 0;
}
async function hash(
  label: Uint8Array,
  namespace: Uint8Array,
  gate: number,
  half: number,
): Promise<Uint8Array> {
  const input = new Uint8Array(domain.length + 32 + 8 + 1 + 32);
  input.set(domain);
  input.set(namespace, domain.length);
  new DataView(input.buffer).setBigUint64(
    domain.length + 32,
    BigInt(gate),
    true,
  );
  input[domain.length + 40] = half;
  input.set(label, domain.length + 41);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}
export type SingleUseAnd = {
  /** Public table namespace and fresh labels are bound to one evaluation only. */
  encode(a: boolean, b: boolean): Uint8Array;
  /** Call locally only after trusted finalized execution verification. No network callback. */
  decode(outputLabel: Uint8Array): boolean;
  destroy(): void;
};
export async function prepareSingleUseAnd(
  namespace: Uint8Array,
  gate: number,
): Promise<SingleUseAnd> {
  if (
    namespace.length !== 32 ||
    !Number.isInteger(gate) ||
    gate < 0 ||
    gate >= 2 ** 32
  )
    throw Error("garbling_binding");
  const ns = Uint8Array.from(namespace);
  const delta = crypto.getRandomValues(new Uint8Array(32));
  delta[0] |= 1;
  const a0 = crypto.getRandomValues(new Uint8Array(32)),
    b0 = crypto.getRandomValues(new Uint8Array(32));
  const a1 = xor(a0, delta),
    b1 = xor(b0, delta);
  const [ha0, ha1, hb0, hb1] = await Promise.all([
    hash(a0, ns, gate, 0),
    hash(a1, ns, gate, 0),
    hash(b0, ns, gate, 1),
    hash(b1, ns, gate, 1),
  ]);
  const tg = xor(ha0, ha1, b0[0] & 1 ? delta : new Uint8Array(32));
  const te = xor(hb0, hb1, a0);
  const c0 = xor(
    ha0,
    a0[0] & 1 ? tg : new Uint8Array(32),
    hb0,
    b0[0] & 1 ? xor(hb0, hb1) : new Uint8Array(32),
  );
  const c1 = xor(c0, delta);
  let encoded = false,
    destroyed = false;
  const secrets = [delta, a0, a1, b0, b1, ha0, ha1, hb0, hb1, c0, c1];
  return Object.freeze({
    encode(a: boolean, b: boolean) {
      if (
        destroyed ||
        encoded ||
        typeof a !== "boolean" ||
        typeof b !== "boolean"
      )
        throw Error("garbling_single_use");
      encoded = true;
      const request = new Uint8Array(169);
      request[0] = 1;
      request.set(ns, 1);
      new DataView(request.buffer).setBigUint64(33, BigInt(gate), true);
      request.set(a ? a1 : a0, 41);
      request.set(b ? b1 : b0, 73);
      request.set(tg, 105);
      request.set(te, 137);
      // Keep only output decoding material after input encoding. JS/WebCrypto copies
      // may survive garbage collection: this is best-effort zeroing, not secure erasure.
      for (const secret of secrets.slice(0, -2)) secret.fill(0);
      return request;
    },
    decode(outputLabel: Uint8Array) {
      if (destroyed || !encoded) throw Error("garbling_state");
      if (equal(outputLabel, c0)) return false;
      if (equal(outputLabel, c1)) return true;
      throw Error("garbling_output_authentication");
    },
    destroy() {
      for (const secret of secrets) secret.fill(0);
      tg.fill(0);
      te.fill(0);
      destroyed = true;
    },
  });
}
