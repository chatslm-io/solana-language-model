/** Fixed public forward pass. Every arithmetic operation is an SBF command. */
import { command, encodeCommand } from "../protocol";
import type { PublicModelPlan } from "./model";
import { packedRows, type PackedWeights } from "./weights";
export const STATE = Object.freeze({
  h: 0,
  residual: 128,
  norm: 256,
  q: 384,
  kv: 512,
  attention: 560,
  query: 624,
  scores: 672,
  probabilities: 688,
  weighted: 704,
  up: 736,
  gate: 1088,
  activation: 1440,
  routed: 1792,
  router: 1920,
  routeProbabilities: 1928,
  selectedWeights: 1936,
  selectedIds: 1938,
  best: 1940,
  index: 1941,
  gain: 1942,
  cacheBytes: 7808,
});
const NONE = 0xffffffff;
const bits = (x: number) => {
  const b = new ArrayBuffer(4),
    v = new DataView(b);
  v.setFloat32(0, x, true);
  return v.getUint32(0, true);
};
// The field order is the centrally frozen 16-u32 ABI.
type Fields = {
  src: number;
  dst: number;
  len: number;
  aux0: number;
  aux1: number;
  weightPage: number;
  weightOffset: number;
  cols: number;
  rows: number;
  rowStart: number;
  selector: number;
  expertStride: number;
  format: number;
  flags: number;
  reserved: number;
};
export function compileCommands(
  plan: PublicModelPlan,
  packed: PackedWeights,
): Uint8Array[] {
  const out: Uint8Array[] = [],
    s = STATE;
  const emit = (op: number, f: Partial<Fields> = {}) => {
    out.push(encodeCommand(command(op, f)));
  };
  const tensor = (name: string) => {
    const t = packed.tensors.get(name);
    if (!t) throw Error("public_command_tensor");
    return t;
  };
  const copy = (src: number, dst: number, len: number) =>
    emit(6, { src, dst, len });
  const add = (src: number, aux0: number, dst: number, len = 128) =>
    emit(7, { src, aux0, dst, len });
  const quant = (src: number, len: number) => {
    for (let rowStart = 0; rowStart < len; rowStart += 64)
      emit(2, { src, rowStart, len: Math.min(64, len - rowStart) });
  };
  const gemv = (
    name: string,
    src: number,
    dst: number,
    slice = 0,
    selector = NONE,
    head = false,
    reuseQuant = false,
  ) => {
    const t = tensor(name),
      format = { F32: 3, F16: 2, Q8_0: 1 }[t.tensor.dtype];
    if (format === 1 && !reuseQuant) quant(src, t.tensor.rowElements);
    for (const c of packedRows(t, format === 1 ? 2048 : 512)) {
      emit(head ? 19 : 3, {
        src,
        dst: head ? dst : dst + c.row,
        cols: t.tensor.rowElements,
        rows: c.count,
        rowStart: c.row,
        weightPage: c.page + slice * t.pagesPerSlice,
        weightOffset: c.offset,
        selector,
        expertStride: selector === NONE ? 0 : t.pagesPerSlice,
        format,
        aux0: head ? s.best : 0,
        aux1: head ? s.index : 0,
        flags: head && c.row === 0 ? 1 : 0,
      });
    }
  };
  const norm = (name: string, src: number, dst: number, len: number) => {
    const t = tensor(name);
    emit(4, { src, dst: s.gain, len, aux0: bits(plan.numeric.rmsEpsilon) });
    emit(5, { src, dst, len, aux0: s.gain, weightPage: t.basePage, format: 3 });
  };
  const rope = (src: number, dst: number) =>
    emit(9, { src, dst, len: 16, aux0: bits(plan.numeric.ropeBase) });
  const ffn = (prefix: string, suffix: string, selector = NONE) => {
    const width = tensor(prefix + "ffn_up" + suffix + ".weight").tensor.rows;
    gemv(prefix + "ffn_up" + suffix + ".weight", s.norm, s.up, 0, selector);
    gemv(
      prefix + "ffn_gate" + suffix + ".weight",
      s.norm,
      s.gate,
      0,
      selector,
      false,
      true,
    );
    for (let i = 0; i < width; i += 32)
      emit(8, {
        src: s.gate + i,
        aux0: s.up + i,
        dst: s.activation + i,
        len: Math.min(32, width - i),
      });
    gemv(
      prefix + "ffn_down" + suffix + ".weight",
      s.activation,
      s.h,
      0,
      selector,
    );
  };
  const embedding = tensor("token_embd.weight");
  emit(1, {
    dst: s.h,
    weightPage: embedding.basePage,
    cols: 128,
    rows: embedding.rowsPerPage,
    format: 1,
  });
  for (let layer = 0; layer < 4; layer++) {
    const p = `blk.${layer}.`;
    copy(s.h, s.residual, 128);
    norm(p + "attn_norm.weight", s.h, s.norm, 128);
    gemv(p + "attn_q.weight", s.norm, s.q);
    gemv(p + "attn_kv_a_mqa.weight", s.norm, s.kv, 0, NONE, false, true);
    norm(p + "attn_kv_a_norm.weight", s.kv, s.kv, 32);
    rope(s.kv + 32, s.kv + 32);
    emit(10, { src: s.kv, len: 48, aux0: layer });
    for (let head = 0; head < 4; head++) {
      gemv(p + "attn_k_b.weight", s.q + head * 32, s.query, head);
      rope(s.q + head * 32 + 16, s.query + 32);
      for (let rowStart = 0; rowStart < 16; rowStart += 8)
        emit(11, {
          src: s.query,
          dst: s.scores,
          len: 8,
          cols: 48,
          rowStart,
          aux0: layer,
          aux1: bits(1 / Math.sqrt(32)),
        });
      emit(12, { src: s.scores, dst: s.probabilities, len: 16, flags: 1 });
      emit(13, {
        src: s.probabilities,
        dst: s.weighted,
        len: 32,
        cols: 48,
        aux0: layer,
      });
      gemv(p + "attn_v_b.weight", s.weighted, s.attention + head * 16, head);
    }
    gemv(p + "attn_output.weight", s.attention, s.h);
    add(s.h, s.residual, s.h);
    copy(s.h, s.residual, 128);
    norm(p + "ffn_norm.weight", s.h, s.norm, 128);
    if (layer === 0) ffn(p, "");
    else {
      gemv(p + "ffn_gate_inp.weight", s.norm, s.router);
      const bias = tensor(p + "exp_probs_b.bias");
      emit(14, {
        src: s.router,
        dst: s.selectedIds,
        aux0: s.selectedWeights,
        aux1: s.routeProbabilities,
        len: 8,
        weightPage: bias.basePage,
      });
      emit(18, { dst: s.routed, len: 128 });
      for (let expert = 0; expert < 2; expert++) {
        ffn(p, "_exps", s.selectedIds + expert);
        emit(15, {
          src: s.h,
          dst: s.routed,
          len: 128,
          aux0: s.selectedWeights + expert,
        });
      }
      ffn(p, "_shexp");
      add(s.h, s.routed, s.h);
    }
    add(s.h, s.residual, s.h);
  }
  norm("output_norm.weight", s.h, s.norm, 128);
  gemv("output.weight", s.norm, s.up, 0, NONE, true);
  emit(17, { src: s.index });
  return out;
}
