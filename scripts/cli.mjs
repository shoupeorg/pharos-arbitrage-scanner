#!/usr/bin/env node
import { runScan } from "../src/scanner.js";

function args(argv) {
  const result = {};
  for (const item of argv) {
    if (!item.startsWith("--")) continue;
    const [key, ...parts] = item.slice(2).split("="); result[key] = parts.length ? parts.join("=") : true;
  }
  return result;
}
const input = args(process.argv.slice(2));
const mode = input.mode || "live";
const config = {};
for (const key of ["tradeAmount", "minimumProfit", "slippageBps", "gasUnits", "gasPriceGwei", "nativePriceQuote", "quoteTtlSeconds", "recipient"]) if (input[key] !== undefined) config[key] = String(input[key]);
for (const [flag, target] of [["trade", "tradeAmount"], ["threshold", "minimumProfit"], ["slippage", "slippageBps"], ["gas-units", "gasUnits"], ["gas-gwei", "gasPriceGwei"], ["native-price", "nativePriceQuote"]]) if (input[flag] !== undefined) config[target] = String(input[flag]);
if (input.recipient !== undefined) config.recipient = String(input.recipient);

try {
  const scan = await runScan({ mode, preset: input.preset, config });
  if (input.json) console.log(JSON.stringify(scan, null, 2));
  else {
    console.log(`${scan.provenance.mode}\nSCAN ${scan.scanId}\nDECISION ${scan.decision} — ${scan.reason}`);
    console.log(`PAIR ${scan.provenance.tokenPair || "SIM_BASE/SIM_QUOTE"} · BLOCK ${scan.provenance.blockNumber || "fixture"}`);
    for (const source of scan.sources) console.log(`SOURCE ${source.label} · ${source.address} · fee ${source.feeBps ?? "?"} bps · reserves ${source.reserveBaseRaw ?? "?"}/${source.reserveQuoteRaw ?? "?"}`);
    for (const route of scan.routes) console.log(`ROUTE ${route.route} · conservative ${route.display.conservativeOutput} · net ${route.display.netProfit} USDC · qualifies ${route.qualifies}`);
    if (scan.plan) console.log(`PLAN ${scan.plan.id} · ${scan.plan.label} · expires ${scan.plan.expiresAt}`);
  }
  process.exitCode = scan.decision === "PREPARE" || scan.decision === "SKIP" ? 0 : 1;
} catch (error) { console.error(`ERROR / NO PLAN — ${error.message}`); process.exitCode = 1; }
