# Pharos Arbitrage Scanner

A read-only Pharos Agent Arena submission that compares executable WPROS/USDC quotes from two different protocols—DODO V2 PMM and FaroSwap V2—through the official Pharos Chain MCP. It evaluates both route directions, persists every scan, and returns either an honest `SKIP` or a review-only unsigned `PREPARE` plan. It cannot sign or broadcast transactions.

Live demo: <https://pharos-arbitrage-scanner.shoupeorg.workers.dev/>

## Install and run

Node.js 20 or newer is required.

```bash
npm install
npm run scan -- --mode=live
npm run scan -- --mode=live --trade=0.001 --threshold=0.00001 --slippage=50 --gas-units=600000 --native-price=0.75
npm run scan:bounded
```

Live mode uses the MCP `get_gas_price` observation by default. A numeric `--gas-gwei=3` is an explicit override and is labeled as such in the result.

Deterministic demonstrations are deliberately separate from live evidence:

```bash
npm run scan -- --mode=simulation --preset=profitable
npm run scan -- --mode=simulation --preset=costsErase
npm run scan -- --mode=simulation --preset=belowThreshold
```

Add `--json` for the complete trace. The CLI, Skill helper, and Worker API all call the same `src/scanner.js` engine.

## Reusable Skill

The installable root Skill is [SKILL.md](./SKILL.md). Copy or clone the repository into a Codex Skill directory, install dependencies, and ask Codex to use `pharos-arbitrage-scanner`, or invoke the helper directly:

```bash
npm run skill -- --mode=live
```

The Skill instructs the agent to retain the live/fixture distinction, report both route directions and all modeled costs, and never add a direct-RPC or transaction-broadcast path.

## Verified real sources

