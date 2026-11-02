import { resolve, relative, sep, isAbsolute } from "node:path";

/** @param {string} name @param {Record<string, string | undefined>} env */
export function requiredSetting(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} explicitly in your environment`);
  return value;
}

// Relative paths are resolved against the directory from which the command runs.
/** @param {string} name @param {Record<string, string | undefined>} env */
export function configuredPath(name, env = process.env) {
  return resolve(requiredSetting(name, env));
}

export function assertBuildDirectory(directory, repository) {
  const rel = relative(resolve(repository), resolve(directory));
  if (rel === ".local" || rel.startsWith(`.local${sep}`)) return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  throw new Error(
    "Build outputs must be outside the source tree or in ignored .local/",
  );
}

/** @param {Record<string, string | undefined>} env */
export function approvedSigners(env = process.env) {
  return ["SLM_APPROVED_SIGNER_1", "SLM_APPROVED_SIGNER_2"].map((key) => {
    const value = requiredSetting(key, env);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
      throw new Error(`${key} must be a public Solana address`);
    return value;
  });
}
