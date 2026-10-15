#!/usr/bin/env node
import { runScan } from "../src/scanner.js";

const amounts = ["0.0001", "0.001", "0.01", "0.05"];
const results = [];
for (const tradeAmount of amounts) {
  const scan = await runScan({
    mode: "live",
    config: { tradeAmount },
    scanId: `live-bounded-${tradeAmount.replace(".", "p")}-${Date.now()}`,
  });
  results.push({
    scanId: scan.scanId,
    createdAt: scan.createdAt,
    tradeAmount,
    blockNumber: scan.provenance.blockNumber ?? null,
    sourceProtocols: scan.sources.map((source) => source.protocol),
    sourceAddresses: scan.sources.map((source) => source.address),
    gasPriceWei: scan.config.gasPriceWei,
    gasPriceSource: scan.config.gasPriceSource,
    routes: scan.routes.map((route) => ({ route: route.route, afterFeeOutputRaw: route.afterFeeOutputRaw, netProfitRaw: route.netProfitRaw })),
    decision: scan.decision,
    reason: scan.reason,
  });
  console.error(`checked ${tradeAmount} USDC at block ${scan.provenance.blockNumber ?? "error"}: ${scan.decision}`);
}
console.log(JSON.stringify({ label: "BOUNDED LIVE CROSS-PROTOCOL SEARCH", generatedAt: new Date().toISOString(), amounts, results }, null, 2));
