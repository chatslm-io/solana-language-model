/** Public Boolean graph compilation only: never receives a conversation value.
 * Integer helpers are exact modulo/two's-complement operations, not an approved
 * replacement for the target model's floating-point kernels.
 */
import { validateGraph, type CircuitGraph } from "../protocol/circuit";
import { compileBinary32Add, compileBinary32Multiply } from "./binary32";
export type Wire = number;
export type Word = readonly Wire[]; // little-endian bits
export type PublicCircuitPlan = {
  readonly kind: "public-circuit-plan";
  readonly graph: CircuitGraph;
};
export class CircuitBuilder {
  readonly inputCount: number;
  readonly mode: "bounded" | "count-only" | "planning";
  private gates: { op: 0 | 1 | 2; lhs: number; rhs: number }[] = [];
  private counts = { and: 0, xor: 0, not: 0 };
  private negations = new Map<Wire, Wire>();
  private zeroWire?: Wire;
  private oneWire?: Wire;
  constructor(
    inputCount: number,
    mode: "bounded" | "count-only" | "planning" = "bounded",
  ) {
    if (
      !Number.isSafeInteger(inputCount) ||
      inputCount < 1 ||
      inputCount > 0xffffffff ||
      (mode === "bounded" && inputCount > 64)
    )
      throw Error("compiler_input_count");
    this.inputCount = inputCount;
    this.mode = mode;
  }
  private wire(wire: Wire) {
    if (
      !Number.isSafeInteger(wire) ||
      wire < 0 ||
      wire >= this.inputCount + this.gateCount
    )
      throw Error("compiler_wire");
  }
  get gateCount() {
    return this.counts.and + this.counts.xor + this.counts.not;
  }
  get resources() {
    return Object.freeze({
      inputCount: this.inputCount,
      gateCount: this.gateCount,
      wireCount: this.inputCount + this.gateCount,
      ...this.counts,
      recordBytes: this.gateCount * 80,
      wireLabelBytes: (this.inputCount + this.gateCount) * 32,
    });
  }
  input(index: number): Wire {
    if (!Number.isInteger(index) || index < 0 || index >= this.inputCount)
      throw Error("compiler_input_index");
    return index;
  }
  private emit(op: 0 | 1 | 2, lhs: Wire, rhs: Wire): Wire {
    this.wire(lhs);
    if (op !== 2) this.wire(rhs);
    const result = this.inputCount + this.gateCount;
    if (
      result >= 0xffffffff ||
      (this.mode === "bounded" && (this.gateCount >= 192 || result >= 256))
    )
      throw Error("compiler_circuit_capacity");
    if (this.mode !== "count-only") {
      if (this.gates.length >= 1_048_576)
        throw Error("compiler_planning_capacity");
      this.gates.push({ op, lhs, rhs: op === 2 ? 0 : rhs });
    }
    this.counts[op === 0 ? "and" : op === 1 ? "xor" : "not"]++;
    return result;
  }
  and(a: Wire, b: Wire): Wire {
    return this.emit(0, a, b);
  }
  xor(a: Wire, b: Wire): Wire {
    return this.emit(1, a, b);
  }
  not(a: Wire): Wire {
    this.wire(a);
    const existing = this.negations.get(a);
    if (existing !== undefined) return existing;
    const result = this.emit(2, a, 0);
    this.negations.set(a, result);
    this.negations.set(result, a);
    return result;
  }
  constant(value: boolean): Wire {
    if (typeof value !== "boolean") throw Error("compiler_constant");
    if (this.zeroWire === undefined)
      this.zeroWire = this.xor(this.input(0), this.input(0));
    if (!value) return this.zeroWire;
    if (this.oneWire === undefined) this.oneWire = this.not(this.zeroWire);
    return this.oneWire;
  }
  constantWord(value: bigint, width: number): Wire[] {
    this.width(width);
    if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(width))
      throw Error("compiler_constant_word");
    return Array.from({ length: width }, (_, i) =>
      this.constant(Boolean((value >> BigInt(i)) & 1n)),
    );
  }
  private width(width: number) {
    if (!Number.isInteger(width) || width < 1 || width > 32)
      throw Error("compiler_word_width");
  }
  private words(a: Word, b: Word) {
    this.width(a.length);
    if (a.length !== b.length) throw Error("compiler_word_shape");
    for (const wire of [...a, ...b]) this.wire(wire);
  }
  mux(select: Wire, whenTrue: Wire, whenFalse: Wire): Wire {
    return this.xor(whenFalse, this.and(select, this.xor(whenTrue, whenFalse)));
  }
  muxWord(select: Wire, whenTrue: Word, whenFalse: Word): Wire[] {
    this.words(whenTrue, whenFalse);
    return whenTrue.map((wire, i) => this.mux(select, wire, whenFalse[i]));
  }
  /** Wrapping addition modulo 2^width; no saturation or implicit rescale. */
  add(a: Word, b: Word): Wire[] {
    this.words(a, b);
    let carry = this.constant(false);
    const out: Wire[] = [];
    for (let i = 0; i < a.length; i++) {
      const propagate = this.xor(a[i], b[i]);
      out.push(this.xor(propagate, carry));
      if (i + 1 < a.length)
        carry = this.xor(this.and(a[i], b[i]), this.and(propagate, carry));
    }
    return out;
  }
  unsignedLess(a: Word, b: Word): Wire {
    this.words(a, b);
    let borrow = this.and(this.not(a[0]), b[0]);
    for (let i = 1; i < a.length; i++) {
      borrow = this.mux(this.xor(a[i], b[i]), b[i], borrow);
    }
    return borrow;
  }
  /** Signed two's-complement compare. The most-significant bit carries the sign. */
  signedLess(a: Word, b: Word): Wire {
    this.words(a, b);
    return this.xor(
      this.unsignedLess(a, b),
      this.xor(a[a.length - 1], b[b.length - 1]),
    );
  }
  float32Add(a: Word, b: Word): Wire[] {
    this.words(a, b);
    return compileBinary32Add(this, a, b);
  }
  float32Multiply(a: Word, b: Word): Wire[] {
    this.words(a, b);
    return compileBinary32Multiply(this, a, b);
  }
  /** IEEE754 bit-pattern total order key (negative values reverse magnitude).
   * This orders -0 before +0 and includes NaN payloads; use orderedLess for numeric <.
   */
  float32TotalOrderLess(a: Word, b: Word): Wire {
    this.words(a, b);
    if (a.length !== 32) throw Error("compiler_binary32_width");
    const key = (value: Word) => [
      ...value.slice(0, 31).map((bit) => this.xor(bit, value[31])),
      this.not(value[31]),
    ];
    return this.unsignedLess(key(a), key(b));
  }
  private all(bits: Word): Wire {
    if (!bits.length) return this.constant(true);
    bits.forEach((bit) => this.wire(bit));
    return bits.slice(1).reduce((out, bit) => this.and(out, bit), bits[0]);
  }
  private allZero(bits: Word): Wire {
    return this.all(bits.map((bit) => this.not(bit)));
  }
  float32IsNaN(value: Word): Wire {
    if (value.length !== 32) throw Error("compiler_binary32_width");
    return this.and(
      this.all(value.slice(23, 31)),
      this.not(this.allZero(value.slice(0, 23))),
    );
  }
  /** IEEE754 ordered less-than, including +/-0 equality and unordered NaN -> false. */
  float32OrderedLess(a: Word, b: Word): Wire {
    const ordered = this.float32TotalOrderLess(a, b);
    const bothZero = this.allZero([...a.slice(0, 31), ...b.slice(0, 31)]);
    const neitherNaN = this.and(
      this.not(this.float32IsNaN(a)),
      this.not(this.float32IsNaN(b)),
    );
    return this.and(ordered, this.and(this.not(bothZero), neitherNaN));
  }
  /** First index wins ties; matches scalar loop `if (candidate > best)` even for NaN. */
  float32Argmax(values: readonly Word[]): { value: Wire[]; index: Wire[] } {
    if (
      !values.length ||
      values.length > 65536 ||
      values.some((value) => value.length !== 32)
    )
      throw Error("compiler_argmax_shape");
    const width = Math.max(1, Math.ceil(Math.log2(values.length)));
    let best = [...values[0]],
      index = this.constantWord(0n, width);
    for (let candidate = 1; candidate < values.length; candidate++) {
      const take = this.float32OrderedLess(best, values[candidate]);
      best = this.muxWord(take, values[candidate], best);
      index = this.muxWord(
        take,
        this.constantWord(BigInt(candidate), width),
        index,
      );
    }
    return { value: best, index };
  }
  /** Public oversized DAG for planning/testing only; central artifact encoder rejects its limits. */
  finishPlan(outputs: readonly Wire[]): PublicCircuitPlan {
    if (this.mode !== "planning") throw Error("compiler_not_planning");
    Array.from(outputs).forEach((wire) => this.wire(wire));
    if (!outputs.length || new Set(outputs).size !== outputs.length)
      throw Error("compiler_plan_outputs");
    return Object.freeze({
      kind: "public-circuit-plan",
      graph: Object.freeze({
        inputCount: this.inputCount,
        gates: Object.freeze(
          this.gates.map((gate) => Object.freeze({ ...gate })),
        ),
        outputs: Object.freeze([...outputs]),
      }),
    });
  }
  /** Oblivious exact public lookup. Index wire values never affect the graph. */
  lookup(index: Word, table: readonly bigint[], outputWidth: number): Wire[] {
    this.width(outputWidth);
    if (
      index.length < 1 ||
      index.length > 4 ||
      table.length !== 2 ** index.length
    )
      throw Error("compiler_lookup_shape");
    index.forEach((wire) => this.wire(wire));
    let level = table.map((value) => this.constantWord(value, outputWidth));
    for (const bit of index) {
      const next: Wire[][] = [];
      for (let i = 0; i < level.length; i += 2)
        next.push(
          level[i].map((wire, j) =>
            wire === level[i + 1][j]
              ? wire
              : this.mux(bit, level[i + 1][j], wire),
          ),
        );
      level = next;
    }
    return level[0];
  }
  finish(outputs: readonly Wire[]): CircuitGraph {
    if (this.mode !== "bounded")
      throw Error("compiler_count_only_not_executable");
    Array.from(outputs).forEach((wire) => this.wire(wire));
    const graph = {
      inputCount: this.inputCount,
      gates: this.gates.map((gate) => Object.freeze({ ...gate })),
      outputs: [...outputs],
    };
    validateGraph(graph);
    return Object.freeze({
      ...graph,
      gates: Object.freeze(graph.gates),
      outputs: Object.freeze(graph.outputs),
    });
  }
}
