/** Deterministic public scheduling plan, NOT an implemented SBF wire codec.
 * Active labels remain evaluator state. No client decoding or re-encoding is
 * involved in moving an authenticated input/continuation label into a slot.
 */
import type { PublicCircuitPlan } from "./circuit";
export type SlotOperation = {
  gate: number;
  op: 0 | 1 | 2;
  lhs: number;
  rhs: number;
  output: number;
  loads: readonly { inputWire: number; slot: number }[];
  lhsLogical: number;
  rhsLogical: number;
  outputLogical: number;
  priorOutputLogical: number;
};
export type LivenessPlan = {
  operations: readonly SlotOperation[];
  outputSlots: readonly number[];
  finalLoads: readonly { inputWire: number; slot: number }[];
  peakSlots: number;
  labelBytes: number;
  fixedPublicSchedule: true;
  initialization: "eager-inputs" | "lazy-inputs";
};
export function planLiveness(
  plan: PublicCircuitPlan,
  options: { eagerInputs?: boolean } = {},
): LivenessPlan {
  if (
    !plan ||
    plan.kind !== "public-circuit-plan" ||
    !plan.graph ||
    !Array.isArray(plan.graph.gates) ||
    !Array.isArray(plan.graph.outputs) ||
    Array.from(plan.graph.gates).some(
      (gate) => !gate || typeof gate !== "object",
    ) ||
    Array.from(plan.graph.outputs).some((output) => !Number.isInteger(output))
  )
    throw Error("liveness_plan_encoding");
  const graph = plan.graph,
    total = graph.inputCount + graph.gates.length;
  if (
    plan.kind !== "public-circuit-plan" ||
    !Number.isSafeInteger(graph.inputCount) ||
    graph.inputCount < 1 ||
    total > 2_000_000 ||
    graph.gates.length > 1_048_576
  )
    throw Error("liveness_plan_bounds");
  const uses = new Uint32Array(total);
  const wire = (value: number, bound: number) => {
    if (!Number.isInteger(value) || value < 0 || value >= bound)
      throw Error("liveness_topology");
  };
  graph.gates.forEach((gate, index) => {
    if (![0, 1, 2].includes(gate.op)) throw Error("liveness_opcode");
    wire(gate.lhs, graph.inputCount + index);
    uses[gate.lhs]++;
    if (gate.op === 2) {
      if (gate.rhs !== 0) throw Error("liveness_not_rhs");
    } else {
      wire(gate.rhs, graph.inputCount + index);
      uses[gate.rhs]++;
    }
  });
  graph.outputs.forEach((output) => {
    wire(output, total);
    uses[output]++;
  });
  const slots = new Int32Array(total);
  slots.fill(-1);
  const free: number[] = [];
  let allocated = 0;
  const generations: number[] = [];
  if (options.eagerInputs) {
    allocated = graph.inputCount;
    for (let input = 0; input < graph.inputCount; input++) {
      slots[input] = input;
      generations[input] = input;
      if (!uses[input]) {
        free.push(input);
        slots[input] = -1;
      }
    }
  }
  const allocate = () => (free.length ? free.pop()! : allocated++);
  const ensure = (
    logical: number,
    loads: { inputWire: number; slot: number }[],
  ) => {
    if (slots[logical] !== -1) return slots[logical];
    if (logical >= graph.inputCount)
      throw Error("liveness_missing_intermediate");
    const slot = allocate();
    slots[logical] = slot;
    generations[slot] = logical;
    loads.push({ inputWire: logical, slot });
    return slot;
  };
  const release = (logical: number) => {
    if (!uses[logical]) throw Error("liveness_reference_underflow");
    if (--uses[logical] === 0) {
      free.push(slots[logical]);
      slots[logical] = -1;
    }
  };
  const operations: SlotOperation[] = [];
  graph.gates.forEach((gate, index) => {
    const loads: { inputWire: number; slot: number }[] = [],
      lhs = ensure(gate.lhs, loads),
      rhs = gate.op === 2 ? 0 : ensure(gate.rhs, loads);
    release(gate.lhs);
    if (gate.op !== 2) release(gate.rhs);
    // Sources must be read before destination overwrite; a last-use source slot
    // can then hold the output label for this very gate without client action.
    const output = allocate(),
      logical = graph.inputCount + index;
    const priorOutputLogical = generations[output] ?? 0xffffffff;
    slots[logical] = output;
    generations[output] = logical;
    operations.push({
      gate: index,
      op: gate.op,
      lhs,
      rhs,
      output,
      loads,
      lhsLogical: gate.lhs,
      rhsLogical: gate.op === 2 ? 0 : gate.rhs,
      outputLogical: logical,
      priorOutputLogical,
    });
    if (!uses[logical]) {
      free.push(output);
      slots[logical] = -1;
    }
  });
  const finalLoads: { inputWire: number; slot: number }[] = [];
  const outputSlots = graph.outputs.map((logical) =>
    ensure(logical, finalLoads),
  );
  return {
    operations,
    outputSlots,
    finalLoads,
    peakSlots: allocated,
    labelBytes: allocated * 32,
    fixedPublicSchedule: true,
    initialization: options.eagerInputs ? "eager-inputs" : "lazy-inputs",
  };
}