All blockchain reads use Streamable HTTP at `https://mcp.pharos.xyz/mcp`. The server implementation is the official [Pharos MCP repository](https://github.com/PharosNetwork/pharos-mcp). Network checks require Pharos Pacific Mainnet chain ID `1672`.

| Field | DODO source | FaroSwap source |
| --- | --- | --- |
| Protocol | DODO V2 PMM (DVM) | FaroSwap V2 constant product |
| Pool | `0xac998dD78829aDe9f654e0BE7a4D7F60D8B37196` | `0x7F4A462FC320db1E26dd1366DcE9E276eE6c5930` |
| Factory | `0xB9319bCEe26F1A6AC7207A738B021cdEC771b30E` | `0x18Fab7d7027E9FB33Fa90ca607439449209F7B09` |
| Quote method | `querySellQuote` / `querySellBase` | fee-aware constant-product formula over `getReserves` |
| Fee model | pool LP fee plus trader-specific maintainer fee, both read at the pinned block | fixed `feeRate()`, verified as 30 bps |
| Execution destination | DODO Proxy02 `0x6F1142F4BF632E4877497c05818492824F540Ad5` | Router02 `0xd285E37678F07631f33EB99927EB3fF0591a12d7` |
| Approval spender | DODOApprove `0xBF105f4ffBD3825f5433d074008B9A76237d849c` | Router02 |

Tokens are WPROS `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0` (18 decimals) and USDC `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` (6 decimals). Both sources use WPROS as base and USDC as quote.

Deployment provenance comes from the live [FaroSwap application](https://faroswap.xyz/) and its chain-1672 production configuration, the official [FaroSwap interface](https://github.com/faroswap/interface) and [contracts](https://github.com/faroswap/contracts), and the official [DODO V2 contracts](https://github.com/DODOEX/contractV2). The exact verification snapshot and the stronger operator-independence caveat are documented in [evidence/protocol-verification.md](./evidence/protocol-verification.md).

Before using a quote, one pinned block is selected and the scanner verifies:

- chain ID, token bytecode/metadata/decimals, and nonzero liquidity;
- bytecode for both factories, pools, execution contracts, and approval contracts;
- DODO pool membership via `DVMFactory.getDODOPoolBidirection`, pool token order, reserves, mid price, and user fee rates;
- FaroSwap router → factory linkage, factory pool lookup, pool token order, reserves, and fee;
- DODO executable outputs for the precise route inputs using pinned `querySellQuote` and `querySellBase` calls.

The required MCP tools are `get_chain_info`, `get_block`, `get_code`, `get_gas_price`, and `eth_call`. There is no direct JSON-RPC fallback.

## Economics and decision rule

Both directions are evaluated: DODO → FaroSwap and FaroSwap → DODO. All token arithmetic is `BigInt`; decimal strings are parsed exactly, outputs round down, and costs round up.

For FaroSwap, executable output is:

```text
effectiveInput = amountIn × (10,000 − feeBps)
amountOut = floor(effectiveInput × reserveOut
                  / (reserveIn × 10,000 + effectiveInput))
```

For DODO, the scanner uses the pool's executable `querySellQuote`/`querySellBase` result. It reads `getMidPrice` and `getUserFeeRate`, reconstructs the pre-fee PMM output, and records the maintainer fee returned by the quote. This permits one consistent quote-denominated breakdown:

1. `idealNoFeeNoImpactOutput` from the two spot/mid prices;
2. `noFeePriceImpactOutput` from fee-free venue models;
3. `priceImpactCost = max(ideal − noFee, 0)`;
4. `feeCost = max(noFee − executableAfterFees, 0)`—fees are not subtracted again;
5. one final-output slippage allowance;
6. `gasUnits × gasPriceWei`, converted to USDC using the visible configured PROS/USDC assumption;
7. `netProfit = afterFees − slippageAllowance − input − gasCostQuote`.

The default gas price is the live MCP observation. `get_gas_price` is unpinned and recorded separately; every contract read and quote is pinned. Combined gas units and the native-token/USDC conversion remain explicit estimates, not a gas simulation or oracle.

`PREPARE` requires valid fresh sources and `netProfit > minimumProfit` (strict inequality). A profitable live observation is fully re-read at a new pinned block before plan creation. Plans have a short TTL and are marked expired when read after it.

## Unsigned plan and atomicity

A plan is venue-correct rather than reusing one router for both protocols. It contains:

- chain ID, deadline/expiry, required sender, input and minimum outputs;
- one DODO `dodoSwapV2TokenToToken` transaction with DODO pool direction and DODOApprove prerequisite;
- one FaroSwap `swapExactTokensForTokens` transaction with the correct path, fee, recipient, and Router02 approval;
- full destinations, zero values, calldata, decoded arguments, and allowance prerequisites.

The plan is **non-atomic**. Leg one can settle while leg two fails or becomes unprofitable. The output therefore requires a new read and leg-two rebuild from the actual leg-one output before signing. No executor contract is deployed. This app does not sign, send, or simulate a public-chain transaction.

The profitable deterministic fixture executes the same constant-product policy against two independent in-memory AMM states and records both state transitions. Its venue-shaped calldata is structurally reviewable, but its minimums come from fixture prices and **must not be broadcast**.

## Persistence and API

Cloudflare D1 stores every accepted live or simulation scan, including source errors. A request key makes retries idempotent, and the schema permits at most one plan per scan.

- `GET /api/config` — verified configuration and official sources
- `POST /api/scans` — run and persist a scan
- `GET /api/scans` — persistent history
- `GET /api/scans/:id` — full trace

Historical same-FaroSwap records from the previous version remain in D1 and keep their original mode labels. New records are labeled `LIVE CROSS-PROTOCOL QUOTES / SIMULATED EXECUTION`.

## Recorded evidence

The bounded live search on 2026-10-15 tested `0.0001`, `0.001`, `0.01`, and `0.05` USDC at blocks `20327534`, `20327584`, `20327634`, and `20327644`. Every scan used DODO and FaroSwap, observed gas price `10 gwei`, and correctly returned `SKIP`; no live profitability is claimed. See [evidence/bounded-live-search.json](./evidence/bounded-live-search.json).

Example actual live output:

```text
LIVE CROSS-PROTOCOL QUOTES / SIMULATED EXECUTION
BLOCK 20327364 · CHAIN 1672 · WPROS/USDC
DODO V2 PMM pool 0xac998d...7196 · spot 0.618849 USDC/WPROS
FaroSwap V2 pool 0x7F4A46...5930 · spot 0.599385 USDC/WPROS
FaroSwap → DODO · after fees 0.000102 USDC
slippage 0.000001 · observed-gas cost 0.0045 USDC
net -0.004499 USDC
DECISION SKIP — Fees, price impact, slippage allowance, and gas erase the gross spread.
```

Deterministic evidence is in [evidence/deterministic-scenarios.json](./evidence/deterministic-scenarios.json):

- profitable fixture: `PREPARE`, net `218.709894` USDC, two venue-specific unsigned transactions, and matching local AMM state execution;
- costs erase spread: `SKIP`, net `-33.333305` USDC;
- positive net below threshold: `SKIP`, net `218.709894` USDC against a `300` USDC threshold.

Legacy deployed evidence remains accessible and is explicitly same-protocol:

- [legacy live same-FaroSwap scan](https://pharos-arbitrage-scanner.shoupeorg.workers.dev/api/scans/live-1792080533321-ae4e6571)
- [legacy profitable fixture](https://pharos-arbitrage-scanner.shoupeorg.workers.dev/api/scans/simulation-1792080538334-5d63bc30)

## Test and deploy

```bash
npm test
npm run build
npm run deploy
```

Tests cover strict threshold behavior, both directions, exact decimal arithmetic, separated impact/fee costs, failure persistence, D1-style idempotency, live revalidation, observed-gas default versus explicit override, venue-specific calldata, non-atomic risk disclosure, and deterministic two-instance state transitions.

## Limitations

- The sources are protocol-distinct (DODO PMM versus FaroSwap V2), but both integrations are exposed by FaroSwap's production configuration; this is not a claim of independent operators or frontends.
- Liquidity is thin. The bounded real scans were all `SKIP`; the app never fabricates a live opportunity.
- DODO user fees can depend on the configured recipient/sender. Changing it changes the pinned quote.
- Gas units and PROS/USDC conversion are visible estimates. Only gas price is observed from MCP by default.
- The prepared route is two transactions and non-atomic. It is review evidence, not a safe execution service.
- Deterministic fixtures are local models, not live data, a fork, or public-chain execution.
- No signer, private key, wallet connection, contract deployment, approval, trade, or PHRS expenditure exists in this project.
