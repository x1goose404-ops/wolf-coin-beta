#!/usr/bin/env node
/* Independent verification (read-only, never signs/sends/spends):
 *  1. Re-derive the Anchor discriminators from sha256("global:<name>") and assert they equal
 *     the D table used by the deployed client (src/core.js).
 *  2. Decode the LIVE registry account and print supply/collateral.
 *  3. Simulate every transaction builder from src/core.js against the LIVE reviewed program
 *     on X1 mainnet, using a VersionedTransaction (the exact browser path), sigVerify=false.
 *     MINT and TRANSFER must return err:null. REDEEM on an unminted serial cannot return
 *     err:null by construction; we assert the program RECOGNISES it (logs "Instruction: Redeem"
 *     and reaches the named `claim` account check) — proving discriminator + account order.
 *
 * No wallet, no keypair signing of real funds, no transactions are sent.
 */
import { createHash } from "node:crypto";
import {
  Connection, PublicKey, Keypair, VersionedTransaction, TransactionMessage, Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { D, u32le, programMap, ixMintCoin, ixRedeem, ixsTransfer, decodeRegistry, computeBudgetIx } from "../src/core.js";

const RPC = "https://rpc.mainnet.x1.xyz";
const CFG = {
  programId: "L3MrpyJhTLrJv57c2BcFH3vBbrrCnsakfwn6wHvzTz5",
  registryId: "HxLucJYBVDQ5EAYd4urHBGmxNbLBVGb79qFNBxVmLbi4",
  tokenMetadataProgramId: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  tokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
  associatedTokenProgramId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
};
const map = programMap(CFG);
const conn = new Connection(RPC, "confirmed");
let failures = 0;
const ck = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!cond) failures++; };

/* ---- 1. discriminators ---- */
console.log("== 1. Anchor discriminators (independently re-derived) ==");
const disc = (n) => Uint8Array.from(createHash("sha256").update("global:" + n).digest().slice(0, 8));
const hex = (u) => Buffer.from(u).toString("hex");
const names = { initializeRegistry: "initialize_registry", mintCoin: "mint_coin", redeem: "redeem" };
for (const [k, n] of Object.entries(names)) {
  const want = hex(disc(n));
  const got = hex(D[k]);
  ck(`${k} == sha256("global:${n}")[0:8]`, want === got, `${got}`);
}

/* ---- 2. live registry ---- */
console.log("\n== 2. Live registry account ==");
const regInfo = await conn.getAccountInfo(map.registryPda(), "confirmed");
ck("registry PDA matches config.registryId", map.registryPda().toBase58() === CFG.registryId, map.registryPda().toBase58());
let reg = null;
if (regInfo) {
  reg = decodeRegistry(Uint8Array.from(regInfo.data));
  console.log(`   registry: authority=${reg.authority.toBase58()} collateral=${reg.collateralLamports / 1e9} XNT minted=${reg.minted} redeemed=${reg.redeemed} used=${reg.used}`);
  ck("registry collateral == 5 XNT", reg.collateralLamports === 5_000_000_000);
}

/* ---- simulation helper (VersionedTransaction, exactly like the browser) ---- */
const payer = reg ? reg.authority : Keypair.generate().publicKey; // funded authority; NEVER signs here
async function simulateV0(label, instructions, signers = []) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer, recentBlockhash: blockhash,
    instructions: [computeBudgetIx(400_000), ...instructions],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  if (signers.length) vtx.sign(signers);
  const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  return sim.value;
}

/* ---- 3a. MINT ---- */
console.log("\n== 3a. MINT (mint_coin) — VersionedTransaction vs live program ==");
const serial = 1;
const used = reg ? (BigInt(reg.used) & (1n << BigInt(serial))) !== 0n : false;
if (used) {
  console.log(`   serial ${serial} already used — mint sim skipped`);
} else {
  const mintKp = Keypair.generate();
  const v = await simulateV0("MINT", [ixMintCoin(map, payer, serial, mintKp.publicKey)], [mintKp]);
  console.log("   err:", JSON.stringify(v.err), "units:", v.unitsConsumed);
  console.log("   log:", (v.logs || []).find((l) => l.includes("Instruction:")) || "(none)");
  ck("MINT simulation err:null", v.err === null);
  ck("MINT logs show MintCoin", (v.logs || []).some((l) => l.includes("Instruction: MintCoin")));
}

/* ---- 3b. TRANSFER ---- */
console.log("\n== 3b. TRANSFER (create-idempotent-ATA + SPL transfer 1) ==");
const list = await conn.getTokenAccountsByOwner(payer, { programId: TOKEN_PROGRAM_ID }, { encoding: "base64" });
const parse = (a) => { const raw = Array.isArray(a.account.data) ? a.account.data[0] : a.account.data; const d = Buffer.from(raw, "base64"); return { mint: new PublicKey(d.subarray(0, 32)), amount: d.readBigUInt64LE(64) }; };
const toks = list.value.map(parse).filter((t) => t.amount > 0n);
if (!toks.length) { console.log("   no SPL tokens on the funding account — transfer sim skipped"); }
else {
  const to = Keypair.generate().publicKey;
  const v = await simulateV0("TRANSFER", ixsTransfer(map, payer, to, toks[0].mint));
  console.log("   err:", JSON.stringify(v.err), "units:", v.unitsConsumed);
  ck("TRANSFER simulation err:null (ATA + SPL transfer valid)", v.err === null);
}

/* ---- 3c. REDEEM ---- */
console.log("\n== 3c. REDEEM (redeem) — encoding recognised by live program ==");
const redeemMint = toks.length ? toks[0].mint : Keypair.generate().publicKey;
const v = await simulateV0("REDEEM", [ixRedeem(map, payer, serial, redeemMint)]);
console.log("   err:", JSON.stringify(v.err));
console.log("   log:", (v.logs || []).filter((l) => l.includes("Instruction:") || l.includes("AnchorError")).join(" | "));
const recognised = (v.logs || []).some((l) => l.includes("Instruction: Redeem"));
ck("REDEEM discriminator recognised (logs 'Instruction: Redeem')", recognised);
if (v.err === null) ck("REDEEM simulation err:null", true);
else {
  // On an unminted serial the only correct failure is AccountNotInitialized on `claim`.
  const isExpected = JSON.stringify(v.err).includes("3012") || JSON.stringify(v.err).includes("AccountNotInitialized");
  ck("REDEEM fails only as expected (claim not initialized — serial unminted)", isExpected, JSON.stringify(v.err));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
