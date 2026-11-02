/** Byte consistency verifier. Callers independently authenticate finalized account
 * owners/PDAs, selected session binding and deployed program code. Not an RPC proof.
 */
import { decodeStreamingDescriptor, EMPTY_GENERATION } from "./streaming";
const enc = new TextEncoder();
function check(ok: boolean): asserts ok {
  if (!ok) throw Error("invalid_streaming_result");
}
function equal(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function u32(n: number) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
async function hash(parts: Uint8Array[]) {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    b.set(p, at);
    at += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}
export async function verifyCompletedStreamingBytes(args: {
  session: Uint8Array;
  sessionAddress: Uint8Array;
  slots: readonly [Uint8Array, Uint8Array];
  slotBumps: readonly [number, number];
  descriptor: Uint8Array;
}): Promise<Uint8Array> {
  const s = Uint8Array.from(args.session),
    address = Uint8Array.from(args.sessionAddress);
  check(args.slots.length === 2 && args.slotBumps.length === 2);
  const pages = args.slots.map((p) => Uint8Array.from(p)),
    bumps = [...args.slotBumps];
  const descriptor = Uint8Array.from(args.descriptor),
    d = decodeStreamingDescriptor(descriptor);
  check(s.length === 256 && address.length === 32);
  const sv = new DataView(s.buffer),
    steps = Math.ceil(d.gateCount / 32);
  check(
    equal(s.subarray(0, 8), enc.encode("SLMPIS01")) &&
      s[8] === 1 &&
      s[9] === 1 &&
      s[10] === 3,
  );
  check(equal(d.namespace, s.subarray(80, 112)));
  check(
    sv.getUint32(208, true) === steps &&
      sv.getUint32(224, true) === steps &&
      sv.getUint32(228, true) === 2 &&
      sv.getUint32(240, true) === 1,
  );
  check(
    sv.getUint32(212, true) === 1 &&
      sv.getUint32(216, true) === 1 &&
      sv.getUint32(220, true) === 1,
  );
  for (let index = 0; index < 2; index++) {
    const p = pages[index],
      count =
        index === 0
          ? Math.min(128, d.slotCount)
          : Math.max(0, d.slotCount - 128);
    check(p.length === 256 + count * 40);
    const v = new DataView(p.buffer);
    check(
      equal(p.subarray(0, 8), enc.encode("SLMPSL02")) &&
        p[8] === 2 &&
        p[9] === 4 &&
        p[10] === 3,
    );
    check(
      Number.isInteger(bumps[index]) &&
        bumps[index] >= 0 &&
        bumps[index] <= 255 &&
        p[11] === bumps[index],
    );
    check(
      p.subarray(12, 16).every((x) => x === 0) &&
        p.subarray(172, 176).every((x) => x === 0) &&
        p.subarray(212, 256).every((x) => x === 0),
    );
    check(
      equal(p.subarray(16, 48), s.subarray(16, 48)) &&
        equal(p.subarray(48, 80), address),
    );
    check(
      equal(p.subarray(80, 112), s.subarray(112, 144)) &&
        equal(p.subarray(112, 144), s.subarray(144, 176)),
    );
    check(
      v.getUint32(144, true) === index &&
        v.getUint32(148, true) === index * 128 &&
        v.getUint32(152, true) === count &&
        v.getUint32(156, true) === d.slotCount,
    );
    check(
      v.getUint32(160, true) === d.gateCount &&
        v.getUint32(164, true) === d.inputCount &&
        v.getUint32(168, true) === d.gateCount &&
        v.getUint32(208, true) === d.outputs.length,
    );
    for (let i = 0; i < count; i++) {
      const at = 256 + i * 40,
        generation = v.getUint32(at, true);
      check(p.subarray(at + 4, at + 8).every((x) => x === 0));
      check(
        generation === EMPTY_GENERATION
          ? p.subarray(at + 8, at + 40).every((x) => x === 0)
          : generation < d.inputCount + d.gateCount,
      );
    }
  }
  const pageHash = await hash([
    enc.encode("slm-private:page:v1\n"),
    u32(0),
    u32(1),
    u32(descriptor.length),
    descriptor,
  ]);
  const root = await hash([enc.encode("slm-private:pages:v1\n"), pageHash]);
  check(equal(root, s.subarray(144, 176)));
  const state = await hash([
    enc.encode("slm-private:slots:v2\n"),
    s.subarray(112, 144),
    root,
    u32(d.gateCount),
    u32(d.slotCount),
    pages[0].subarray(256),
    pages[1].subarray(256),
  ]);
  check(
    equal(state, s.subarray(176, 208)) &&
      pages.every((p) => equal(state, p.subarray(176, 208))),
  );
  const out = new Uint8Array(d.outputs.length * 32);
  d.outputs.forEach((output, i) => {
    const p = pages[Math.floor(output.slot / 128)],
      at = 256 + (output.slot % 128) * 40;
    check(new DataView(p.buffer).getUint32(at, true) === output.logical);
    out.set(p.subarray(at + 8, at + 40), i * 32);
  });
  return out;
}
