import {
  constants,
  existsSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, resolve, relative, sep } from "node:path";
import { configuredPath } from "../config/environment.mjs";
import { parseEnv } from "node:util";

export function outsideGit(path: string) {
  if (!isAbsolute(path))
    throw new Error(
      "Operator paths must be absolute and outside Git checkouts",
    );
  let ancestor = resolve(path);
  while (!existsSync(/* turbopackIgnore: true */ ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  ancestor = realpathSync(/* turbopackIgnore: true */ ancestor);
  const repository = realpathSync(/* turbopackIgnore: true */ process.cwd());
  const location = relative(repository, ancestor);
  const requested = relative(repository, resolve(path));
  if (
    ancestor === repository &&
    requested.startsWith(`.local${sep}`) &&
    !existsSync(resolve(repository, ".local"))
  )
    return;
  if (location === ".local" || location.startsWith(`.local${sep}`)) return;
  if (location !== ".." && !location.startsWith(`..${sep}`))
    throw new Error(
      "Signing configuration and operator state must stay outside every Git checkout and this source directory",
    );
  for (;;) {
    if (existsSync(/* turbopackIgnore: true */ resolve(ancestor, ".git")))
      throw new Error(
        "Signing configuration and operator state must stay outside every Git checkout",
      );
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}
export function privateRead(path: string, maximum = 65536): Buffer {
  outsideGit(path);
  return readProtectedFile(path, maximum);
}
// Public journals may use this beneath a previously validated PrivateDirectory.
// Signing configuration must always use privateRead instead.
export function readProtectedFile(path: string, maximum = 65536): Buffer {
  const fd = openSync(
    /* turbopackIgnore: true */ path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      (st.mode & 0o077) !== 0 ||
      (process.getuid && st.uid !== process.getuid()) ||
      st.size > maximum
    )
      throw new Error(
        "Operator files must be user-owned, private (chmod 600), regular files without hard links",
      );
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function operatorEnvPath() {
  return configuredPath("SLM_SIGNER_ENV_FILE");
}
export function readOperatorEnv(): Record<string, string> {
  if (!process.env.SLM_SIGNER_ENV_FILE?.trim()) return {};
  const path = operatorEnvPath();
  outsideGit(path);
  if (!existsSync(/* turbopackIgnore: true */ path))
    throw new Error("The configured SLM_SIGNER_ENV_FILE does not exist");
  const bytes = privateRead(path);
  try {
    return Object.fromEntries(
      Object.entries(parseEnv(bytes.toString("utf8"))).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1].trim().length > 0,
      ),
    );
  } catch {
    throw new Error("Cannot parse the external operator environment file");
  } finally {
    bytes.fill(0);
  }
}
export type PrivateDirectory = string & {
  readonly __privateDirectory: unique symbol;
};
export function privateDirectory(path: string): PrivateDirectory {
  outsideGit(path);
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch {
    throw new Error(
      "External operator folder is not writable. Run npm run operator:setup and grant the service user access to the configured directory.",
    );
  }
  const st = lstatSync(/* turbopackIgnore: true */ path);
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    (st.mode & 0o077) !== 0 ||
    (process.getuid && st.uid !== process.getuid())
  )
    throw new Error(
      "Operator state directory must be user-owned and private (chmod 700)",
    );
  const check = resolve(
    path,
    `.write-check-${randomBytes(16).toString("hex")}`,
  );
  try {
    const fd = openSync(
      check,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    unlinkSync(check);
  } catch {
    throw new Error(
      "External operator folder is not writable. Run npm run operator:setup and grant the service user access to the configured directory.",
    );
  }
  return realpathSync(/* turbopackIgnore: true */ path) as PrivateDirectory;
}
export function stateDirectory() {
  return privateDirectory(
    configuredPath("SLM_OPERATOR_DIR", {
      ...process.env,
      ...readOperatorEnv(),
    }),
  );
}
