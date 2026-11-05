/* Wolf Coin BETA — app: wallet + UI. Static site; no backend; NEVER asks for seed/keys.
 *
 * Wallet integration follows the VERIFIED X1 approach proven by a real working X1 app
 * (github.com/skywalker12345678/theo-sign/index.html), independently re-read for this build:
 *   • X1 Wallet    : window.x1Wallet   · await provider.connect() · provider.publicKey.toString()
 *                    · flag provider.isX1Wallet · await provider.signAndSendTransaction(versionedTx) -> sig
 *   • Backpack     : window.backpack || window.xnft · provider.signTransaction(versionedTx)
 *                    · connection.sendRawTransaction(signed.serialize(), { skipPreflight: true })
 *
 * Transactions are assembled from the reviewed instruction builders (src/core.js) and wrapped
 * into a VersionedTransaction DEFENSIVELY (our instructions are legacy/V0-compatible): the V0
 * wrap is attempted first and a legacy Transaction is used as a fallback if the wrap fails.
 *
 * Default mode is PREVIEW: every action only runs RPC `simulateTransaction` — nothing is signed
 * or sent. Live signing happens only after the user explicitly enables LIVE mode AND clicks
 * "Sign & send" with a connected wallet. This site never spends on its own.
 */
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
import {
  Connection, PublicKey, Transaction, VersionedTransaction, TransactionMessage,
  Keypair, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  programMap, computeBudgetIx, ixMintCoin, ixRedeem, ixsTransfer,
  decodeRegistry, decodeClaim, decodeTokenAccount,
  serialUsed, serialLabel, validateRecipient, classifyNetwork, collateralMatches,
} from "./core.js";

const CFG = window.WOLF_BETA;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const app = {
  map: null, connection: null,
  provider: null, wallet: null,
  registry: null, coins: [],
  mode: "preview",          // "preview" (default) | "live"
  busy: false, net: null,
  pending: null,            // built tx pending signature
};

const cfgCluster = () => CFG.clusters[CFG.defaultCluster];
const explorerTx = (sig) => `${cfgCluster().explorer}/tx/${sig}`;
const explorerAddr = (a) => `${cfgCluster().explorer}/address/${a}`;
const short = (s, n = 4) => (typeof s === "string" ? `${s.slice(0, n)}…${s.slice(-n)}` : "");
const fmt = (lamports) => (Number(lamports) / LAMPORTS_PER_SOL);

/* ================================================================ WALLETS
 * Direct global detection, X1 Wallet FIRST — exactly the theo-sign approach. */
function detectWallets() {
  const list = [];
  const push = (id, name, provider) => { if (provider && typeof provider === "object") list.push({ id, name, provider }); };
  push("x1", "X1 Wallet", window.x1Wallet);
  push("backpack", "Backpack", window.backpack || window.xnft);
  push("phantom", "Phantom", window.phantom?.solana);
  if (window.solana) push("solana", window.solana.isPhantom ? "Phantom" : "Solana wallet", window.solana);
  push("solflare", "Solflare", window.solflare);
  // de-dupe by provider identity
  const seen = new Set();
  return list.filter((w) => { if (seen.has(w.provider)) return false; seen.add(w.provider); return true; });
}
const isX1 = (w) => !!w && (w.id === "x1" || !!w.provider?.isX1Wallet);
function walletFeatures(w) {
  const p = w.provider, f = [];
  if (p.connect) f.push("connect");
  if (p.disconnect) f.push("disconnect");
  if (p.signTransaction) f.push("signTransaction");
  if (p.signAndSendTransaction) f.push("signAndSendTransaction");
  if (p.isX1Wallet) f.push("isX1Wallet");
  return f;
}

