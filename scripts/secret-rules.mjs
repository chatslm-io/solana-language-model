import { createPrivateKey, createPublicKey } from "node:crypto";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const forbiddenName =
  /(^|\/)(\.env(?!\.example$)[^/]*|operator\.env|[^/]*keypair[^/]*\.json|wallet[^/]*\.json|id\.json)$|\.(pem|key|keystore|safetensors|gguf|pt|pth|onnx)$/i;
const patterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private-key block"],
  [/\bhf_[A-Za-z0-9]{24,}\b/, "model service credential"],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{30,}\b/, "GitHub credential"],
  [/\bAKIA[0-9A-Z]{16}\b/, "cloud access key"],
  [/\bsk-[A-Za-z0-9_-]{30,}\b/, "API credential"],
  [
    /https?:\/\/[^\s"'<>]*[?&](?:api[_-]?key|token|secret)=[A-Za-z0-9_-]{12,}/i,
    "credential in URL",
  ],
];
function decoded58(value) {
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  const bytes = [];
  while (n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const c of value) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}
function isSolanaKey(bytes) {
  if (bytes.length !== 64) return false;
  let der;
  try {
    der = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      bytes.subarray(0, 32),
    ]);
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const publicPart = createPublicKey(key)
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    return publicPart.equals(bytes.subarray(32));
  } catch {
    return false;
  } finally {
    der?.fill(0);
  }
}
export function inspectSecrets(name, buffer) {
  const findings = [];
  if (forbiddenName.test(name) || /(^|\/)\.local\//.test(name))
    findings.push("forbidden signing/model/environment artifact");
  const text = buffer.toString("utf8");
  for (const [pattern, label] of patterns)
    if (pattern.test(text)) findings.push(label);
  // Public signatures have the same encoded length as a secret key. Derive the
  // public half to distinguish them; never print any matched content.
  for (const match of text.matchAll(
    /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,90}(?![1-9A-HJ-NP-Za-km-z])/g,
  )) {
    const bytes = decoded58(match[0]);
    if (isSolanaKey(bytes)) findings.push("Solana signing key");
    bytes.fill(0);
  }
  for (const match of text.matchAll(
    /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){63}\s*\]/g,
  )) {
    const array = match[0].slice(1, -1).split(",").map(Number);
    if (array.every((n) => n >= 0 && n <= 255))
      findings.push("64-byte signing-key-shaped array");
  }
  if (
    /^\s*(?:export\s+)?(?:SLM_|SOLANA_)?PRIVATE_KEY\s*=\s*["']?[A-Za-z0-9+/]{32,}={0,2}["']?\s*$/m.test(
      text,
    )
  )
    findings.push("private-key environment value");
  return [...new Set(findings)];
}
