import test from "node:test";
import assert from "node:assert/strict";
import { command, encodeCommand } from "../protocol";
import { nextBatch, planBatches } from "../compiler/batches";
const op = (n: number) => encodeCommand(command(n));
test("batch planner preserves public command order and route/token/page boundaries", () => {
  const commands = Array.from({ length: 140 }, () => op(6));
  commands[5] = op(14);
  commands[139] = op(17);
  const plan = planBatches(commands);
  assert.deepEqual(plan[0], { start: 0, count: 6 });
  assert.equal(
    plan.reduce((n, b) => n + b.count, 0),
    140,
  );
  const positions = plan.flatMap((b) =>
    Array.from({ length: b.count }, (_, i) => b.start + i),
  );
  assert.deepEqual(
    positions,
    Array.from({ length: 140 }, (_, i) => i),
  );
  for (const b of plan) {
    assert.ok(b.count <= 8);
    assert.equal(
      Math.floor(b.start / 128),
      Math.floor((b.start + b.count - 1) / 128),
    );
    assert.ok(!(b.start <= 5 && b.start + b.count > 6));
  }
  assert.deepEqual(nextBatch(commands, 127), { start: 127, count: 1 });
  assert.deepEqual(planBatches([op(14), op(17)]), [
    { start: 0, count: 1 },
    { start: 1, count: 1 },
  ]);
});
test("batch planner rejects invalid limits and sparse command schedules", () => {
  assert.throws(() => planBatches([], 8), /bound/);
  assert.throws(() => planBatches([op(6)], 9), /bounds/);
  assert.throws(() => nextBatch([op(6)], -1), /bounds/);
  assert.throws(() => planBatches(new Array(2)), /command/);
});
