import { encodeFunctionData, getAddress, isAddress } from "viem";
import { CHAIN_ID, ROUTER, BASE, QUOTE, DEFAULT_RECIPIENT, LIVE_SOURCES } from "./constants.js";

const TEN = 10n;
export const BPS = 10_000n;
const routerAbi = [{
  type: "function", name: "swapExactTokensForTokens", stateMutability: "nonpayable",
  inputs: [
    { name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" },
    { name: "path", type: "address[]" }, { name: "fees", type: "uint256[]" },
    { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
  ], outputs: [{ name: "amounts", type: "uint256[]" }],
}];

export function pow10(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Unsupported token decimals");
  return TEN ** BigInt(decimals);
}

export function parseDecimal(value, decimals, label = "value", { positive = false, allowZero = true } = {}) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`${label} must be a plain non-negative decimal string`);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`${label} supports at most ${decimals} decimal places`);
  const raw = BigInt(whole) * pow10(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (positive && raw <= 0n) throw new Error(`${label} must be greater than zero`);
  if (!allowZero && raw === 0n) throw new Error(`${label} must not be zero`);
  return raw;
}

export function parseInteger(value, label, min, max) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = BigInt(text);
  if (parsed < BigInt(min) || parsed > BigInt(max)) throw new Error(`${label} must be between ${min} and ${max}`);
  return parsed;
}

export function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new Error("Division denominator must be positive");
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

export function formatUnits(raw, decimals, maxFraction = decimals) {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const base = pow10(decimals);
  const whole = value / base;
  let fraction = (value % base).toString().padStart(decimals, "0");
  fraction = fraction.slice(0, Math.max(0, maxFraction)).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function ammOut(amountIn, reserveIn, reserveOut, feeBps) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) throw new Error("Insufficient liquidity or nonpositive amount");
  if (feeBps < 0n || feeBps >= BPS) throw new Error("Pool fee must be below 10,000 bps");
  const effective = amountIn * (BPS - feeBps);
  return (effective * reserveOut) / (reserveIn * BPS + effective);
}

function maxZero(value) { return value > 0n ? value : 0n; }
function signedPercentBps(numerator, denominator) { return denominator === 0n ? 0n : numerator * 1_000_000n / denominator; }

export function normalizeConfig(input = {}, quoteDecimals = 6) {
  const tradeAmountRaw = parseDecimal(input.tradeAmount, quoteDecimals, "Trade amount", { positive: true });
  const minimumProfitRaw = parseDecimal(input.minimumProfit, quoteDecimals, "Minimum profit");
  const slippageBps = parseInteger(input.slippageBps, "Slippage bps", 0, 5_000);
  const gasUnits = parseInteger(input.gasUnits, "Gas units", 21_000, 5_000_000);
  const gasPriceWei = parseDecimal(input.gasPriceGwei, 9, "Gas price", { positive: true });
  const nativePriceQuoteRaw = parseDecimal(input.nativePriceQuote, quoteDecimals, "Native-token quote price", { positive: true });
  const quoteTtlSeconds = parseInteger(input.quoteTtlSeconds ?? "60", "Quote TTL", 5, 600);
  const recipientInput = String(input.recipient || DEFAULT_RECIPIENT).trim();
  if (!isAddress(recipientInput, { strict: false }) || /^0x0{40}$/i.test(recipientInput)) throw new Error("Recipient must be a nonzero EVM address");
  const recipient = getAddress(recipientInput);
  return { ...input, recipient, tradeAmountRaw, minimumProfitRaw, slippageBps, gasUnits, gasPriceWei, nativePriceQuoteRaw, quoteTtlSeconds };
}

