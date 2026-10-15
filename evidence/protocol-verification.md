# Cross-protocol verification

Recorded 2026-10-15. All on-chain checks used `https://mcp.pharos.xyz/mcp`; no direct RPC fallback was used.

## Official deployment provenance

- FaroSwap's production application (`https://faroswap.xyz/`) loads the production bundle linked in `src/constants.js`. Its chain-1672 configuration contains the DODO V2 and FaroSwap V2 deployment addresses used here.
- DODO V2 contract interfaces and pricing semantics are sourced from the official `DODOEX/contractV2` repository. The scanner uses `DVMFactory.getDODOPoolBidirection`, `querySellQuote`, `querySellBase`, `getUserFeeRate`, `getMidPrice`, and `getVaultReserve` according to those contracts.
- FaroSwap V2 provenance is also linked to the official FaroSwap interface and contracts repositories.

## Pinned verification snapshot

At Pharos Pacific Mainnet block `20327364`:

- Chain ID: `1672`.
- Pair: WPROS `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0` (18 decimals) / USDC `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` (6 decimals).
- DODO DVM factory `0xB9319bCEe26F1A6AC7207A738B021cdEC771b30E` returned pool `0xac998dD78829aDe9f654e0BE7a4D7F60D8B37196` for WPROS/USDC. The pool reported WPROS as base, USDC as quote, nonzero reserves, LP fee `0.24%`, and trader-specific maintainer fee `0.06%`.
- FaroSwap factory `0x18Fab7d7027E9FB33Fa90ca607439449209F7B09` returned pool `0x7F4A462FC320db1E26dd1366DcE9E276eE6c5930` for WPROS/USDC at `30` bps. The pool reported the expected token order, fee, and nonzero reserves.
- Bytecode was verified at the pinned block for both factories, both pools, the FaroSwap router, DODO Proxy02, DODOApprove, DODOApproveProxy, and both tokens. The DODO pool is an EIP-1167-style minimal proxy, hence its short 45-byte runtime code.
- The four-size bounded live search is in `bounded-live-search.json`; every result was an honest `SKIP`.

## Independence and execution limitation

The primary sources are different pricing protocols: DODO V2 PMM executable contract queries and FaroSwap V2 constant-product reserves. The discovered route is not operator-independent in the stronger sense that FaroSwap's production configuration exposes both integrations. The generated review plan is deliberately non-atomic: it contains one venue-specific transaction per leg and explicitly warns that leg one can settle while leg two fails. No executor contract was deployed and no transaction was broadcast.
