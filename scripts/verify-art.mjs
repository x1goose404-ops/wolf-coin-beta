#!/usr/bin/env node
// Verify bundled artwork against the on-chain SEALED inscription content hash (BLAKE3).
// Read-only; touches no chain. Exits non-zero on mismatch.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { blake3 } = require("@noble/hashes/blake3");

const TARGET = "1c870487914dc51dab1d5edba988c399960a3f464faa3bf3cdb396ce9d3b8f7c";
const TARGET_SIZE = 316818;
const INSCRIPTION = "5F1GrsYDZusa5y6QkFb3syevDKiaQVkVBRGJCn7mwMuG";

const files = [
  ["assets/wolf-coin.webp", "sealed inscription artwork (canonical)"],
  ["assets/wolf-coin-hero.webp", "beta hero artwork (not inscribed)"],
  ["assets/coin.png", "legacy coin art"],
];

let ok = true;
console.log(`sealed inscription: ${INSCRIPTION}`);
console.log(`expected BLAKE3   : ${TARGET}  (${TARGET_SIZE} bytes)\n`);
for (const [rel, label] of files) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log(`MISSING  ${rel}`); ok = false; continue; }
  const b = fs.readFileSync(p);
  const h = Buffer.from(blake3(b)).toString("hex");
  const match = h === TARGET && b.length === TARGET_SIZE;
  console.log(`${match ? "OK  " : "----"} ${rel}  ${b.length} B  ${h}  (${label})`);
  if (rel === "assets/wolf-coin.webp" && !match) ok = false;
}
if (!ok) process.exit(1);
console.log("\ncanonical artwork matches the sealed inscription.");
