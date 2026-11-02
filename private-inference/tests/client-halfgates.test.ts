import assert from "node:assert/strict";
import test from "node:test";
import { prepareSingleUseAnd } from "../client/halfgates";
import { referenceAnd } from "../reference/halfgates";
test("browser garbler matches independent reference for every AND input and 16 independent keys", async () => {
  for (let trial = 0; trial < 16; trial++)
    for (const a of [false, true])
      for (const b of [false, true]) {
        const prepared = await prepareSingleUseAnd(
          crypto.getRandomValues(new Uint8Array(32)),
          trial,
        );
        const wire = prepared.encode(a, b);
        assert.equal(prepared.decode(referenceAnd(wire)), a && b);
        assert.throws(() => prepared.encode(a, b), /single_use/);
        const output = referenceAnd(wire);
        output[7] ^= 1;
        assert.throws(() => prepared.decode(output), /authentication/);
        prepared.destroy();
        assert.throws(() => prepared.decode(referenceAnd(wire)), /state/);
      }
});
test("fresh garblings differ, namespace/gate substitution invalidates output, invalid binding rejects", async () => {
  const ns = crypto.getRandomValues(new Uint8Array(32));
  const a = await prepareSingleUseAnd(ns, 0),
    b = await prepareSingleUseAnd(ns, 0);
  const wa = a.encode(true, true),
    wb = b.encode(true, true);
  assert.notDeepEqual(wa, wb);
  for (const offset of [1, 33]) {
    const mutated = wa.slice();
    mutated[offset] ^= 1;
    assert.throws(() => a.decode(referenceAnd(mutated)));
  }
  assert.throws(() => a.decode(referenceAnd(wb)));
  await assert.rejects(prepareSingleUseAnd(new Uint8Array(31), 0));
  await assert.rejects(prepareSingleUseAnd(ns, 2 ** 32));
  a.destroy();
  b.destroy();
});
