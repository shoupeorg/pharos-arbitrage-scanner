import { parseDecimal } from "./math.js";
import { DODO, FACTORY, BASE, QUOTE } from "./constants.js";

const pool = (id, label, base, quote, feeBps, venue) => ({
  id, label, protocol: venue.protocol, adapter: venue.adapter, address: venue.address,
  factory: venue.factory, token0: BASE.address, token1: QUOTE.address, feeBps,
  feeModel: { type: "deterministic-fixture", feeBps }, pricingModel: "local constant-product test instance",
  reserveBaseRaw: parseDecimal(base, 18).toString(), reserveQuoteRaw: parseDecimal(quote, 6).toString(),
  reserveTimestamp: 0, valid: true, simulated: true,
});
const DODO_FIXTURE = { protocol: "LOCAL AMM A · DODO-shaped adapter", adapter: "dodo-v2-pmm", address: DODO.pool, factory: DODO.factory };
const FARO_FIXTURE = { protocol: "LOCAL AMM B · FaroSwap-shaped adapter", adapter: "faroswap-v2", address: "0x8e3fDBEf5cD72D2dAE407dB1DC61bff44d1DBE9F", factory: FACTORY };
export const FIXTURES = {
  profitable: {
    label: "DETERMINISTIC POSITIVE / PREPARE",
    config: { tradeAmount: "1000", minimumProfit: "5", slippageBps: "25", gasUnits: "300000", gasPriceGwei: "1", nativePriceQuote: "1", quoteTtlSeconds: "60" },
    sources: [pool("fixture-pool-a", "LOCAL AMM A · FIXTURE", "1000", "100000", 30, DODO_FIXTURE), pool("fixture-pool-b", "LOCAL AMM B · FIXTURE", "1000", "125000", 1, FARO_FIXTURE)],
  },
  costsErase: {
    label: "DETERMINISTIC COST-ERASED / SKIP",
    config: { tradeAmount: "1000", minimumProfit: "0", slippageBps: "100", gasUnits: "300000", gasPriceGwei: "100", nativePriceQuote: "1000", quoteTtlSeconds: "60" },
    sources: [pool("fixture-pool-a", "LOCAL AMM A · FIXTURE", "1000", "100000", 30, DODO_FIXTURE), pool("fixture-pool-b", "LOCAL AMM B · FIXTURE", "1000", "103000", 1, FARO_FIXTURE)],
  },
  belowThreshold: {
    label: "DETERMINISTIC BELOW THRESHOLD / SKIP",
    config: { tradeAmount: "1000", minimumProfit: "300", slippageBps: "25", gasUnits: "300000", gasPriceGwei: "1", nativePriceQuote: "1", quoteTtlSeconds: "60" },
    sources: [pool("fixture-pool-a", "LOCAL AMM A · FIXTURE", "1000", "100000", 30, DODO_FIXTURE), pool("fixture-pool-b", "LOCAL AMM B · FIXTURE", "1000", "125000", 1, FARO_FIXTURE)],
  },
};