export function evaluateRoute({ buy, sell, config, baseDecimals = 18, quoteDecimals = 6 }) {
  const input = config.tradeAmountRaw;
  const buyBase = BigInt(buy.reserveBaseRaw), buyQuote = BigInt(buy.reserveQuoteRaw), sellBase = BigInt(sell.reserveBaseRaw), sellQuote = BigInt(sell.reserveQuoteRaw);
  const buyPriceRaw = buyQuote * pow10(baseDecimals) / buyBase;
  const sellPriceRaw = sellQuote * pow10(baseDecimals) / sellBase;
  const idealBase = input * buyBase / buyQuote;
  const idealOutput = idealBase * sellQuote / sellBase;
  const noFeeBase = ammOut(input, buyQuote, buyBase, 0n);
  const noFeeImpactOutput = ammOut(noFeeBase, sellBase, sellQuote, 0n);
  const feeBase = ammOut(input, buyQuote, buyBase, BigInt(buy.feeBps));
  const afterFeeOutput = ammOut(feeBase, sellBase, sellQuote, BigInt(sell.feeBps));
  const priceImpactCost = maxZero(idealOutput - noFeeImpactOutput);
  const feeCost = maxZero(noFeeImpactOutput - afterFeeOutput);
  const slippageCost = ceilDiv(afterFeeOutput * config.slippageBps, BPS);
  const conservativeOutput = maxZero(afterFeeOutput - slippageCost);
  const gasWei = config.gasUnits * config.gasPriceWei;
  const gasCostQuote = ceilDiv(gasWei * config.nativePriceQuoteRaw, pow10(18));
  const netProfit = conservativeOutput - input - gasCostQuote;
  const grossSpread = sellPriceRaw - buyPriceRaw;
  const spreadPpm = signedPercentBps(grossSpread, buyPriceRaw);
  const netPpm = signedPercentBps(netProfit, input);
  return {
    route: `${buy.id} → ${sell.id}`, buySource: buy.id, sellSource: sell.id,
    inputRaw: input.toString(), buyPriceRaw: buyPriceRaw.toString(), sellPriceRaw: sellPriceRaw.toString(),
    grossSpotSpreadRaw: grossSpread.toString(), grossSpotSpreadPpm: spreadPpm.toString(),
    idealIntermediateRaw: idealBase.toString(), idealNoFeeNoImpactOutputRaw: idealOutput.toString(),
    noFeePriceImpactOutputRaw: noFeeImpactOutput.toString(), expectedIntermediateRaw: feeBase.toString(),
    afterFeeOutputRaw: afterFeeOutput.toString(), priceImpactCostRaw: priceImpactCost.toString(), feeCostRaw: feeCost.toString(),
    slippageAllowanceRaw: slippageCost.toString(), gasCostQuoteRaw: gasCostQuote.toString(), conservativeOutputRaw: conservativeOutput.toString(),
    netProfitRaw: netProfit.toString(), netProfitPpm: netPpm.toString(), qualifies: netProfit > config.minimumProfitRaw,
    display: {
      input: formatUnits(input, quoteDecimals), buyPrice: formatUnits(buyPriceRaw, quoteDecimals), sellPrice: formatUnits(sellPriceRaw, quoteDecimals),
      grossSpotSpread: formatUnits(grossSpread, quoteDecimals), grossSpotSpreadPercent: formatUnits(spreadPpm, 4),
      idealOutput: formatUnits(idealOutput, quoteDecimals), noFeePriceImpactOutput: formatUnits(noFeeImpactOutput, quoteDecimals),
      expectedIntermediate: formatUnits(feeBase, baseDecimals), afterFeeOutput: formatUnits(afterFeeOutput, quoteDecimals),
      priceImpactCost: formatUnits(priceImpactCost, quoteDecimals), feeCost: formatUnits(feeCost, quoteDecimals),
      slippageAllowance: formatUnits(slippageCost, quoteDecimals), gasCostQuote: formatUnits(gasCostQuote, quoteDecimals),
      conservativeOutput: formatUnits(conservativeOutput, quoteDecimals), netProfit: formatUnits(netProfit, quoteDecimals), netProfitPercent: formatUnits(netPpm, 4),
    },
  };
}

