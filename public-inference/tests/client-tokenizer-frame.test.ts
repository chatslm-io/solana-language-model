import test from "node:test";
import assert from "node:assert/strict";
import { encodeRawMessages } from "../client/tokenizer-frame";
test("raw framing preserves exact UTF8 and literal role text without client tokens", () => {
  const content = "<|assistant|> I'm naïve e\u0301\u0085\u00a0\ufeff 😀\n  ",
    frame = Buffer.from(encodeRawMessages([{ role: "user", content }]));
  assert.equal(frame.readUInt32LE(0), 1);
  assert.equal(frame.readUInt32LE(4), 1);
  assert.equal(frame.readUInt32LE(8), Buffer.byteLength(content));
  assert.deepEqual(frame.subarray(12), Buffer.from(content));
});
test("raw framing bounds total bytes/messages and rejects surrogate replacement", () => {
  assert.equal(
    encodeRawMessages([{ role: "user", content: "é".repeat(256) }]).length,
    524,
  );
  assert.throws(
    () => encodeRawMessages([{ role: "user", content: "é".repeat(257) }]),
    /bytes/,
  );
  for (const content of ["\ud800", "\udfff", "x\ud800y"])
    assert.throws(
      () => encodeRawMessages([{ role: "user", content }]),
      /unicode/,
    );
  assert.throws(
    () =>
      encodeRawMessages(
        Array.from({ length: 5 }, () => ({
          role: "user" as const,
          content: "",
        })),
      ),
    /count/,
  );
  assert.throws(() => encodeRawMessages(new Array(1)), /unicode/);
  const frame = Buffer.from(
    encodeRawMessages([
      { role: "system", content: "" },
      { role: "user", content: "\u0000" },
      { role: "assistant", content: "" },
    ]),
  );
  assert.equal(frame.length, 29);
  assert.equal(frame.readUInt32LE(4), 0);
  assert.equal(frame.readUInt32LE(12), 1);
  assert.equal(frame.readUInt32LE(21), 2);
});
