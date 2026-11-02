/** Public deterministic model-operation graph. Expert indices are state-produced
 * public values in v1; coordinator never supplies computed activations/answers.
 */
import type { PublicModelPlan } from "./model";
export type PublicPhase = {
  id: number;
  layer: number;
  operation: string;
  tensor?: string;
  rows?: number;
  columns?: number;
  repeat?: number;
  parameter?: string;
};
export function publicOperationSchedule(plan: PublicModelPlan): PublicPhase[] {
  const phases: Omit<PublicPhase, "id">[] = [],
    d = plan.dimensions;
  const add = (
    layer: number,
    operation: string,
    rest: Omit<PublicPhase, "id" | "layer" | "operation"> = {},
  ) => phases.push({ layer, operation, ...rest });
  const gemv = (
    layer: number,
    name: string,
    repeat = 1,
    parameter?: string,
  ) => {
    const tensor = plan.tensors.find((value) => value.name === name);
    if (!tensor) throw Error("public_schedule_tensor_missing");
    add(layer, "gemv", {
      tensor: name,
      rows: tensor.rows,
      columns: tensor.rowElements,
      repeat,
      parameter,
    });
  };
  add(-1, "embedding-lookup", {
    tensor: "token_embd.weight",
    rows: 1,
    columns: d.hidden,
  });
  for (let layer = 0; layer < d.layers; layer++) {
    const p = `blk.${layer}.`;
    add(layer, "rmsnorm", {
      tensor: p + "attn_norm.weight",
      columns: d.hidden,
    });
    gemv(layer, p + "attn_q.weight");
    gemv(layer, p + "attn_kv_a_mqa.weight");
    add(layer, "rmsnorm-kv", {
      tensor: p + "attn_kv_a_norm.weight",
      columns: d.kvRank,
    });
    add(layer, "rope-key", { columns: d.rotary });
    add(layer, "kv-append", { columns: d.kvRank + d.rotary });
    gemv(layer, p + "attn_k_b.weight", d.heads, "head");
    add(layer, "rope-query", { columns: d.rotary, repeat: d.heads });
    add(layer, "attention-scores", {
      columns: d.kvRank + d.rotary,
      repeat: d.heads,
    });
    add(layer, "softmax", { repeat: d.heads });
    add(layer, "attention-weighted-latent", {
      columns: d.kvRank,
      repeat: d.heads,
    });
    gemv(layer, p + "attn_v_b.weight", d.heads, "head");
    gemv(layer, p + "attn_output.weight");
    add(layer, "residual-add", { columns: d.hidden });
    add(layer, "rmsnorm", { tensor: p + "ffn_norm.weight", columns: d.hidden });
    if (layer < d.denseLayers) {
      gemv(layer, p + "ffn_up.weight");
      gemv(layer, p + "ffn_gate.weight");
      add(layer, "silu-product", { columns: d.denseHidden });
      gemv(layer, p + "ffn_down.weight");
    } else {
      gemv(layer, p + "ffn_gate_inp.weight");
      add(layer, "sigmoid-route-topk", {
        tensor: p + "exp_probs_b.bias",
        columns: d.experts,
      });
      gemv(
        layer,
        p + "ffn_up_exps.weight",
        d.selectedExperts,
        "selected-expert",
      );
      gemv(
        layer,
        p + "ffn_gate_exps.weight",
        d.selectedExperts,
        "selected-expert",
      );
      add(layer, "silu-product", {
        columns: d.expertHidden,
        repeat: d.selectedExperts,
      });
      gemv(
        layer,
        p + "ffn_down_exps.weight",
        d.selectedExperts,
        "selected-expert",
      );
      add(layer, "weighted-expert-sum", { columns: d.hidden });
      gemv(layer, p + "ffn_up_shexp.weight");
      gemv(layer, p + "ffn_gate_shexp.weight");
      add(layer, "silu-product", { columns: d.expertHidden * d.sharedExperts });
      gemv(layer, p + "ffn_down_shexp.weight");
      add(layer, "shared-expert-add", { columns: d.hidden });
    }
    add(layer, "residual-add", { columns: d.hidden });
  }
  add(-1, "rmsnorm", { tensor: "output_norm.weight", columns: d.hidden });
  gemv(-1, "output.weight");
  add(-1, "argmax-lowest-index", { columns: d.vocabulary });
  add(-1, "append-public-token");
  return phases.map((phase, id) => ({ id, ...phase }));
}
export function boundedRows(
  totalRows: number,
  rowsPerStep: number,
): { start: number; count: number }[] {
  if (
    !Number.isInteger(totalRows) ||
    totalRows < 1 ||
    totalRows > 1000000 ||
    !Number.isInteger(rowsPerStep) ||
    rowsPerStep < 1 ||
    rowsPerStep > 256
  )
    throw Error("public_schedule_bounds");
  return Array.from(
    { length: Math.ceil(totalRows / rowsPerStep) },
    (_, index) => ({
      start: index * rowsPerStep,
      count: Math.min(rowsPerStep, totalRows - index * rowsPerStep),
    }),
  );
}
