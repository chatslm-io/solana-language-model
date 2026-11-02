/** Independent testing interpreter. Never import into production coordination. */
import { validateGraph, type CircuitGraph } from "../protocol/circuit";
export function evaluateClearCircuit(
  graph: CircuitGraph,
  input: readonly boolean[],
): boolean[] {
  validateGraph(graph);
  if (
    input.length !== graph.inputCount ||
    input.some((bit) => typeof bit !== "boolean")
  )
    throw Error("reference_circuit_inputs");
  const wires = [...input];
  for (const gate of graph.gates) {
    if (gate.op === 0) wires.push(wires[gate.lhs] && wires[gate.rhs]);
    else if (gate.op === 1) wires.push(wires[gate.lhs] !== wires[gate.rhs]);
    else wires.push(!wires[gate.lhs]);
  }
  return graph.outputs.map((wire) => wires[wire]);
}

/** Testing interpreter for public plans exceeding the current onchain wire codec.
 * Explicitly separate from executable artifacts; no ciphertext or production caller.
 */
export function evaluateClearPlan(
  plan: import("../compiler/circuit").PublicCircuitPlan,
  input: readonly boolean[],
): boolean[] {
  const graph = plan.graph;
  if (
    plan.kind !== "public-circuit-plan" ||
    !Number.isSafeInteger(graph.inputCount) ||
    graph.inputCount < 1 ||
    graph.gates.length > 1_048_576 ||
    !Array.isArray(input) ||
    input.length !== graph.inputCount ||
    Array.from(input).some((bit) => typeof bit !== "boolean")
  )
    throw Error("reference_plan_shape");
  const wires = [...input];
  for (const gate of graph.gates) {
    if (
      ![0, 1, 2].includes(gate.op) ||
      !Number.isInteger(gate.lhs) ||
      gate.lhs < 0 ||
      gate.lhs >= wires.length ||
      !Number.isInteger(gate.rhs) ||
      gate.rhs < 0 ||
      (gate.op === 2 ? gate.rhs !== 0 : gate.rhs >= wires.length)
    )
      throw Error("reference_plan_topology");
    wires.push(
      gate.op === 0
        ? wires[gate.lhs] && wires[gate.rhs]
        : gate.op === 1
          ? wires[gate.lhs] !== wires[gate.rhs]
          : !wires[gate.lhs],
    );
  }
  return graph.outputs.map((wire) => {
    if (!Number.isInteger(wire) || wire < 0 || wire >= wires.length)
      throw Error("reference_plan_output");
    return wires[wire];
  });
}
