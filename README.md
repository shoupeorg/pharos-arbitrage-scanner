# Pharos Arbitrage Scanner

A read-only Pharos Agent Arena submission that compares two real FaroSwap WPROS/USDC pools in one scan, models a complete quote → base → quote cycle, and records either `SKIP` or a review-only `SIMULATED EXECUTION PLAN`. It never signs or broadcasts a transaction.

## Live demo

<https://pharos-arbitrage-scanner.shoupeorg.workers.dev/>

## Install and run

Requires Node.js 20 or newer.

```bash
npm install
npm run scan -- --mode=live
```

Example policy overrides use decimal strings:

```bash
npm run scan -- --mode=live --trade=0.0001 --threshold=0.00001 --slippage=50 --gas-units=300000 --gas-gwei=10 --native-price=0.75 --recipient=0xf2039216c4320CFFC5FB1B704642f9a706b95eE2
```

Deterministic demonstrations:

```bash
npm run scan -- --mode=simulation --preset=profitable
npm run scan -- --mode=simulation --preset=costsErase
npm run scan -- --mode=simulation --preset=belowThreshold
```

Add `--json` for the complete machine-readable trace.

## Reusable Skill

The installable Skill is [SKILL.md](./SKILL.md). Install or copy this repository into a Codex Skill directory, then invoke it by asking Codex to use `pharos-arbitrage-scanner`, or run its helper directly:

```bash
npm run skill -- --mode=live
```

The helper and web API both call `src/scanner.js`; neither has a separate decision implementation.

## Verified live sources

All blockchain reads use the official Pharos Chain MCP over Streamable HTTP:

- Endpoint: `https://mcp.pharos.xyz/mcp`
- Network: Pharos Pacific Mainnet, chain ID `1672`
- MCP implementation: <https://github.com/PharosNetwork/pharos-mcp>
- FaroSwap interface: <https://github.com/faroswap/interface>
- FaroSwap contracts: <https://github.com/faroswap/contracts>
- Live project: <https://faroswap.xyz/>

The scanner verifies bytecode, router → factory linkage, pool factory membership, token order, decimals, pool fees, and reserves at one explicit block before using a quote:

| Item | Address / value |
| --- | --- |
| FaroSwap V2 factory | `0x18Fab7d7027E9FB33Fa90ca607439449209F7B09` |
| FaroSwap Router02 | `0xd285E37678F07631f33EB99927EB3fF0591a12d7` |
| Base | WPROS, `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0`, 18 decimals |
| Quote | USDC, `0xC879C018dB60520F4355C26eD1a6D572cdAC1815`, 6 decimals |
| Source A | `0x7F4A462FC320db1E26dd1366DcE9E276eE6c5930`, 30 bps |
| Source B | `0x8e3fDBEf5cD72D2dAE407dB1DC61bff44d1DBE9F`, 1 bp |

The Router02 address is present in the current official `faroswap.xyz` production bundle. The verified FaroSwap contract source defines `swapExactTokensForTokens(amountIn, amountOutMin, path, fees, to, deadline)`, which supports the atomic three-token/two-fee-tier cycle used by the unsigned plan.

These are two independently addressable pools with different fee tiers returned by the verified factory for the same ordered asset pair. They are both FaroSwap pools, not two independent DEX protocols. Source B has very low liquidity; the executable-size calculation therefore differs materially from its spot price. This limitation is deliberately visible rather than hidden behind fabricated quotes.

The live reader lists and validates these required MCP tools: `get_chain_info`, `get_block`, `get_code`, `get_gas_price`, and `eth_call`. Contract calls are batched through Multicall3 but still executed by MCP `eth_call`. There is no JSON-RPC fallback.

## Economic model

For each pool, constant-product executable output is calculated with integers:

```text
effectiveInput = amountIn × (10,000 − feeBps)
amountOut = floor(effectiveInput × reserveOut
                  / (reserveIn × 10,000 + effectiveInput))
```

For each A→B and B→A cycle the scanner computes, in order:

1. Ideal no-fee/no-price-impact output from reserve ratios.
2. No-fee constant-product output; the difference from (1) is price-impact cost.
3. Fee-inclusive constant-product output; the difference from (2) is fee cost. Fees are not subtracted again.
4. A configurable slippage safety allowance, rounded up, subtracted from output.
5. `gasUnits × gasPriceWei`, converted to USDC with the configured PROS/USDC assumption and rounded up.
6. `netProfit = conservativeOutput − input − gasCostQuote`.

`PREPARE` is allowed only when `netProfit > minimumProfit` (strict inequality), both sources validate, the selected fee tiers resolve to the two verified pools, and the quote is unexpired. A profitable live observation is fetched again at a new pinned block immediately before a plan is created.

The plan contains an ABI-valid **unsigned** Router02 transaction object:

- destination `0xd285E37678F07631f33EB99927EB3fF0591a12d7`;
- chain ID `1672`, zero native value, and complete calldata;
- atomic path `USDC → WPROS → USDC` with the selected `[buyFee, sellFee]` tiers;
- input, final `amountOutMin`, configurable recipient, deadline/expiry, and both source pool addresses;
- an intermediate minimum shown as a review constraint. Router02 enforces the final cycle minimum atomically, not that intermediate review constraint separately;
- approval prerequisite for USDC and its inclusion in the configured aggregate gas-unit budget.

A fixture `PREPARE` plan uses deterministic reserves rather than live liquidity. Its calldata is ABI-valid and maps the 30-bps/1-bp tiers to the verified contracts, but its fixture-derived minimum is **not a current executable quote and must not be broadcast**. No private key, signing, or send endpoint exists.

