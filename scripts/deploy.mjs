#!/usr/bin/env node
/* Deploy the site to GitHub via the REST API (this host's git has no https transport).
 * Creates blobs + tree + commit and points refs/heads/main at it. Token from `gh auth token`;
 * never printed. Idempotent: re-runs create a new commit on top of HEAD.
 *
 * Usage: node scripts/deploy.mjs [owner/repo] [branch]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [OWNER, REPO] = (process.argv[2] || "x1goose404-ops/wolf-coin-beta").split("/");
const BRANCH = process.argv[3] || "main";

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
if (!token) throw new Error("no gh token");
const H = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "wolf-coin-beta-deploy" };
const api = async (method, p, body) => {
  const res = await fetch(`https://api.github.com${p}`, { method, headers: { ...H, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${txt.slice(0, 500)}`);
  return txt ? JSON.parse(txt) : null;
};

const SKIP = new Set(["node_modules", ".git", "shots", ".chrome-for-testing"]);
const SKIP_FILE = /(^|\/)(\.env|.*-keypair\.json|id\.json)$/;
function walk(dir, base = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (!SKIP_FILE.test(rel)) out.push(rel);
  }
  return out;
}

// required site files must exist
for (const f of ["index.html", "config.js", "styles.css", "app.bundle.js", "assets/wolf-coin.webp"]) {
  if (!fs.existsSync(path.join(ROOT, f))) throw new Error(`missing required file: ${f}`);
}

const files = walk(ROOT).sort();
console.log(`deploying ${files.length} files to ${OWNER}/${REPO}@${BRANCH}`);

const tree = [];
for (const rel of files) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  const blob = await api("POST", `/repos/${OWNER}/${REPO}/git/blobs`, { content: buf.toString("base64"), encoding: "base64" });
  tree.push({ path: rel, mode: "100644", type: "blob", sha: blob.sha });
  console.log(`  ${blob.sha.slice(0, 8)}  ${rel}  (${buf.length} B)`);
}

// parent (empty repo => no parents)
let parents = [];
try {
  const ref = await api("GET", `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  parents = [ref.object.sha];
  console.log("parent:", ref.object.sha);
} catch { console.log("no existing branch — creating root commit"); }

const newTree = await api("POST", `/repos/${OWNER}/${REPO}/git/trees`, { tree });
const commit = await api("POST", `/repos/${OWNER}/${REPO}/git/commits`, {
  message: process.env.DEPLOY_MSG || "deploy: wolf-coin-beta frontend (X1 Wallet-first connect; V0 tx wrap; preview default)",
  tree: newTree.sha,
  parents,
});
try {
  await api("POST", `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
} catch {
  await api("PATCH", `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
}
console.log("commit:", commit.sha);

// enable GitHub Pages (branch / root) if not already enabled
try {
  const pages = await api("GET", `/repos/${OWNER}/${REPO}/pages`);
  console.log("pages already enabled:", pages.html_url);
} catch {
  const pages = await api("POST", `/repos/${OWNER}/${REPO}/pages`, { source: { branch: BRANCH, path: "/" } });
  console.log("pages enabled:", pages.html_url);
}
console.log(`\nLIVE: https://${OWNER}.github.io/${REPO}/`);
