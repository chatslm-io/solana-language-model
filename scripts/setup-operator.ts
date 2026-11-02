import {
  existsSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  operatorEnvPath,
  outsideGit,
  privateDirectory,
  privateRead,
} from "../lib/operator/external";

// Provision only the explicit destination. Runtime state is created when used.
const path = operatorEnvPath();
outsideGit(path);
privateDirectory(dirname(path));
if (!existsSync(path)) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(
      fd,
      readFileSync(new URL("../config/operator.env.example", import.meta.url)),
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
} else privateRead(path).fill(0);
console.log(
  "Operator template ready at your configured SLM_SIGNER_ENV_FILE. Fill in your paths, endpoints, signer and limits before use.",
);