Gas price and native-token price are configurable model inputs. The actual current `get_gas_price` observation is recorded separately; `get_gas_price` itself is the only unpinned observation. `approvalIncluded: true` documents that the configured aggregate gas budget is intended to include approval when needed.

All token arithmetic uses `BigInt` after strict decimal-string parsing. Outputs round down; costs round up. JavaScript floating point is not used for token values.

## Persistence and API

Cloudflare D1 stores every accepted live or simulation scan, including source failures. A unique request key makes retries idempotent, `scan_id` is unique, and the schema permits at most one plan per scan. Expired plans are marked `expired` when read.

- `GET /api/config` — verified configuration and official source links
- `POST /api/scans` — run and persist a scan
- `GET /api/scans` — persistent history
- `GET /api/scans/:id` — full trace

## Recorded application output

These outputs were generated by the actual shared scanner on 2026-10-15. Fixture results are intentionally labeled simulation; they are not market claims. The compact capture manifest is in [`evidence/recorded-scans.json`](./evidence/recorded-scans.json).

Deployed D1 evidence:

- [real two-source live scan — SKIP](https://pharos-arbitrage-scanner.shoupeorg.workers.dev/api/scans/live-1792080533321-ae4e6571)
- [deterministic profitable fixture — PREPARE](https://pharos-arbitrage-scanner.shoupeorg.workers.dev/api/scans/simulation-1792080538334-5d63bc30)
- [deterministic costs-erase-spread fixture — SKIP](https://pharos-arbitrage-scanner.shoupeorg.workers.dev/api/scans/simulation-1792080538617-ffa5ecbd)
- [deterministic positive-net-below-threshold fixture — SKIP](https://pharos-arbitrage-scanner.shoupeorg.workers.dev/api/scans/simulation-1792080538881-f6882634)

### Real mainnet scan — SKIP

```text
LIVE QUOTES / SIMULATED EXECUTION
SCAN live-1792079914011-270812e8
BLOCK 20319675 · CHAIN 1672 · WPROS/USDC
SOURCE A reserves 470812474748355115 / 282198 · fee 30 bps
SOURCE B reserves 1577018305457365 / 1611 · fee 1 bp
A → B: gross spot spread 70.4326%; after fees 0.000153 USDC;
       price impact 0.000016, fees 0.000001, slippage 0.000001,
       gas 0.00225, conservative output 0.000152,
       net -0.002198 USDC
DECISION SKIP — Fees, price impact, slippage allowance, and gas erase the gross spread.
```

### Deterministic profitable fixture — PREPARE

```text
SIMULATED PRICES / SIMULATED EXECUTION
SCAN (local recorded fixture; deployed ID listed after verification)
fixture-pool-a → fixture-pool-b
conservative output 1218.710194 USDC
net 218.709894 USDC · threshold 5 USDC
DECISION PREPARE
PLAN SIMULATED EXECUTION PLAN · UNSIGNED TRANSACTION
DESTINATION 0xd285E37678F07631f33EB99927EB3fF0591a12d7 · CHAIN 1672
PATH USDC → WPROS → USDC · FEES 30 bps → 1 bp · complete calldata recorded
```

### Deterministic positive spread erased by costs — SKIP

```text
SCAN (local recorded fixture; deployed ID listed after verification)
best conservative output 996.666695 USDC
gas model 30 USDC · net -33.333305 USDC
DECISION SKIP — Fees, price impact, slippage allowance, and gas erase the gross spread.
```

### Deterministic positive net below threshold — SKIP

```text
SCAN (local recorded fixture; deployed ID listed after verification)
best conservative output 1218.710194 USDC
net 218.709894 USDC · threshold 300 USDC
DECISION SKIP — Net profit does not strictly exceed the configured threshold.
```

## Test and deploy

```bash
npm run check
npm run build
npm run deploy
```

Tests cover profitable preparation/idempotency, costs erasing a spread, strict threshold equality, both route directions, decimal precision and conservative rounding, separated fee/impact attribution, invalid/stale/missing sources, persistence of source-error records, shared CLI/web calculation, and live quote revalidation.

## Limitations

- Both real sources are distinct fee-tier pools in the same FaroSwap protocol. This proves independent contracts and quote states, not cross-protocol venue diversity.
- Source B is currently thin. A large input may produce extreme impact or insufficiently useful output; the scanner does not manufacture a profitable opportunity.
- The native PROS/USDC conversion and aggregate gas units are explicit user assumptions, not an oracle feed or an on-chain gas estimate for a prepared transaction.
- A reserve timestamp is the last pool update, not the freshness of the pinned chain read. Quote expiry is measured from scan creation; a plan is revalidated before creation and then has a short TTL.
- Simulated plans are informational only. There is an unsigned ABI encoder, but no signer, private key, wallet connection, or execution endpoint.

## Short submission video

1. Open the deployed app and show the `LIVE QUOTES / SIMULATED EXECUTION` badge, MCP endpoint, chain ID, both pool addresses, fees, and configuration.
2. Click `RUN SCAN`; show the pinned block, both source cards, both route evaluations, separate fee/impact/slippage/gas lines, and the honest live `SKIP` reason.
3. Click `FIXTURE: PREPARE`, then `RUN SCAN →`; show the `SIMULATED PRICES / SIMULATED EXECUTION` badge and the structured `SIMULATED EXECUTION PLAN · UNSIGNED TRANSACTION`, including destination, calldata, chain ID and expiry.
4. Run `FIXTURE: COST SKIP` and `FIXTURE: THRESHOLD SKIP`; show their distinct reasons.
5. Refresh the page, open each recorded scan from `PERSISTENT SCAN HISTORY`, and show that the records survive refresh.
6. In the repository, open root `SKILL.md`, `src/pharos-mcp.js`, `src/math.js`, and the passing test output. Emphasize that no trade was signed or broadcast.
