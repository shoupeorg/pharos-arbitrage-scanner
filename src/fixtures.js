import { parseDecimal } from "./math.js";

const pool = (id, label, base, quote, feeBps) => ({ id, label, address: `fixture://${id}`, factory: "fixture://constant-product", token0: "SIM_BASE", token1: "SIM_QUOTE", feeBps, reserveBaseRaw: parseDecimal(base, 18).toString(), reserveQuoteRaw: parseDecimal(quote, 6).toString(), reserveTimestamp: 0, valid: true, simulated: true });
export const FIXTURES = {
  profitable: {
    label: "DETERMINISTIC POSITIVE / PREPARE",
    config: { tradeAmount: "1000", minimumProfit: "5", slippageBps: "25", gasUnits: "300000", gasPriceGwei: "1", nativePriceQuote: "1", quoteTtlSeconds: "60" },
    sources: [pool("fixture-pool-a", "Fixture Pool A", "1000", "100000", 30), pool("fixture-pool-b", "Fixture Pool B", "1000", "125000", 1)],
  },
  costsErase: {
    label: "DETERMINISTIC COST-ERASED / SKIP",
    config: { tradeAmount: "1000", minimumProfit: "0", slippageBps: "100", gasUnits: "300000", gasPriceGwei: "100", nativePriceQuote: "1000", quoteTtlSeconds: "60" },
    sources: [pool("fixture-pool-a", "Fixture Pool A", "1000", "100000", 30), pool("fixture-pool-b", "Fixture Pool B", "1000", "103000", 1)],
  },
  belowThreshold: {
    label: "DETERMINISTIC BELOW THRESHOLD / SKIP",
    config: { tradeAmount: "1000", minimumProfit: "300", slippageBps: "25", gasUnits: "300000", gasPriceGwei: "1", nativePriceQuote: "1", quoteTtlSeconds: "60" },
    sources: [pool("fixture-pool-a", "Fixture Pool A", "1000", "100000", 30), pool("fixture-pool-b", "Fixture Pool B", "1000", "125000", 1)],
  },
};
