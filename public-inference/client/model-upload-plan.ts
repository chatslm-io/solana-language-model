import type { Address, Instruction } from "@solana/kit";
import type { PublicModelFixture } from "../harness/model-fixture";

export type ModelUploadOperation = {
  name: string;
  instruction: Instruction;
  rent: bigint;
};
export async function modelUploadOperations(
  f: PublicModelFixture,
  rentAt: (key: Address) => bigint,
) {
  const operations: ModelUploadOperation[] = [];
  const add = (name: string, instruction: Instruction, rent = 0n) =>
    operations.push({ name, instruction, rent });
  add("model-create", f.client.createModel(f.binding), rentAt(f.client.model));
  for (const page of f.artifacts.pages) {
    add(
      `model-page-${page.index}-allocate`,
      await f.client.allocateArtifact(page),
      rentAt(await f.client.artifact(page.index)),
    );
    for (let offset = 0; offset < page.payload.length; offset += 700)
      add(
        `model-page-${page.index}-write-${offset}`,
        await f.client.writeArtifact(
          page.index,
          offset,
          page.payload.subarray(offset, offset + 700),
        ),
      );
    add(
      `model-page-${page.index}-seal`,
      await f.client.sealArtifact(page.index),
    );
  }
  add("model-seal", f.client.sealModel());
  return operations;
}
