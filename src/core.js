/* Wolf Coin BETA — core: encodings, PDA helpers, instruction builders, decoders.
 *
 * Pure, DOM-free logic ONLY (no wallet, no DOM). This is the part that must match
 * the REVIEWED on-chain program exactly. The instruction builders here are reused
 * verbatim in spirit from the reviewed beta client
 * (wolf-coin-beta-website/src/app.js); the discriminators are independently
 * re-derived from the Anchor scheme (sha256("global:<name>")[0:8]) in
 * scripts/simulate.mjs and cross-checked against the live program.
 *
 * Reuses the REVIEWED program UNCHANGED. This file only *builds* transactions.
 */
import {
  PublicKey, TransactionInstruction, SystemProgram, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction, TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ATA_PROGRAM_ID,
} from "@solana/spl-token";

const enc = new TextEncoder();
const seed = (s) => enc.encode(s);

/* --------------------------------------------------------------- encodings */
// Anchor instruction discriminators: first 8 bytes of sha256("global:<ix_name>").
// Independently verified in scripts/simulate.mjs (err:null against the live program
// proves account order + discriminator are accepted).
export const D = {
  initializeRegistry: Uint8Array.from([189, 181, 20, 17, 174, 57, 249, 59]),
  mintCoin:           Uint8Array.from([146, 170, 74, 221, 167, 172, 132, 213]),
  redeem:             Uint8Array.from([184, 12, 86, 149, 70, 196, 97, 225]),
};

export const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
export const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
export const concat = (...as) => { const n = as.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(n); let p = 0; for (const a of as) { o.set(a, p); p += a.length; } return o; };

/** Minimal base58 (Bitcoin alphabet) encoder. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58encode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  let n = 0n;
  for (const b of u8) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of u8) { if (b === 0) out = "1" + out; else break; }
  return out;
}

/* --------------------------------------------------------------- program map */
export function programMap(cfg) {
  const PROGRAM_ID = new PublicKey(cfg.programId);
  const TOKEN_PROGRAM_ID = new PublicKey(cfg.tokenProgramId || SPL_TOKEN_PROGRAM_ID.toBase58());
  const ATA_ID = new PublicKey(cfg.associatedTokenProgramId || SPL_ATA_PROGRAM_ID.toBase58());
  const TM_ID = cfg.tokenMetadataProgramId ? new PublicKey(cfg.tokenMetadataProgramId) : null;
  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
  return {
    PROGRAM_ID, TOKEN_PROGRAM_ID, ATA_ID, TM_ID,
    registryPda: () => pda([seed("registry")]),
    claimPda: (s) => pda([seed("claim"), u32le(s)]),
    vaultPda: (s) => pda([seed("vault"), u32le(s)]),
    metaPda: (mint) => TM_ID ? PublicKey.findProgramAddressSync([seed("metadata"), TM_ID.toBuffer(), mint.toBuffer()], TM_ID)[0] : null,
    editionPda: (mint) => TM_ID ? PublicKey.findProgramAddressSync([seed("metadata"), TM_ID.toBuffer(), mint.toBuffer(), seed("edition")], TM_ID)[0] : null,
    ata: (owner, mint) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ATA_ID),
  };
}

/* --------------------------------------------------------------- instruction builders */
/** mint_coin(serial): locks exactly `collateralLamports` into vaultPda(serial). */
export function ixMintCoin(map, payer, serial, mint) {
  const keys = [
    { pubkey: map.registryPda(), isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: true, isWritable: true },
    { pubkey: map.ata(payer, mint), isSigner: false, isWritable: true },
    { pubkey: map.vaultPda(serial), isSigner: false, isWritable: true },
    { pubkey: map.claimPda(serial), isSigner: false, isWritable: true },
    { pubkey: map.metaPda(mint), isSigner: false, isWritable: true },
    { pubkey: map.editionPda(mint), isSigner: false, isWritable: true },
    { pubkey: map.TM_ID, isSigner: false, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: map.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: map.ATA_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: map.PROGRAM_ID, keys, data: concat(D.mintCoin, u32le(serial)) });
}

