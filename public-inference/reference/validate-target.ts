/** Reproducible memory-only compiler/reference diagnostic. No signer or RPC. */
import { compilePublicModel } from "../compiler/compile";
import { SELECTED_TARGET } from "../compiler/model";
import { loadPublicReference } from "./deepseek2";
import { createHash } from "node:crypto";
import { loadTarget } from "./load-target";
async function main() {
  const t = SELECTED_TARGET;
  const bytes = await loadTarget();
  const compiled = await compilePublicModel(bytes);
  const traces: {
    position: number;
    layer: number;
    phase: string;
    sha256: string;
  }[] = [];
  const reference = await loadPublicReference(
    bytes,
    "ggml-scalar-reference",
    (event) => {
      const data = new Uint8Array(event.values.length * 4),
        view = new DataView(data.buffer);
      event.values.forEach((value, i) => view.setFloat32(i * 4, value, true));
      traces.push({
        position: event.position,
        layer: event.layer,
        phase: event.phase,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    },
  );
  const result = reference.step(1);
  console.log(
    JSON.stringify(
      {
        source: t.sha256,
        tensors: compiled.plan.tensors.length,
        weightPages: compiled.weights.pages.length,
        planPages: compiled.planPages.length,
        commands: compiled.commands.length,
        context: compiled.context,
        referenceInput: 1,
        referenceGreedy: result.token,
        traces,
      },
      null,
      2,
    ),
  );
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "public_reference_failed",
  );
  process.exitCode = 1;
});
