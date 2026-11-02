import { modelAction } from "@/lib/server/models";
import type { Tensor } from "@/lib/model/formats";
import { fromBase64 } from "@/lib/chain/protocol";
import type { PreparedModel } from "./types";
export type Source = { repo: string; revision: string; file: string };
export type ModelProvider = {
  prepare(
    source: Source | null,
    progress: (message: string, bytes?: number, total?: number) => void,
    stopped: () => boolean,
  ): Promise<PreparedModel>;
  manifest(id: string): Promise<PreparedModel>;
  shard(id: string, index: number): Promise<Uint8Array>;
};
export const operatorModels: ModelProvider = {
  async prepare(source, progress, stopped) {
    if (!source)
      return (await modelAction({ action: "synthetic" })) as PreparedModel;
    if (!/\.gguf$/i.test(source.file)) throw new Error("Choose one GGUF file");
    let job = (await modelAction({
      action: "download",
      repo: source.repo,
      revision: source.revision,
      files: [source.file],
    })) as {
      id: string;
      done: boolean;
      error?: string;
      bytes: number;
      total: number;
    };
    while (!job.done) {
      if (stopped())
        throw new Error("Preparation paused; downloaded bytes can be reused");
      progress("Downloading the selected GGUF…", job.bytes, job.total);
      await new Promise((r) => setTimeout(r, 500));
      job = (await modelAction({ action: "job", id: job.id })) as typeof job;
    }
    if (job.error) throw new Error(job.error);
    progress("Inspecting tensors and preparing transformer weights…");
    const model = (await modelAction({
      action: "inspect",
      repo: source.repo,
      revision: source.revision,
      files: [source.file],
    })) as { id: string; tensors: Tensor[] };
    const tensors = model.tensors
      .filter((t) => t.role === "transformer")
      .map((t) => t.id);
    if (!tensors.length)
      throw new Error("No supported transformer tensors in this GGUF");
    return (await modelAction({
      action: "prepare",
      id: model.id,
      tensors,
    })) as PreparedModel;
  },
  async manifest(id) {
    return (await modelAction({ action: "manifest", id })) as PreparedModel;
  },
  async shard(id, index) {
    return fromBase64(
      ((await modelAction({ action: "shard", id, index })) as { bytes: string })
        .bytes,
    );
  },
};
