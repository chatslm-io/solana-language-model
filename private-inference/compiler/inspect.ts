import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { outsideGit } from "../../lib/operator/external";
import { inventoryDeepseek2 } from "./inventory";
// Read-only local artifact inspection. No runtime env, network, signing or production configuration.
const [filePath, repo, revision] = process.argv.slice(2);
try {
  if (process.argv.length !== 5 || !filePath || !repo || !revision)
    throw Error("usage");
  outsideGit(filePath);
  outsideGit(await realpath(filePath));
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 ** 2)
      throw Error("artifact_file");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== before.size
    )
      throw Error("artifact_changed");
    const result = await inventoryDeepseek2(bytes, {
      repo,
      revision,
      file: filePath.split("/").at(-1)!,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await handle.close();
  }
} catch {
  console.error(
    "Private model inspection failed. Usage: node --import tsx private-inference/compiler/inspect.ts /external/model.gguf owner/repo immutable-40hex-revision (reviewed deepseek2, maximum 64 MiB). No model bytes or provider details are logged.",
  );
  process.exitCode = 1;
}
