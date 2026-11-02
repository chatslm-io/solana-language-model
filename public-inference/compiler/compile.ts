import { compileSelectedModel } from "./model";
import { packWeights } from "./weights";
import { compileCommands } from "./commands";
/** Model data remains caller-owned memory; this function performs no file writes. */
export async function compilePublicModel(bytes: Uint8Array) {
  const compiled = await compileSelectedModel(bytes),
    weights = packWeights(compiled.plan, compiled.modelBytes),
    commands = compileCommands(compiled.plan, weights),
    planPages: Uint8Array[] = [];
  for (let at = 0; at < commands.length; at += 128) {
    const count = Math.min(128, commands.length - at),
      page = new Uint8Array(count * 64);
    for (let i = 0; i < count; i++) page.set(commands[at + i], i * 64);
    planPages.push(page);
  }
  return { ...compiled, weights, commands, planPages, context: 16 as const };
}
