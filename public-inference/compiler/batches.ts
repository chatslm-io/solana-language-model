/** Public schedule grouping only: never evaluates activations, experts or logits. */
import { decodeCommand } from "../protocol";
export type CommandBatch = { start: number; count: number };
export function nextBatch(
  commands: readonly Uint8Array[],
  start: number,
  maxCommands = 8,
): CommandBatch {
  if (
    !Array.isArray(commands) ||
    !Number.isInteger(start) ||
    start < 0 ||
    start >= commands.length ||
    !Number.isInteger(maxCommands) ||
    maxCommands < 1 ||
    maxCommands > 8
  )
    throw Error("public_batch_bounds");
  const pageEnd = (Math.floor(start / 128) + 1) * 128,
    end = Math.min(commands.length, start + maxCommands, pageEnd);
  let count = 0;
  for (let pc = start; pc < end; pc++) {
    if (!(commands[pc] instanceof Uint8Array))
      throw Error("public_batch_command");
    const command = decodeCommand(commands[pc]);
    count++;
    // Routing mutates selected-expert IDs; the next batch must read their onchain
    // values. TOKEN_END changes input token/PC and is the final forward command.
    if (command.op === 14 || command.op === 17) break;
  }
  return { start, count };
}
export function planBatches(
  commands: readonly Uint8Array[],
  maxCommands = 8,
): CommandBatch[] {
  if (
    !Array.isArray(commands) ||
    commands.length < 1 ||
    commands.length > 65536
  )
    throw Error("public_batch_plan_bound");
  const plan: CommandBatch[] = [];
  for (let at = 0; at < commands.length;) {
    const batch = nextBatch(commands, at, maxCommands);
    plan.push(batch);
    at += batch.count;
  }
  return plan;
}
