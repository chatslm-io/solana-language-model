/** UTF-8 framing only. No client-side text splitting, byte-BPE or role token IDs. */
export type RawChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
export const RAW_MESSAGE_LIMITS = Object.freeze({
  messages: 4,
  utf8Bytes: 512,
  frameBytes: 548,
});
export function encodeRawMessages(
  messages: readonly RawChatMessage[],
): Uint8Array {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 4)
    throw Error("public_raw_message_count");
  const encoder = new TextEncoder(),
    parts: Array<{ role: number; bytes: Uint8Array }> = [];
  let total = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content !== "string" || !content.isWellFormed())
      throw Error("public_raw_message_unicode");
    const role = ["system", "user", "assistant"].indexOf(message.role);
    if (role < 0) throw Error("public_raw_message_role");
    if (content.length > 512 - total) throw Error("public_raw_message_bytes");
    const bytes = encoder.encode(content);
    total += bytes.length;
    if (total > 512) throw Error("public_raw_message_bytes");
    parts.push({ role, bytes });
  }
  const frame = new Uint8Array(4 + messages.length * 8 + total),
    view = new DataView(frame.buffer);
  view.setUint32(0, parts.length, true);
  let at = 4;
  for (const part of parts) {
    view.setUint32(at, part.role, true);
    view.setUint32(at + 4, part.bytes.length, true);
    frame.set(part.bytes, at + 8);
    at += 8 + part.bytes.length;
  }
  return frame;
}