async function connectWallet(id) {
  const entry = detectWallets().find((w) => w.id === id) || detectWallets()[0];
  if (!entry) { toast("No X1-compatible wallet detected. Install X1 Wallet, then reload.", "warn"); return; }
  const p = entry.provider;
  if (typeof p.connect !== "function") { toast(`${entry.name} has no connect() method.`, "err"); return; }
  try {
    log(`Connecting ${entry.name}…`);
    const res = await p.connect();
    const pkStr = (p.publicKey || res?.publicKey || res)?.toString?.();
    if (!pkStr) throw new Error("wallet returned no public key");
    app.provider = entry;
    app.wallet = new PublicKey(pkStr);
    render();
    log(`Connected · ${entry.name}${isX1(entry) ? " (X1)" : ""} · ${app.wallet.toBase58()} · features [${walletFeatures(entry).join(", ")}]`);
    toast(`Connected ${entry.name} · ${short(app.wallet.toBase58(), 6)}`, "ok");
    await verifyNetwork();
    await refreshChainState();
  } catch (e) {
    app.provider = null; app.wallet = null; render();
    toast(`Connect failed (${entry.name}): ${e.message || e}`, "err");
    log(`Connect FAILED (${entry.name}): ${e.message || e}`);
  }
}
async function disconnectWallet() {
  try { await app.provider?.provider?.disconnect?.(); } catch { /* ignore */ }
  app.provider = null; app.wallet = null; app.coins = []; app.pending = null; render();
  toast("Disconnected.", "ok");
}

/* ================================================================ NETWORK */
async function rpcHealth(rpc) {
  try {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) });
    return r.ok;
  } catch { return false; }
}
async function verifyNetwork() {
  const c = cfgCluster();
  let rpcReachable = true;
  try { await app.connection.getVersion(); } catch { rpcReachable = await rpcHealth(c.rpc); }
  const prog = await app.connection.getAccountInfo(app.map.PROGRAM_ID).catch(() => null);
  if (prog) rpcReachable = true;
  app.net = classifyNetwork({ clusterKey: c.label, rpcReachable, programFound: !!prog, programExecutable: prog ? prog.executable : false });
  if (!app.net.ok) toast(app.net.notes.join(" · "), "warn");
  render();
}

/* ================================================================ CHAIN STATE */
async function refreshChainState() {
  if (app.busy) return;
  app.busy = true; render();
  try {
    const serials = Array.from({ length: CFG.maxSupply }, (_, i) => CFG.serialFirstName + i);
    const [regInfo, claimInfos] = await Promise.all([
      app.connection.getAccountInfo(app.map.registryPda(), "confirmed"),
      app.connection.getMultipleAccountsInfo(serials.map((s) => app.map.claimPda(s)), "confirmed"),
    ]);
    app.registry = regInfo ? decodeRegistry(Uint8Array.from(regInfo.data)) : null;

    const vaultInfos = await app.connection.getMultipleAccountsInfo(serials.map((s) => app.map.vaultPda(s)), "confirmed");
    const owner = app.wallet || null;
    const heldMints = [];
    claimInfos.forEach((ci) => { if (ci) heldMints.push(decodeClaim(Uint8Array.from(ci.data)).mint); });
    let ataInfos = [];
    if (owner && heldMints.length) ataInfos = await app.connection.getMultipleAccountsInfo(heldMints.map((m) => app.map.ata(owner, m)), "confirmed");
    const ataByMint = new Map();
    heldMints.forEach((m, i) => ataByMint.set(m.toBase58(), ataInfos[i]));

    app.coins = serials.map((s, i) => {
      const coin = { serial: s, label: serialLabel(s), used: app.registry ? serialUsed(app.registry.used, s) : null, claim: null, vaultLamports: 0, owned: false, mint: null };
      const ci = claimInfos[i];
      if (ci) {
        coin.claim = decodeClaim(Uint8Array.from(ci.data));
        coin.mint = coin.claim.mint;
        const vi = vaultInfos[i];
        coin.vaultLamports = vi ? vi.lamports : 0;
        if (owner) {
          const ai = ataByMint.get(coin.mint.toBase58());
          if (ai) { const d = decodeTokenAccount(Uint8Array.from(ai.data)); coin.owned = d.owner.equals(owner) && d.amount === 1; }
        }
      }
      return coin;
    });
    render();
  } catch (e) {
    toast(`State read failed: ${e.message || e}`, "err");
  } finally {
    app.busy = false; render();
  }
}