export function evaluateScan({ sources, config, provenance, scanId, now = new Date() }) {
  if (!Array.isArray(sources) || sources.length !== 2) throw new Error("Exactly two sources are required");
  if (sources.some((source) => !source.valid || source.stale)) {
    const failed = sources.filter((source) => !source.valid || source.stale).map((source) => `${source.label}: ${source.error || (source.stale ? "stale quote" : "invalid source")}`);
    return { scanId, createdAt: now.toISOString(), mode: provenance.mode, provenance, config: serializeConfig(config), sources: serializeSources(sources), routes: [], decision: "SKIP", reason: `Source unavailable or invalid — ${failed.join("; ")}`, plan: null };
  }
  const routes = [evaluateRoute({ buy: sources[0], sell: sources[1], config }), evaluateRoute({ buy: sources[1], sell: sources[0], config })];
  const best = routes.reduce((left, right) => BigInt(right.netProfitRaw) > BigInt(left.netProfitRaw) ? right : left);
  let decision = "SKIP";
  let reason;
  if (BigInt(best.netProfitRaw) <= 0n) reason = "Fees, price impact, slippage allowance, and gas erase the gross spread.";
  else if (BigInt(best.netProfitRaw) <= config.minimumProfitRaw) reason = "Net profit does not strictly exceed the configured threshold.";
  else { decision = "PREPARE"; reason = "Conservative net profit strictly exceeds the configured threshold."; }
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + Number(config.quoteTtlSeconds) * 1000).toISOString();
  const deadline = BigInt(Math.floor(Date.parse(expiresAt) / 1000));
  const buy = sources.find((source) => source.id === best.buySource);
  const sell = sources.find((source) => source.id === best.sellSource);
  const minimumLeg1OutputRaw = (BigInt(best.expectedIntermediateRaw) - ceilDiv(BigInt(best.expectedIntermediateRaw) * config.slippageBps, BPS)).toString();
  const fees = [BigInt(buy.feeBps), BigInt(sell.feeBps)];
  const venueAddresses = fees.map((fee) => LIVE_SOURCES.find((source) => BigInt(source.expectedFeeBps) === fee)?.address || null);
  if (decision === "PREPARE" && venueAddresses.some((address) => !address)) {
    return { scanId, createdAt, mode: provenance.mode, provenance, config: serializeConfig(config), sources: serializeSources(sources), routes, bestRoute: best.route, decision: "SKIP", reason: "No verified FaroSwap transaction path exists for the selected fee tiers.", plan: null };
  }
  const path = [QUOTE.address, BASE.address, QUOTE.address];
  const calldata = decision === "PREPARE" ? encodeFunctionData({
    abi: routerAbi,
    functionName: "swapExactTokensForTokens",
    args: [BigInt(best.inputRaw), BigInt(best.conservativeOutputRaw), path, fees, config.recipient, deadline],
  }) : null;
  const plan = decision === "PREPARE" ? {
    id: `plan-${scanId}`, label: "SIMULATED EXECUTION PLAN · UNSIGNED TRANSACTION", scanId, route: best.route, inputAmountRaw: best.inputRaw,
    expectedIntermediateRaw: best.expectedIntermediateRaw, expectedOutputRaw: best.afterFeeOutputRaw,
    minimumLeg1OutputRaw,
    minimumLeg2OutputRaw: best.conservativeOutputRaw, modeledCosts: { priceImpactRaw: best.priceImpactCostRaw, feesRaw: best.feeCostRaw, slippageRaw: best.slippageAllowanceRaw, gasQuoteRaw: best.gasCostQuoteRaw },
    thresholdRaw: config.minimumProfitRaw.toString(), provenance, createdAt, expiresAt,
    transaction: {
      chainId: CHAIN_ID, destination: ROUTER, to: ROUTER, value: "0", calldata,
      functionName: "swapExactTokensForTokens",
      venueAddresses,
      args: { amountIn: best.inputRaw, amountOutMin: best.conservativeOutputRaw, path, fees: fees.map(String), recipient: config.recipient, deadline: deadline.toString() },
      approval: { token: QUOTE.address, spender: ROUTER, minimumAllowanceRaw: best.inputRaw, includedInConfiguredGasBudget: true },
      intermediateMinimum: { amountRaw: minimumLeg1OutputRaw, token: BASE.address, enforcedByRouter: false, note: "Review constraint; the router enforces only the final amountOutMin across the atomic two-leg path." },
    },
    execution: provenance.mode.startsWith("SIMULATED PRICES")
      ? "UNSIGNED FIXTURE-BASED TRANSACTION PLAN — ABI-valid calldata only; fixture minimums are not live quotes and MUST NOT be broadcast"
      : "UNSIGNED LIVE-QUOTE TRANSACTION PLAN — never signed or broadcast; execution would still require balance and allowance checks before expiry",
  } : null;
  return { scanId, createdAt, mode: provenance.mode, provenance, config: serializeConfig(config), sources: serializeSources(sources), routes, bestRoute: best.route, decision, reason, plan };
}

function serializeSources(sources) {
  return sources.map((source) => ({ ...source, ...(source.reserveBaseRaw !== undefined ? { reserveBaseRaw: source.reserveBaseRaw.toString() } : {}), ...(source.reserveQuoteRaw !== undefined ? { reserveQuoteRaw: source.reserveQuoteRaw.toString() } : {}) }));
}

function serializeConfig(config) {
  return { tradeAmount: config.tradeAmount, tradeAmountRaw: config.tradeAmountRaw.toString(), minimumProfit: config.minimumProfit, minimumProfitRaw: config.minimumProfitRaw.toString(), slippageBps: config.slippageBps.toString(), gasUnits: config.gasUnits.toString(), gasPriceGwei: config.gasPriceGwei, gasPriceWei: config.gasPriceWei.toString(), nativePriceQuote: config.nativePriceQuote, nativePriceQuoteRaw: config.nativePriceQuoteRaw.toString(), quoteTtlSeconds: config.quoteTtlSeconds.toString(), recipient: config.recipient, approvalIncluded: true };
}
