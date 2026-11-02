import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir("recovery/dist", { recursive: true });
await build({
  entryPoints: ["recovery/client.tsx"],
  bundle: true,
  outfile: "recovery/dist/recovery.js",
  platform: "browser",
  format: "esm",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = (await readFile("app/globals.css", "utf8")).replace(
  '@import "tailwindcss";',
  "",
);
await writeFile("recovery/dist/recovery.css", css);
await writeFile(
  "recovery/dist/index.html",
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SLM independent recovery</title><link rel="stylesheet" href="/recovery.css"></head><body><div id="root"></div><script type="module" src="/recovery.js"></script></body></html>',
);
