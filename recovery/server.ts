// A standalone Node server. No Next.js, Hugging Face, or model files are used.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { protect, publicConfig, safeError, body } from "../lib/server/security";
import { forwardRpc } from "../lib/server/rpc";
import { price } from "../lib/server/price";
const origin = "http://127.0.0.1:3001";
const server = createServer(async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (req.headers.host !== "127.0.0.1:3001")
      throw new Error("Invalid local host");
    if (req.method === "GET") {
      const files: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/recovery.js": ["recovery.js", "text/javascript"],
        "/recovery.css": ["recovery.css", "text/css"],
      };
      const file = files[req.url || "/"];
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader("Content-Type", file[1]);
      res.end(await readFile(resolve("recovery/dist", file[0])));
      return;
    }
    if (req.method !== "POST") throw new Error("Unsupported method");
    const headers = new Headers();
    for (const [key, v] of Object.entries(req.headers))
      if (typeof v === "string") headers.set(key, v);
    protect(new Request(origin, { headers }), origin);
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw new Error("Request too large");
      chunks.push(chunk);
    }
    const request = new Request(origin, {
      method: "POST",
      headers,
      body: Buffer.concat(chunks),
    });
    const input = await body(request, 65536);
    if (req.url === "/api/rpc") {
      const r = await forwardRpc(input);
      res.statusCode = r.status;
      res.setHeader("Content-Type", "application/json");
      res.end(await r.text());
      return;
    }
    const value =
      req.url === "/api/config"
        ? publicConfig()
        : req.url === "/api/price"
          ? await price()
          : null;
    if (value === null) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: safeError(e) }));
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(3001, "127.0.0.1", () =>
  process.stdout.write(`SLM independent recovery: ${origin}\n`),
);
