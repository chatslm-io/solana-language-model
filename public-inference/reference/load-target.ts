/** Read-only pinned public checkpoint download. No disk, signer, or RPC access. */
import { createHash } from "node:crypto";
import { SELECTED_TARGET } from "../compiler/model";
export async function loadTarget(
  progress: (message: string) => void = () => {},
  timeoutMs = 120_000,
): Promise<Uint8Array> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw Error("public_checkpoint_timeout_bound");
  const t = { ...SELECTED_TARGET },
    controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    progress(
      `Downloading pinned public checkpoint (${t.bytes} bytes; ${timeoutMs / 1000}s timeout)`,
    );
    const response = await fetch(
      `https://huggingface.co/${t.repo}/resolve/${t.revision}/${t.file}`,
      { signal: controller.signal },
    );
    if (!response.ok || !response.body)
      throw Error(`public_checkpoint_http_${response.status}`);
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== t.bytes)
      throw Error("public_checkpoint_length");
    const output = new Uint8Array(t.bytes),
      reader = response.body.getReader();
    let at = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (at + part.value.length > output.length)
          throw Error("public_checkpoint_length");
        output.set(part.value, at);
        at += part.value.length;
      }
    } finally {
      await reader.cancel();
    }
    if (
      at !== t.bytes ||
      createHash("sha256").update(output).digest("hex") !== t.sha256
    )
      throw Error("public_checkpoint_identity");
    progress(`Verified pinned checkpoint (${at} bytes; memory only)`);
    return output;
  } finally {
    clearTimeout(timer);
  }
}