/** redeem(serial): burns the NFT and returns exactly `collateralLamports` to holder. */
export function ixRedeem(map, holder, serial, mint) {
  const keys = [
    { pubkey: map.registryPda(), isSigner: false, isWritable: true },
    { pubkey: map.claimPda(serial), isSigner: false, isWritable: true },
    { pubkey: map.vaultPda(serial), isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: map.ata(holder, mint), isSigner: false, isWritable: true },
    { pubkey: holder, isSigner: true, isWritable: true },
    { pubkey: map.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: map.PROGRAM_ID, keys, data: concat(D.redeem, u32le(serial)) });
}

/** transfer: create-idempotent recipient ATA + SPL transfer of exactly 1 unit. */
export function ixsTransfer(map, from, to, mint) {
  const src = map.ata(from, mint), dst = map.ata(to, mint);
  return [
    createAssociatedTokenAccountIdempotentInstruction(from, dst, to, mint, map.TOKEN_PROGRAM_ID, map.ATA_ID),
    createTransferInstruction(src, dst, from, 1, [], map.TOKEN_PROGRAM_ID),
  ];
}

export const computeBudgetIx = (units = 400_000) => ComputeBudgetProgram.setComputeUnitLimit({ units });

/* --------------------------------------------------------------- decoders */
export function decodeRegistry(data) {
  const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    authority: new PublicKey(b.slice(8, 40)),
    collateralLamports: Number(dv.getBigUint64(40, true)),
    minted: dv.getUint32(48, true),
    redeemed: dv.getUint32(52, true),
    used: dv.getBigUint64(56, true),
    bump: b[64],
  };
}
export function decodeClaim(data) {
  const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { serial: dv.getUint32(8, true), mint: new PublicKey(b.slice(12, 44)), bump: b[44] };
}
export function decodeTokenAccount(data) {
  const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { mint: new PublicKey(b.slice(0, 32)), owner: new PublicKey(b.slice(32, 64)), amount: Number(dv.getBigUint64(64, true)) };
}

/* --------------------------------------------------------------- validators */
export const serialUsed = (usedBitmap, s) => (BigInt(usedBitmap) & (1n << BigInt(s))) !== 0n;
export const serialLabel = (n) => "BETA-" + String(n).padStart(4, "0");
export const collateralMatches = (vaultLamports, registryCollateralLamports) =>
  Number(vaultLamports) === Number(registryCollateralLamports) && Number(registryCollateralLamports) > 0;

/** Validate a TRANSFER recipient. Never asks for keys. Rejects off-curve (program/PDA) addresses. */
export function validateRecipient(recipientStr, selfStr) {
  const s = String(recipientStr || "").trim();
  if (!s) return { ok: false, error: "Enter a recipient address." };
  let pk;
  try { pk = new PublicKey(s); } catch { return { ok: false, error: "Not a valid X1 address." }; }
  if (pk.toBase58() !== s) return { ok: false, error: "Address is not in canonical base58 form." };
  if (selfStr && pk.toBase58() === selfStr) return { ok: false, error: "Recipient is your own wallet." };
  if (!PublicKey.isOnCurve(pk.toBytes())) return { ok: false, error: "Recipient is not a wallet address (off-curve / program address) — the coin would be stranded." };
  return { ok: true, pubkey: pk };
}

/** Wrong-network / wrong-cluster check for the UI. */
export function classifyNetwork({ clusterKey, rpcReachable, programFound, programExecutable }) {
  const notes = [];
  let ok = true;
  if (!rpcReachable) { ok = false; notes.push(`RPC for ${clusterKey} unreachable`); }
  if (!programFound) { ok = false; notes.push(`program not deployed on ${clusterKey}`); }
  else if (!programExecutable) { ok = false; notes.push("program account is not executable"); }
  if (ok) notes.push(`${clusterKey} reachable · program present`);
  return { ok, notes };
}
