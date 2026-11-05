/* Wolf Coin BETA — runtime configuration (loaded before app.bundle.js).
 *
 * Deployment-tunable WITHOUT rebuilding the bundle. No secrets belong here;
 * RPC endpoints are public.
 */
window.WOLF_BETA = {
  // ---- on-chain identity (REVIEWED program — do not change without re-review) ----
  programId: "L3MrpyJhTLrJv57c2BcFH3vBbrrCnsakfwn6wHvzTz5",
  registryId: "HxLucJYBVDQ5EAYd4urHBGmxNbLBVGb79qFNBxVmLbi4",
  tokenMetadataProgramId: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  tokenProgramId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  associatedTokenProgramId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",

  // ---- clusters (X1 program is deployed on mainnet; testnet has no program) ----
  clusters: {
    mainnet: {
      label: "X1 mainnet",
      rpc: "https://rpc.mainnet.x1.xyz",
      explorer: "https://explorer.mainnet.x1.xyz",
      realValue: true,
    },
  },
  defaultCluster: "mainnet",

  // ---- the beta collection ----
  maxSupply: 10,
  serialFirstName: 1,
  collateralXnt: 5,
  collateralLamports: 5_000_000_000,
  serialLabel: function (n) { return "BETA-" + String(n).padStart(4, "0"); },

  // ---- artwork (the SEALED X1 Vault inscription, bundled + BLAKE3-verified) ----
  artwork: {
    src: "assets/wolf-coin.webp",
    heroSrc: "assets/wolf-coin-hero.webp",
    blake3: "1c870487914dc51dab1d5edba988c399960a3f464faa3bf3cdb396ce9d3b8f7c",
    size: 316818,
    mime: "image/webp",
    inscription: "5F1GrsYDZusa5y6QkFb3syevDKiaQVkVBRGJCn7mwMuG",
  },

  // ---- wallet-art hosting (on-chain Metaplex uri points here) ----
  metadataBase: "https://cdn.jsdelivr.net/gh/x1goose404-ops/wolfcoin-metadata@v1/metadata/",
};
