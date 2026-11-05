// Build the static site: bundle src/app.js (+ src/core.js + @solana/web3.js + spl-token)
// into a single self-contained app.bundle.js at the repo root. No CDN needed at runtime.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  outfile: "app.bundle.js",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  define: {
    global: "globalThis",
    "process.env.NODE_ENV": '"production"',
  },
  banner: {
    js: "if(typeof globalThis.process==='undefined'){globalThis.process={env:{},platform:'browser',version:'',nextTick:function(f){Promise.resolve().then(f);}};}",
  },
  logLevel: "info",
});

const st = fs.statSync("app.bundle.js");
if (st.size < 50_000) throw new Error(`bundle suspiciously small: ${st.size} bytes`);
console.log(`app.bundle.js written (${st.size} bytes)`);
