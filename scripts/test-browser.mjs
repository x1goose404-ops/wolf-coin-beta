#!/usr/bin/env node
/* Automated browser test against a PUBLIC (or local) URL.
 *  - launches Chrome for Testing (headless) via puppeteer-core
 *  - records console errors, page errors and failed network requests
 *  - asserts every asset returns HTTP 200 and the app renders
 *  - MOCKS window.x1Wallet (connect + isX1Wallet) and verifies CONNECT shows the address
 *  - drives MINT: prepares the tx and runs the RPC simulation, expecting err:null
 *
 * Usage: node scripts/test-browser.mjs [url]   (default: local http://127.0.0.1:8099/)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const TARGET_URL = process.argv[2] || "http://127.0.0.1:8099/";
const MOCK_ADDR = "2ovF3vdxQNkv2xFc1zoDQgwdTgyxeTeAbg6rgnFgXDeM"; // valid on-curve (registry authority)

function chromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    path.join(os.homedir(), ".local/chrome-for-testing/chrome-linux64/chrome"),
    path.join(os.homedir(), ".cache/ms-playwright/chromium-1570803/chrome-linux64/chrome"),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("no Chrome binary found");
}

const results = [];
const ck = (name, cond, detail = "") => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--window-size=1280,1600"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1600 });

const consoleErrors = [], pageErrors = [], responses = new Map(), failed = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
page.on("requestfailed", (r) => failed.push(`${r.url()} :: ${r.failure()?.errorText}`));
page.on("response", (r) => {
  const u = new URL(r.url());
  if (u.origin === new URL(TARGET_URL).origin) responses.set(u.pathname, r.status());
});

// MOCK window.x1Wallet BEFORE any page script runs.
await page.evaluateOnNewDocument((addr) => {
  window.x1Wallet = {
    isX1Wallet: true,
    publicKey: null,
    async connect() { this.publicKey = { toString: () => addr }; return { publicKey: this.publicKey }; },
    async disconnect() { this.publicKey = null; },
    async signAndSendTransaction() { throw new Error("mock: sign not used in tests"); },
    on() {}, off() {},
  };
}, MOCK_ADDR);

await page.goto(TARGET_URL, { waitUntil: "networkidle0", timeout: 60000 });

// --- assets 200 ---
for (const p of ["/", "/app.bundle.js", "/config.js", "/styles.css", "/assets/wolf-coin.webp", "/assets/wolf-coin-hero.webp", "/favicon.svg"]) {
  ck(`asset 200 ${p}`, responses.get(p) === 200, `status=${responses.get(p)}`);
}

// --- render ---
const cardCount = await page.$$eval("#grid .card", (n) => n.length);
ck("renders 10 collection cards", cardCount === 10, `count=${cardCount}`);
const progShown = await page.$eval("#progId", (e) => e.textContent).catch(() => "");
ck("program id shown", progShown === "L3MrpyJhTLrJv57c2BcFH3vBbrrCnsakfwn6wHvzTz5", progShown);
const detectTxt = await page.$eval("#wallets", (e) => e.textContent);
ck("X1 Wallet detected in UI", /X1 Wallet/.test(detectTxt), detectTxt.replace(/\s+/g, " ").slice(0, 80));

// --- CONNECT (mock) ---
await page.evaluate(() => document.querySelector("#connectBtn").click());
await page.waitForFunction((a) => document.querySelector("#walletCard") && !document.querySelector("#walletCard").hidden && document.querySelector("#walletCard").textContent.includes(a), { timeout: 20000 }, MOCK_ADDR);
const walletTxt = await page.$eval("#walletCard", (e) => e.textContent);
ck("CONNECT shows address + network", walletTxt.includes(MOCK_ADDR) && /X1 mainnet/.test(walletTxt), walletTxt.replace(/\s+/g, " ").slice(0, 120));

// --- wait for registry read ---
await page.waitForFunction(() => /^\d+\/10$/.test(document.querySelector("#supply").textContent), { timeout: 25000 });
const supply = await page.$eval("#supply", (e) => e.textContent);
ck("supply read from chain (n/10)", /^\d+\/10$/.test(supply), supply);

// --- PREVIEW (default) & MINT prepare + simulate ---
const mode = await page.$eval("#modeLabel", (e) => e.textContent);
ck("default mode is PREVIEW", mode === "PREVIEW", mode);

// enable the first available Mint button and click
await page.waitForFunction(() => !!document.querySelector("#grid [data-mint]:not([disabled])"), { timeout: 15000 });
await page.evaluate(() => document.querySelector("#grid [data-mint]:not([disabled])").click());
await page.waitForFunction(() => document.querySelector("#txpanelBody")?.textContent.includes("MINT"), { timeout: 15000 });
const txTxt = await page.$eval("#txpanelBody", (e) => e.textContent);
ck("tx panel shows wallet/network/tx details", txTxt.includes("MINT") && /X1 mainnet/.test(txTxt) && /VersionedTransaction/.test(txTxt), txTxt.replace(/\s+/g, " ").slice(0, 140));

await page.evaluate(() => document.querySelector("#simBtn").click());
await page.waitForFunction(() => {
  const t = document.querySelector("#txpanelBody")?.textContent || "";
  return /Simulation:.*(OK \(err: null\)|FAILED)/.test(t);
}, { timeout: 40000 });
const simTxt = await page.$eval("#txpanelBody", (e) => e.textContent);
ck("MINT RPC simulation err:null (end-to-end in browser)", /Simulation: OK \(err: null\)/.test(simTxt), simTxt.match(/Simulation:[^\n]*/)?.[0] || "");

// --- no console errors ---
ck("0 console errors", consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | "));
ck("0 uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 4).join(" | "));
ck("0 failed requests", failed.length === 0, failed.slice(0, 4).join(" | "));

await page.screenshot({ path: "shots/browser-test.png", fullPage: true }).catch(() => {});
await browser.close();

const failedCk = results.filter((r) => !r.ok);
console.log(`\n${failedCk.length === 0 ? "ALL BROWSER CHECKS PASSED" : failedCk.length + " CHECK(S) FAILED"}  (${results.length} checks) against ${TARGET_URL}`);
process.exit(failedCk.length === 0 ? 0 : 1);
