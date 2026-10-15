---
name: pharos-arbitrage-scanner
description: Run a read-only cross-protocol WPROS/USDC arbitrage scan on Pharos mainnet using DODO V2 PMM and FaroSwap V2 through the official Chain MCP, or run clearly labeled deterministic policy demonstrations. Use when a user asks to compare these venues, audit arbitrage economics, or prepare a review-only unsigned plan.
---

# Pharos Arbitrage Scanner

Use the project scanner rather than reproducing its arithmetic. Never sign, broadcast, deploy a contract, request a private key, or add a direct-RPC fallback.

1. In the project root, run `npm install` if dependencies are absent.
2. For a genuine cross-protocol scan, run `npm run skill -- --mode=live`.
3. Optional policy flags use exact decimal strings: `--trade=0.001 --threshold=0.00001 --slippage=50 --gas-units=600000 --native-price=0.75`. Omit `--gas-gwei` to use the observed MCP gas price; if a numeric override is supplied, identify it as an override.
4. For tests only, use one of `--mode=simulation --preset=profitable`, `--mode=simulation --preset=costsErase`, or `--mode=simulation --preset=belowThreshold`.
5. Report the mode label, both protocol names and pool addresses, pinned block for live mode, fee/pricing models, both directions, spread, impact, fees, slippage, gas, net result, threshold, decision, and reason.
6. For `PREPARE`, report both venue-specific transactions, approvals, chain ID, expiry, and the prominent non-atomic risk. Never describe a plan as signed, executed, atomic, or safe to broadcast without a fresh revalidation.
7. Never describe fixture values or local AMM state transitions as live chain evidence.

The live reader must remain the official Streamable HTTP endpoint `https://mcp.pharos.xyz/mcp`. DODO quotes use pinned `querySellQuote`/`querySellBase`; FaroSwap quotes use pinned reserves and verified `feeRate`. The shared engine is `src/scanner.js`; the CLI, Skill helper, and deployed API must not fork the decision logic.

See `README.md` and `evidence/` for deployment provenance, formulas, bounded live scans, deterministic demonstrations, and limitations.
