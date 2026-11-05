# Wolf Coin BETA — frontend

Clean, static **CONNECT · MINT · TRANSFER · REDEEM** client for the **reviewed** Wolf Coin
program on X1. No backend, no keys, no spend on its own.

> **EXPERIMENTAL / NOT AUDITED.** Backing is **REAL XNT** on X1 mainnet. Minting locks
> **exactly 5 XNT** per coin. Transfers and burns are permanent.

## What this is

* Reviewed on-chain program (unchanged, not redeployed): `L3MrpyJhTLrJv57c2BcFH3vBbrrCnsakfwn6wHvzTz5`
* Registry: `HxLucJYBVDQ5EAYd4urHBGmxNbLBVGb79qFNBxVmLbi4` (collateral **5 XNT** / serial)
* RPC: `https://rpc.mainnet.x1.xyz` · lib `@solana/web3.js`
* 10 serials `BETA-0001`…`BETA-0010`, each a 1-of-1 NFT with its own vault.

## Wallet integration (the fix)

Wallet detection uses the **verified X1 approach** proven by a real working X1 app
(`skywalker12345678/theo-sign`), instead of Wallet-Standard discovery (which did **not**
detect X1 Wallet):

| Wallet | Global | Connect | Sign |
| --- | --- | --- | --- |
| **X1 Wallet** | `window.x1Wallet` (`provider.isX1Wallet`) | `await provider.connect()` · `provider.publicKey.toString()` | `await provider.signAndSendTransaction(versionedTx)` → sig |
| **Backpack** | `window.backpack` / `window.xnft` | `provider.connect()` | `signTransaction(versionedTx)` → `connection.sendRawTransaction(signed.serialize(), {skipPreflight:true})` |

Transactions are assembled from the reviewed instruction builders and wrapped **defensively**
into a `VersionedTransaction` (V0), with a legacy-`Transaction` fallback if the wrap fails.

## Modes

* **PREVIEW (default):** every action runs only RPC `simulateTransaction` — nothing is signed or sent.
* **LIVE (explicit toggle):** the “Sign & send” button signs with the connected wallet and broadcasts.
  This is the only path that spends. Details (wallet, network, program, instruction list, effect)
  are always shown **before** any signature.

## Layout

```
index.html          the site (loads config.js + app.bundle.js)
config.js           runtime config (program id, registry, artwork hash, cluster)
styles.css
src/core.js         encodings, PDA helpers, instruction builders, decoders (pure)
src/app.js          wallet layer + UI
app.bundle.js       BUILT bundle committed for GitHub Pages (self-contained)
assets/             wolf artwork (sealed inscription, BLAKE3-verified)
scripts/build.mjs       esbuild → app.bundle.js
scripts/serve.mjs       local static server
scripts/verify-art.mjs  BLAKE3 verify artwork vs sealed inscription
scripts/simulate.mjs    re-derive discriminators + simulate all builders vs live program
scripts/test-browser.mjs automated Chrome-for-Testing test of a public URL
```

## Develop / verify

```bash
npm install
npm run build            # -> app.bundle.js
npm run verify-art       # artwork BLAKE3 == sealed inscription
npm run simulate         # discriminators + MINT/TRANSFER/REDEEM simulation (err:null where possible)
npm run serve            # http://127.0.0.1:8099/
npm run test:browser -- https://<public-url>/
```

Chrome for Testing (for the browser tool / tests) installs user-local, no sudo:

```bash
mkdir -p ~/.local/chrome-for-testing && cd ~/.local/chrome-for-testing
curl -fsSL -o chrome-linux64.zip "$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json | python3 -c 'import json,sys;d=json.load(sys.stdin)["channels"]["Stable"];print([x["url"] for x in d["downloads"]["chrome"] if x["platform"]=="linux64"][0])')"
python3 -c "import zipfile;zipfile.ZipFile('chrome-linux64.zip').extractall('.')"
```