/* ================================================================ TX PIPELINE */
/** Build a VersionedTransaction from instructions, falling back to a legacy Transaction. */
function buildTx(instructions, payer, recentBlockhash, signers = []) {
  const all = [computeBudgetIx(400_000), ...instructions];
  try {
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions: all }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    if (signers.length) vtx.sign(signers);
    return { tx: vtx, versioned: true };
  } catch (e) {
    const tx = new Transaction().add(...all);
    tx.feePayer = payer;
    tx.recentBlockhash = recentBlockhash;
    if (signers.length) tx.partialSign(...signers);
    return { tx, versioned: false, wrapError: e.message };
  }
}

/** Prepare (build) a transaction and show its details BEFORE any signature. */
async function prepareTx(label, instructions, signers, details) {
  if (!app.wallet) { toast("Connect a wallet first.", "warn"); return; }
  const payer = app.wallet;
  const { blockhash } = await app.connection.getLatestBlockhash("confirmed");
  const built = buildTx(instructions, payer, blockhash, signers);
  app.pending = { label, built, details, instructions, signers, blockhash };
  render();
  $("#txpanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  log(`Prepared ${label} · ${built.versioned ? "VersionedTransaction (V0)" : "legacy Transaction (fallback)"}`);
}

async function simulatePending() {
  const pend = app.pending;
  if (!pend) return;
  try {
    log(`Simulating ${pend.label}…`);
    const cfg = { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" };
    let sim;
    try { sim = await app.connection.simulateTransaction(pend.built.tx, cfg); }
    catch (e) {
      if (!pend.built.versioned) throw e;
      // fall back to the legacy form for a more compatible simulate call
      const tx = new Transaction().add(...[computeBudgetIx(400_000), ...pend.instructions]);
      tx.feePayer = app.wallet; tx.recentBlockhash = pend.blockhash;
      sim = await app.connection.simulateTransaction(tx);
    }
    pend.sim = { err: sim.value.err, units: sim.value.unitsConsumed, logs: (sim.value.logs || []) };
    if (sim.value.err) { toast(`${pend.label}: simulation FAILED — ${JSON.stringify(sim.value.err)}`, "err"); log(`SIM ${pend.label} FAILED ${JSON.stringify(sim.value.err)}`); }
    else { toast(`${pend.label}: DRY-RUN OK (simulated, nothing sent).`, "ok"); log(`SIM ${pend.label} OK · units=${sim.value.unitsConsumed ?? "?"}`); }
  } catch (e) {
    toast(`${pend.label}: simulate error — ${e.message || e}`, "err");
    log(`SIM ${pend.label} ERROR: ${e.message || e}`);
  }
  render();
}

async function signAndSendPending() {
  const pend = app.pending;
  if (!pend) return;
  if (app.mode !== "live") { toast("Enable LIVE mode to sign & send. Preview mode never signs.", "warn"); return; }
  if (!app.wallet) { toast("Connect a wallet first.", "warn"); return; }
  const entry = app.provider, p = entry.provider;
  const confirmed = await withConfirm(`${pend.label}`,
    `Sign & send with ${entry.name} on ${cfgCluster().label}. This is a REAL transaction.`, detailsText(pend.details));
  if (!confirmed) return;
  app.busy = true; render();
  try {
    let sig;
    if (isX1(entry) && typeof p.signAndSendTransaction === "function") {
      const r = await p.signAndSendTransaction(pend.built.tx);         // X1: sign AND send
      sig = typeof r === "string" ? r : r.signature;
    } else if (typeof p.signTransaction === "function") {
      const signed = await p.signTransaction(pend.built.tx);           // Backpack/others: sign then send
      const raw = signed?.serialize ? signed.serialize() : signed;
      sig = await app.connection.sendRawTransaction(raw, { skipPreflight: true });
    } else if (typeof p.signAndSendTransaction === "function") {
      const r = await p.signAndSendTransaction(pend.built.tx);
      sig = typeof r === "string" ? r : r.signature;
    } else {
      throw new Error("wallet cannot sign transactions");
    }
    log(`${pend.label} sent: <a href="${explorerTx(sig)}" target="_blank" rel="noopener">${sig.slice(0, 12)}…</a>`);
    const conf = await app.connection.confirmTransaction(sig, "confirmed");
    if (conf.value.err) throw new Error("tx failed on-chain: " + JSON.stringify(conf.value.err));
    toast(`${pend.label} confirmed ✔ ${short(sig, 6)}`, "ok");
    app.pending = null; app.busy = false;
    await refreshChainState();
  } catch (e) {
    toast(`${pend.label} failed: ${e.message || e}`, "err");
    log(`${pend.label} FAILED: ${e.message || e}`);
    app.busy = false; render();
  }
}

/* ================================================================ FLOWS */
async function doMint(serial) {
  const c = app.coins.find((x) => x.serial === serial);
  if (c?.used) { toast(`Serial ${c.label} is already minted (retired once used).`, "warn"); return; }
  const mintKp = Keypair.generate();
  const ix = ixMintCoin(app.map, app.wallet, serial, mintKp.publicKey);
  await prepareTx(`Mint ${serialLabel(serial)}`, [ix], [mintKp], {
    action: "MINT (mint_coin)", serial, program: CFG.programId,
    effect: `Locks exactly ${CFG.collateralXnt} XNT into vault PDA · mints a 1-of-1 NFT to your ATA`,
    extra: [["Mint (new)", mintKp.publicKey.toBase58()], ["Vault PDA", app.map.vaultPda(serial).toBase58()], ["Claim PDA", app.map.claimPda(serial).toBase58()]],
  });
}
async function doTransfer(serial, recipientStr) {
  const v = validateRecipient(recipientStr, app.wallet?.toBase58());
  if (!v.ok) { toast(v.error, "warn"); return; }
  const c = app.coins.find((x) => x.serial === serial);
  if (!c?.owned) { toast("You do not currently hold this coin (on-chain ownership check failed).", "warn"); return; }
  const ixs = ixsTransfer(app.map, app.wallet, v.pubkey, c.mint);
  await prepareTx(`Transfer ${c.label}`, ixs, [], {
    action: "TRANSFER (SPL transfer, amount = 1)", serial, program: CFG.programId,
    effect: `Sends the coin AND the ${CFG.collateralXnt} XNT redemption right to the recipient`,
    extra: [["Recipient", v.pubkey.toBase58()], ["Mint", c.mint.toBase58()]],
  });
}
async function doRedeem(serial) {
  const c = app.coins.find((x) => x.serial === serial);
  if (!c?.owned) { toast("You do not currently hold this coin.", "warn"); return; }
  if (!collateralMatches(c.vaultLamports, app.registry?.collateralLamports ?? CFG.collateralLamports)) {
    toast(`Collateral check failed: vault holds ${c.vaultLamports} lamports, expected ${app.registry?.collateralLamports ?? CFG.collateralLamports}.`, "warn");
    return;
  }
  const ix = ixRedeem(app.map, app.wallet, serial, c.mint);
  await prepareTx(`Redeem ${c.label}`, [ix], [], {
    action: "REDEEM (redeem)", serial, program: CFG.programId,
    effect: `PERMANENTLY burns the NFT and returns exactly ${CFG.collateralXnt} XNT to you · serial retired forever`,
    extra: [["Mint (burned)", c.mint.toBase58()], ["Vault PDA", app.map.vaultPda(serial).toBase58()]],
  });
}

/* ================================================================ RENDER */
function setTxt(id, v) { const e = document.getElementById(id); if (e && v != null) e.textContent = v; }
function render() {
  const c = cfgCluster();
  setTxt("clusterLabel", c.label);
  setTxt("progId", CFG.programId);
  setTxt("regId", CFG.registryId);
  setTxt("artHash", CFG.artwork.blake3);
  setTxt("artInscription", CFG.artwork.inscription);

  // wallet panel
  const det = detectWallets();
  $("#walletPill").textContent = app.wallet ? `${app.provider.name} · ${short(app.wallet.toBase58(), 4)}` : "not connected";
  $("#connectBtn").textContent = app.wallet ? "Disconnect" : "Connect wallet";
  $("#wallets").innerHTML = det.length
    ? det.map((w) => `<button class="btn small wallet" data-connect="${w.id}">
         <b>${w.name}</b>${isX1(w) ? ' <span class="tag x1">X1</span>' : ""}
         <span class="muted">[${walletFeatures(w).join(", ") || "no features"}]</span></button>`).join("")
    : '<span class="muted">No wallet detected — install X1 Wallet (window.x1Wallet), then reload.</span>';
  $$("#wallets [data-connect]").forEach((b) => b.addEventListener("click", () => connectWallet(b.dataset.connect)));

  const wc = $("#walletCard");
  if (app.wallet) {
    wc.hidden = false;
    wc.innerHTML = `<div class="kv"><span>Wallet</span><span>${app.provider.name}${isX1(app.provider) ? " (X1)" : ""}</span></div>
      <div class="kv"><span>Address</span><span class="mono"><a href="${explorerAddr(app.wallet.toBase58())}" target="_blank" rel="noopener">${app.wallet.toBase58()}</a></span></div>
      <div class="kv"><span>Network</span><span>${c.label} · ${c.rpc}</span></div>
      <div class="kv"><span>Features</span><span>${walletFeatures(app.provider).join(", ")}</span></div>`;
  } else wc.hidden = true;

  // network check
  const netEl = $("#netcheck");
  if (app.net) { netEl.hidden = false; netEl.className = "netcheck " + (app.net.ok ? "ok" : "bad"); netEl.textContent = (app.net.ok ? "✔ " : "⚠ ") + app.net.notes.join(" · "); }
  else netEl.hidden = true;

  // mode
  $("#liveToggle").checked = app.mode === "live";
  $("#modeLabel").textContent = app.mode === "live" ? "LIVE" : "PREVIEW";
  $("#modeLabel").className = "tag " + (app.mode === "live" ? "live" : "preview");
  $("#liveBanner").hidden = app.mode !== "live";

  // stats
  const reg = app.registry;
  $("#supply").textContent = reg ? `${reg.minted}/${CFG.maxSupply}` : `–/${CFG.maxSupply}`;
  $("#cost").textContent = `${CFG.collateralXnt} XNT`;

  // collection grid
  $("#grid").innerHTML = (app.coins.length ? app.coins : placeholders()).map((coin) => {
    const state = coin.used === null ? "unknown" : coin.used ? (coin.claim ? "minted" : "retired") : "available";
    return `<article class="card" data-serial="${coin.serial}">
      <img class="card__art" src="assets/wolf-coin.webp" alt="Wolf Coin ${coin.label}" loading="lazy" width="256" height="256">
      <div class="card__body">
        <div class="kicker">SERIAL ${coin.label}</div>
        <div class="meta"><span>Backing <b>${CFG.collateralXnt} XNT</b></span><span>State <b class="st-${state}">${state}</b></span></div>
        ${coin.owned ? '<span class="tag own">you own it</span>' : ""}
        <button class="btn small" data-mint="${coin.serial}" ${(coin.used === false && app.wallet) ? "" : "disabled"}>Mint…</button>
      </div>
    </article>`;
  }).join("");
  $$("#grid [data-mint]").forEach((b) => b.addEventListener("click", () => doMint(Number(b.dataset.mint))));

  // transfer + redeem lists
  const owned = app.coins.filter((x) => x.owned);
  $("#transferList").innerHTML = owned.length
    ? owned.map((x) => `<div class="rowitem" data-serial="${x.serial}"><b>${x.label}</b> <span class="muted mono">${short(x.mint.toBase58(), 6)}</span>
        <input class="recipient" id="recip-${x.serial}" placeholder="Recipient X1 address" autocomplete="off" spellcheck="false" />
        <button class="btn small" data-transfer="${x.serial}">Prepare transfer</button></div>`).join("")
    : `<span class="muted">${app.wallet ? "You hold no Wolf Coins." : "Connect a wallet to list your coins."}</span>`;
  $$("#transferList [data-transfer]").forEach((b) => b.addEventListener("click", () => doTransfer(Number(b.dataset.transfer), document.getElementById(`recip-${b.dataset.transfer}`).value)));

  $("#redeemList").innerHTML = owned.length
    ? owned.map((x) => `<div class="rowitem" data-serial="${x.serial}"><b>${x.label}</b> <span class="muted">vault ${fmt(x.vaultLamports).toFixed(9)} XNT</span>
        <button class="btn small danger" data-redeem="${x.serial}">Prepare redeem (burn)</button></div>`).join("")
    : `<span class="muted">${app.wallet ? "No redeemable coins." : "Connect a wallet to list redeemable coins."}</span>`;
  $$("#redeemList [data-redeem]").forEach((b) => b.addEventListener("click", () => doRedeem(Number(b.dataset.redeem))));

  renderTxPanel();
  $("#refreshBtn").disabled = app.busy;
}

function renderTxPanel() {
  const el = $("#txpanelBody");
  const pend = app.pending;
  if (!pend) { el.innerHTML = '<span class="muted">No transaction prepared. Use the buttons above — details appear here BEFORE any signature.</span>'; return; }
  const b = pend.built;
  const rows = [
    ["Action", pend.details.action],
    ["Mode", app.mode === "live" ? "LIVE (will sign & send)" : "PREVIEW (simulate only — nothing sent)"],
    ["Wallet", app.wallet ? `${app.provider.name} · ${app.wallet.toBase58()}` : "—"],
    ["Network", `${cfgCluster().label} · ${cfgCluster().rpc}`],
    ["Program", app.map.PROGRAM_ID.toBase58()],
    ["Tx type", b.versioned ? "VersionedTransaction (V0)" : `legacy Transaction (fallback${b.wrapError ? ": " + b.wrapError : ""})`],
    ["Fee payer", app.wallet?.toBase58() ?? "—"],
    ["Recent blockhash", pend.blockhash],
    ["Instructions", String(pend.instructions.length + 1) + " (incl. compute budget)"],
    ["Expected effect", pend.details.effect],
  ];
  for (const [k, v] of (pend.details.extra || [])) rows.push([k, v]);
  const simHtml = pend.sim
    ? `<div class="sim ${pend.sim.err ? "bad" : "ok"}"><b>Simulation:</b> ${pend.sim.err ? "FAILED — " + JSON.stringify(pend.sim.err) : "OK (err: null)"}${pend.sim.units != null ? ` · units ${pend.sim.units}` : ""}
        <pre>${(pend.sim.logs || []).slice(-8).join("\n")}</pre></div>`
    : "";
  el.innerHTML = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span class="mono">${v}</span></div>`).join("") + simHtml +
    `<div class="actions">
       <button class="btn" id="simBtn">Simulate (dry-run)</button>
       <button class="btn primary" id="sendBtn" ${app.mode === "live" && app.wallet ? "" : "disabled"}>Sign &amp; send (${app.mode === "live" ? "LIVE" : "locked — enable LIVE"})</button>
       <button class="btn" id="clearBtn">Clear</button>
     </div>
     <div class="warn small">Nothing is signed until you enable LIVE mode and press “Sign &amp; send”. ${app.mode === "preview" ? "Preview mode runs RPC simulation only." : "LIVE mode is on — a real transaction will be signed and broadcast."}</div>`;
  $("#simBtn").addEventListener("click", simulatePending);
  $("#sendBtn").addEventListener("click", signAndSendPending);
  $("#clearBtn").addEventListener("click", () => { app.pending = null; render(); });
}

function placeholders() {
  return Array.from({ length: CFG.maxSupply }, (_, i) => ({ serial: CFG.serialFirstName + i, label: serialLabel(CFG.serialFirstName + i), used: null, claim: null, vaultLamports: 0, owned: false }));
}

/* ================================================================ modals/log/toast */
let confirmResolve = null;
function withConfirm(title, body, detailsHtml) {
  return new Promise((resolve) => {
    $("#confirmTitle").textContent = title;
    $("#confirmBody").innerHTML = `${body}<div class="confirmDetails">${detailsHtml || ""}</div>`;
    $("#confirm").hidden = false;
    confirmResolve = resolve;
  });
}
function detailsText(details) {
  const rows = [["Action", details.action], ["Effect", details.effect], ["Network", cfgCluster().label], ["Wallet", app.wallet ? app.wallet.toBase58() : "—"], ["Program", CFG.programId]];
  for (const [k, v] of (details.extra || [])) rows.push([k, v]);
  return `<div class="kvlist">${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span class="mono">${v}</span></div>`).join("")}</div>`;
}
function wireConfirm() {
  $("#confirmNo").addEventListener("click", () => { $("#confirm").hidden = true; if (confirmResolve) confirmResolve(false); confirmResolve = null; });
  $("#confirmYes").addEventListener("click", () => { $("#confirm").hidden = true; if (confirmResolve) confirmResolve(true); confirmResolve = null; });
}

const LOG = [];
function log(html) { LOG.unshift(`<b>${new Date().toLocaleTimeString()}</b> ${html}`); if (LOG.length > 100) LOG.pop(); const el = $("#log"); if (el) el.innerHTML = LOG.map((l) => `<div class="l">${l}</div>`).join(""); }
let toastTimer = null;
function toast(msg, kind = "ok") {
  const el = $("#toast"); el.className = "toast " + kind; el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, kind === "err" ? 9000 : 5000);
}

/* ================================================================ init */
function init() {
  app.map = programMap(CFG);
  app.connection = new Connection(cfgCluster().rpc, "confirmed");
  wireConfirm();
  $("#connectBtn").addEventListener("click", () => (app.wallet ? disconnectWallet() : connectWallet("x1")));
  $("#refreshBtn").addEventListener("click", () => { if (!app.wallet) { toast("Connect a wallet to load holdings.", "warn"); return; } refreshChainState(); });
  $("#liveToggle").addEventListener("change", (e) => {
    app.mode = e.target.checked ? "live" : "preview";
    toast(app.mode === "live" ? "LIVE mode ON — transactions will be signed & sent." : "Preview mode ON — simulate only.", app.mode === "live" ? "warn" : "ok");
    render();
  });
  log(`Wolf Coin BETA loaded · program ${short(CFG.programId, 6)} · registry ${short(CFG.registryId, 6)} · ${CFG.maxSupply} serials · ${CFG.collateralXnt} XNT backing · ${cfgCluster().label}.`);
  render();
  try { window.WOLF_DEBUG = { app, CFG, detectWallets, connectWallet, disconnectWallet, verifyNetwork, refreshChainState, prepareTx, doMint, doTransfer, doRedeem, simulatePending }; } catch { /* ignore */ }
  refreshChainState();
}
document.addEventListener("DOMContentLoaded", init);
