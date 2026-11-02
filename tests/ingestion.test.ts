import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { modelAction } from "../lib/server/models";
import type { Manifest } from "../lib/model/manifest";
import { canonical } from "../lib/model/manifest";
import type { Tensor } from "../lib/model/formats";
const hash = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
function checkpoint(name: string, data: number[]) {
  const header = Buffer.from(
    JSON.stringify({
      [name]: {
        dtype: "F16",
        shape: [data.length / 2],
        data_offsets: [0, data.length],
      },
    }),
  );
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([prefix, header, Buffer.from(data)]);
}
test("pinned sharded ingestion resumes downloads and preserves selected tensor and metadata bytes deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "slm-ingestion-"));
  const originalFetch = globalThis.fetch,
    old = process.env.HF_DOWNLOAD_DIR;
  process.env.HF_DOWNLOAD_DIR = root;
  const revision = "a".repeat(40),
    repo = "test/tiny";
  const files: Record<string, Buffer> = {
    "one.safetensors": checkpoint("model.layers.0.weight", [1, 2, 3, 4]),
    "two.safetensors": checkpoint("model.embed_tokens.weight", [5, 6]),
    "config.json": Buffer.from('{"model_type":"qwen3"}'),
    "model.safetensors.index.json": Buffer.from(
      JSON.stringify({
        weight_map: {
          "model.layers.0.weight": "one.safetensors",
          "model.embed_tokens.weight": "two.safetensors",
        },
      }),
    ),
  };
  let resumed = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/models/"))
      return Response.json({
        sha: revision,
        siblings: Object.entries(files).map(([rfilename, b]) => ({
          rfilename,
          size: b.length,
          lfs: { size: b.length, sha256: hash(b) },
        })),
      });
    const name = decodeURIComponent(url.split("/").at(-1)!);
    const b = files[name];
    assert.ok(b);
    const range = new Headers(init?.headers).get("range");
    if (range) {
      resumed = true;
      const start = Number(range.match(/\d+/)![0]);
      return new Response(Uint8Array.from(b.subarray(start)), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${b.length - 1}/${b.length}`,
        },
      });
    }
    return new Response(Uint8Array.from(b));
  };
  try {
    const fileId = hash(`${repo}\0${revision}\0one.safetensors`);
    await writeFile(
      join(root, `${fileId}.part`),
      files["one.safetensors"].subarray(0, 10),
    );
    let job = (await modelAction({
      action: "download",
      repo,
      revision,
      files: ["one.safetensors", "two.safetensors"],
    })) as { id: string; done: boolean; error?: string };
    for (let i = 0; !job.done && i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      job = (await modelAction({ action: "job", id: job.id })) as typeof job;
    }
    assert.equal(job.error, undefined);
    assert.equal(job.done, true);
    assert.ok(resumed);
    const model = (await modelAction({
      action: "inspect",
      repo,
      revision,
      files: ["one.safetensors", "two.safetensors"],
    })) as { id: string; tensors: Tensor[] };
    assert.equal(model.tensors.length, 2);
    const selected = model.tensors.find((t) => t.role === "transformer")!;
    const first = (await modelAction({
      action: "prepare",
      id: model.id,
      tensors: [selected.id],
    })) as { id: string; manifest: Manifest };
    const second = (await modelAction({
      action: "prepare",
      id: model.id,
      tensors: [selected.id],
    })) as typeof first;
    assert.equal(first.id, second.id);
    assert.equal(first.id, hash(canonical(first.manifest)));
    const payload = await readFile(join(root, `${first.id}.bytes`));
    const tensor = first.manifest.tensors[0];
    assert.deepEqual(
      [
        ...payload.subarray(
          tensor.payloadOffset,
          tensor.payloadOffset + tensor.length,
        ),
      ],
      [1, 2, 3, 4],
    );
    assert.equal(first.manifest.tensors.length, 1);
    assert.ok(first.manifest.artifacts.some((a) => a.name === "config.json"));
    for (const segment of [
      ...first.manifest.artifacts,
      ...first.manifest.tensors,
    ])
      assert.equal(
        hash(
          payload.subarray(
            segment.payloadOffset,
            segment.payloadOffset + segment.length,
          ),
        ),
        segment.sha256,
      );
    const shard = (await modelAction({
      action: "shard",
      id: first.id,
      index: 0,
    })) as { bytes: string };
    assert.deepEqual(Buffer.from(shard.bytes, "base64"), payload);
    await assert.rejects(
      modelAction({
        action: "inspect",
        repo,
        revision,
        files: ["one.safetensors"],
      }),
      /shard set/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.HF_DOWNLOAD_DIR;
    else process.env.HF_DOWNLOAD_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
});
