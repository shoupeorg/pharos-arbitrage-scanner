---
name: pharos-arbitrage-scanner
description: Scan two verified FaroSwap WPROS/USDC pools on Pharos mainnet through the official Chain MCP, calculate a conservative two-leg arbitrage result, and prepare an unsigned simulated transaction plan only when net profit strictly exceeds a threshold. Use for live read-only arbitrage checks, deterministic economics demonstrations, or review of Pharos AMM quote provenance.
---

# Pharos Arbitrage Scanner

Use the project scanner instead of reproducing its arithmetic. It is read-only and must never sign or broadcast a transaction.

1. Install dependencies with `npm install` in the project root.
2. For a real scan, run `npm run skill -- --mode=live`.
3. To configure the policy, append decimal-string arguments such as `--trade=0.0001 --threshold=0.00001 --slippage=50 --gas-units=300000 --gas-gwei=10 --native-price=0.75`, plus `--recipient=0x...` for the unsigned calldata recipient.
4. For a deterministic demonstration, use exactly one of `--mode=simulation --preset=profitable`, `--mode=simulation --preset=costsErase`, or `--mode=simulation --preset=belowThreshold`.
5. Report the mode label, both source addresses, pinned block (live mode), both route evaluations, cost breakdown, decision, and reason. Never describe fixture inputs as live prices.

The live reader must remain the official Streamable HTTP MCP endpoint `https://mcp.pharos.xyz/mcp`. Do not add a direct-RPC fallback. A `PREPARE` result records ABI-valid, unsigned FaroSwap Router02 calldata with destination, chain ID, path, fee tiers, amount, final minimum, recipient, and deadline. Fixture-based plans are not live quotes and must never be broadcast. No result is an executed or signed trade.

See `README.md` for source provenance, formulas, limitations, and output interpretation.
