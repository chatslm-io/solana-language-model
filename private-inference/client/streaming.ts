/** Experimental v2 trusted-client garbling. All gates are evaluated by the SBF
 * continuation; this module only builds labels/tables and encodes input bits.
 */
import type { PublicCircuitPlan } from "../compiler/circuit";
import { planLiveness } from "../compiler/liveness";
import {
  encodeStreamingDescriptor,
  encodeStreamingRecord,
  streamingWindows,
  STREAMING_LIMITS,
  type StreamingWindow,
} from "../protocol/streaming";
const zero = () => new Uint8Array(32),
  domain = new TextEncoder().encode("slm:half-gates:sha256:v1\0");
const xor = (...values: Uint8Array[]) =>
  Uint8Array.from({ length: 32 }, (_, i) =>
    values.reduce((value, label) => value ^ label[i], 0),
  );
const equal = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== 32 || b.length !== 32) return false;
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= a[i] ^ b[i];
  return difference === 0;
};
async function hash(
  label: Uint8Array,
  namespace: Uint8Array,
  gate: number,
  half: number,
) {
  const bytes = new Uint8Array(domain.length + 73);
  bytes.set(domain);
  bytes.set(namespace, domain.length);
  new DataView(bytes.buffer).setBigUint64(
    domain.length + 32,
    BigInt(gate),
    true,
  );
  bytes[domain.length + 40] = half;
  bytes.set(label, domain.length + 41);
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  } finally {
    bytes.fill(0);
  }
}
export type EncodedStreamingCircuit = {
  descriptor: Uint8Array;
  windows: StreamingWindow[];
};
export type PreparedStreamingCircuit = {
  encode(input: readonly boolean[]): EncodedStreamingCircuit;
  decode(outputLabels: Uint8Array): boolean[];
  destroy(): void;
  readonly resources: {
    inputs: number;
    gates: number;
    logicalWires: number;
    physicalSlots: number;
    stateBytes: number;
    outputs: number;
    recordBytes: number;
    tableBytes: number;
    garblerHashes: number;
    windows: number;
  };
};
export type StreamingPreparationProgress = {
  readonly stage: "garbling" | "committing";
  readonly completedGates: number;
  readonly totalGates: number;
  readonly windows: number;
};
export async function prepareStreamingCircuit(
  source: PublicCircuitPlan,
  namespace: Uint8Array,
  onProgress?: (progress: StreamingPreparationProgress) => void,
): Promise<PreparedStreamingCircuit> {
  if (
    !(namespace instanceof Uint8Array) ||
    namespace.length !== 32 ||
    source.kind !== "public-circuit-plan"
  )
    throw Error("garbling_stream_binding");
  const graph = {
      inputCount: source.graph.inputCount,
      gates: source.graph.gates.map((gate) => ({ ...gate })),
      outputs: [...source.graph.outputs],
    },
    ns = Uint8Array.from(namespace);
  if (
    !Number.isInteger(graph.inputCount) ||
    graph.inputCount < 1 ||
    graph.inputCount > STREAMING_LIMITS.inputs ||
    graph.gates.length < 1 ||
    graph.gates.length > STREAMING_LIMITS.gates ||
    graph.outputs.length < 1 ||
    graph.outputs.length > STREAMING_LIMITS.outputs ||
    new Set(graph.outputs).size !== graph.outputs.length
  )
    throw Error("garbling_stream_bounds");
  const schedule = planLiveness(
    { kind: "public-circuit-plan", graph },
    { eagerInputs: true },
  );
  if (
    schedule.peakSlots > STREAMING_LIMITS.slots ||
    schedule.finalLoads.length ||
    schedule.operations.some((operation) => operation.loads.length)
  )
    throw Error("garbling_stream_eager_profile");
  const delta = crypto.getRandomValues(zero());
  delta[0] |= 1;
  const labels = Array.from({ length: graph.inputCount }, () =>
      crypto.getRandomValues(zero()),
    ),
    records = new Uint8Array(graph.gates.length * 96);
  const erase = () => {
    delta.fill(0);
    for (const label of labels) label.fill(0);
  };
  let andCount = 0;
  try {
    onProgress?.(
      Object.freeze({
        stage: "garbling",
        completedGates: 0,
        totalGates: graph.gates.length,
        windows: Math.ceil(graph.gates.length / 32),
      }),
    );
    for (let index = 0; index < graph.gates.length; index++) {
      const gate = graph.gates[index],
        allocation = schedule.operations[index],
        a0 = labels[gate.lhs],
        b0 = labels[gate.rhs];
      let tg = zero(),
        te = zero();
      if (gate.op === 2) labels.push(xor(a0, delta));
      else if (gate.op === 1) labels.push(xor(a0, b0));
      else {
        const a1 = xor(a0, delta),
          b1 = xor(b0, delta),
          [ha0, ha1, hb0, hb1] = await Promise.all([
            hash(a0, ns, index, 0),
            hash(a1, ns, index, 0),
            hash(b0, ns, index, 1),
            hash(b1, ns, index, 1),
          ]);
        tg = xor(ha0, ha1, b0[0] & 1 ? delta : zero());
        te = xor(hb0, hb1, a0);
        labels.push(
          xor(
            ha0,
            a0[0] & 1 ? tg : zero(),
            hb0,
            b0[0] & 1 ? xor(hb0, hb1) : zero(),
          ),
        );
        andCount++;
        for (const temporary of [a1, b1, ha0, ha1, hb0, hb1]) temporary.fill(0);
      }
      records.set(
        encodeStreamingRecord(
          {
            op: gate.op,
            lhs: gate.lhs,
            rhs: gate.rhs,
            lhsSlot: allocation.lhs,
            rhsSlot: gate.op === 2 ? 0 : allocation.rhs,
            destination: allocation.output,
            priorDestination: allocation.priorOutputLogical,
            tg,
            te,
          },
          index,
          graph.inputCount,
          schedule.peakSlots,
        ),
        index * 96,
      );
      tg.fill(0);
      te.fill(0);
      if ((index + 1) % 256 === 0 || index + 1 === graph.gates.length)
        onProgress?.(
          Object.freeze({
            stage: "garbling",
            completedGates: index + 1,
            totalGates: graph.gates.length,
            windows: Math.ceil(graph.gates.length / 32),
          }),
        );
    }
    onProgress?.(
      Object.freeze({
        stage: "committing",
        completedGates: graph.gates.length,
        totalGates: graph.gates.length,
        windows: Math.ceil(graph.gates.length / 32),
      }),
    );
    const { root, windows } = await streamingWindows(records),
      outputZeros = graph.outputs.map((wire) => labels[wire].slice()),
      outputOnes = outputZeros.map((label) => xor(label, delta));
    records.fill(0);
    let encoded = false,
      destroyed = false;
    return Object.freeze({
      encode(input: readonly boolean[]) {
        if (encoded || destroyed) throw Error("garbling_single_use");
        if (
          !Array.isArray(input) ||
          input.length !== graph.inputCount ||
          Array.from(input).some((bit) => typeof bit !== "boolean")
        )
          throw Error("garbling_input_shape");
        encoded = true;
        const inputLabels = new Uint8Array(graph.inputCount * 32);
        try {
          for (let i = 0; i < input.length; i++) {
            const label = input[i] ? xor(labels[i], delta) : labels[i];
            inputLabels.set(label, i * 32);
            if (input[i]) label.fill(0);
          }
          const descriptor = encodeStreamingDescriptor({
            namespace: ns,
            inputCount: graph.inputCount,
            gateCount: graph.gates.length,
            slotCount: schedule.peakSlots,
            outputs: graph.outputs.map((logical, i) => ({
              logical,
              slot: schedule.outputSlots[i],
            })),
            recordRoot: root,
            inputLabels,
          });
          return {
            descriptor,
            windows: windows.map((window) => ({
              index: window.index,
              records: window.records.slice(),
              proof: window.proof.map((hash) => hash.slice()),
            })),
          };
        } finally {
          inputLabels.fill(0);
          erase();
        }
      },
      decode(outputLabels: Uint8Array) {
        if (!encoded || destroyed) throw Error("garbling_state");
        if (
          !(outputLabels instanceof Uint8Array) ||
          outputLabels.length !== outputZeros.length * 32
        )
          throw Error("garbling_output_shape");
        return outputZeros.map((expected, index) => {
          const label = outputLabels.subarray(index * 32, (index + 1) * 32);
          if (equal(label, expected)) return false;
          if (equal(label, outputOnes[index])) return true;
          throw Error("garbling_output_authentication");
        });
      },
      destroy() {
        erase();
        for (const label of [...outputZeros, ...outputOnes]) label.fill(0);
        for (const window of windows) window.records.fill(0);
        destroyed = true;
      },
      resources: Object.freeze({
        inputs: graph.inputCount,
        gates: graph.gates.length,
        logicalWires: labels.length,
        physicalSlots: schedule.peakSlots,
        stateBytes: schedule.peakSlots * 40,
        outputs: graph.outputs.length,
        recordBytes: graph.gates.length * 96,
        tableBytes: andCount * 64,
        garblerHashes: andCount * 4,
        windows: windows.length,
      }),
    });
  } catch (error) {
    erase();
    records.fill(0);
    throw error;
  }
}
// Zeroing above is best effort. JavaScript/WebCrypto can retain copies; no
// non-extractability or secure-erasure promise. Decoder must stay local and
// run only after independently verified finalized session/evidence bindings.
