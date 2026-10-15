import { encodeFunctionData, getAddress, isAddress } from "viem";
import { CHAIN_ID, ROUTER, DODO, BASE, QUOTE, DEFAULT_RECIPIENT } from "./constants.js";

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
const dodoProxyAbi = [{
  type: "function", name: "dodoSwapV2TokenToToken", stateMutability: "nonpayable",
  inputs: [
    { name: "fromToken", type: "address" }, { name: "toToken", type: "address" },
    { name: "fromTokenAmount", type: "uint256" }, { name: "minReturnAmount", type: "uint256" },
    { name: "dodoPairs", type: "address[]" }, { name: "directions", type: "uint256" },
    { name: "isIncentive", type: "bool" }, { name: "deadLine", type: "uint256" },
  ], outputs: [{ name: "returnAmount", type: "uint256" }],
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

export function normalizeConfig(input = {}, quoteDecimals = 6, { observedGasPriceWei } = {}) {
  const tradeAmountRaw = parseDecimal(input.tradeAmount, quoteDecimals, "Trade amount", { positive: true });
  const minimumProfitRaw = parseDecimal(input.minimumProfit, quoteDecimals, "Minimum profit");
  const slippageBps = parseInteger(input.slippageBps, "Slippage bps", 0, 5_000);
  const gasUnits = parseInteger(input.gasUnits, "Gas units", 21_000, 5_000_000);
  const gasInput = String(input.gasPriceGwei ?? "observed").trim().toLowerCase();
  const useObservedGas = gasInput === "observed" || gasInput === "";
  if (useObservedGas && (typeof observedGasPriceWei !== "bigint" || observedGasPriceWei <= 0n)) throw new Error("Observed MCP gas price is unavailable");
  const gasPriceWei = useObservedGas ? observedGasPriceWei : parseDecimal(gasInput, 9, "Gas price", { positive: true });
  const nativePriceQuoteRaw = parseDecimal(input.nativePriceQuote, quoteDecimals, "Native-token quote price", { positive: true });
  const quoteTtlSeconds = parseInteger(input.quoteTtlSeconds ?? "60", "Quote TTL", 5, 600);
  const recipientInput = String(input.recipient || DEFAULT_RECIPIENT).trim();
  if (!isAddress(recipientInput, { strict: false }) || /^0x0{40}$/i.test(recipientInput)) throw new Error("Recipient must be a nonzero EVM address");
  const recipient = getAddress(recipientInput);
  return {
    ...input, gasPriceGwei: useObservedGas ? "observed" : String(input.gasPriceGwei), recipient,
    tradeAmountRaw, minimumProfitRaw, slippageBps, gasUnits, gasPriceWei,
    gasPriceSource: useObservedGas ? "MCP get_gas_price observation" : "EXPLICIT USER OVERRIDE",
    observedGasPriceWei: typeof observedGasPriceWei === "bigint" ? observedGasPriceWei : null,
    nativePriceQuoteRaw, quoteTtlSeconds,
  };
}

function finalizeRoute({ buySource, sellSource, input, buyPriceRaw, sellPriceRaw, idealBase, idealOutput, noFeeBase, noFeeImpactOutput, feeBase, afterFeeOutput, quoteEvidence }, config, baseDecimals = 18, quoteDecimals = 6) {
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
    route: `${buySource} → ${sellSource}`, buySource, sellSource,
    inputRaw: input.toString(), buyPriceRaw: buyPriceRaw.toString(), sellPriceRaw: sellPriceRaw.toString(),
    grossSpotSpreadRaw: grossSpread.toString(), grossSpotSpreadPpm: spreadPpm.toString(),
    idealIntermediateRaw: idealBase.toString(), idealNoFeeNoImpactOutputRaw: idealOutput.toString(),
    noFeePriceImpactOutputRaw: noFeeImpactOutput.toString(), expectedIntermediateRaw: feeBase.toString(),
    afterFeeOutputRaw: afterFeeOutput.toString(), priceImpactCostRaw: priceImpactCost.toString(), feeCostRaw: feeCost.toString(),
    slippageAllowanceRaw: slippageCost.toString(), gasCostQuoteRaw: gasCostQuote.toString(), conservativeOutputRaw: conservativeOutput.toString(),
    netProfitRaw: netProfit.toString(), netProfitPpm: netPpm.toString(), qualifies: netProfit > config.minimumProfitRaw,
    ...(quoteEvidence ? { quoteEvidence } : {}),
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
  return finalizeRoute({ buySource: buy.id, sellSource: sell.id, input, buyPriceRaw, sellPriceRaw, idealBase, idealOutput, noFeeBase, noFeeImpactOutput, feeBase, afterFeeOutput }, config, baseDecimals, quoteDecimals);
}

export function evaluateQuotedRoute(observation, config, baseDecimals = 18, quoteDecimals = 6) {
  const raw = (key) => BigInt(observation[key]);
  if (raw("inputRaw") !== config.tradeAmountRaw) throw new Error("Pinned route quote input does not match configured trade amount");
  return finalizeRoute({
    buySource: observation.buySource,
    sellSource: observation.sellSource,
    input: raw("inputRaw"),
    buyPriceRaw: raw("buyPriceRaw"),
    sellPriceRaw: raw("sellPriceRaw"),
    idealBase: raw("idealIntermediateRaw"),
    idealOutput: raw("idealOutputRaw"),
    noFeeBase: raw("noFeeIntermediateRaw"),
    noFeeImpactOutput: raw("noFeeOutputRaw"),
    feeBase: raw("expectedIntermediateRaw"),
    afterFeeOutput: raw("afterFeeOutputRaw"),
    quoteEvidence: observation.quoteEvidence,
  }, config, baseDecimals, quoteDecimals);
}

function buildSwapTransaction(source, { tokenIn, tokenOut, amountIn, amountOutMin, recipient, deadline }) {
  if (source.adapter === "faroswap-v2") {
    const fee = BigInt(source.feeBps);
    const calldata = encodeFunctionData({
      abi: routerAbi, functionName: "swapExactTokensForTokens",
      args: [amountIn, amountOutMin, [tokenIn, tokenOut], [fee], recipient, deadline],
    });
    return {
      protocol: source.protocol, sourceId: source.id, destination: ROUTER, to: ROUTER, value: "0", calldata,
      functionName: "swapExactTokensForTokens",
      args: { amountIn: amountIn.toString(), amountOutMin: amountOutMin.toString(), path: [tokenIn, tokenOut], fees: [fee.toString()], recipient, deadline: deadline.toString() },
      approval: { token: tokenIn, spender: ROUTER, minimumAllowanceRaw: amountIn.toString() },
    };
  }
  if (source.adapter === "dodo-v2-pmm") {
    const quoteToBase = tokenIn.toLowerCase() === QUOTE.address.toLowerCase() && tokenOut.toLowerCase() === BASE.address.toLowerCase();
    const baseToQuote = tokenIn.toLowerCase() === BASE.address.toLowerCase() && tokenOut.toLowerCase() === QUOTE.address.toLowerCase();
    if (!quoteToBase && !baseToQuote) throw new Error("Unsupported DODO token direction");
    const directions = quoteToBase ? 1n : 0n;
    const calldata = encodeFunctionData({
      abi: dodoProxyAbi, functionName: "dodoSwapV2TokenToToken",
      args: [tokenIn, tokenOut, amountIn, amountOutMin, [source.address], directions, false, deadline],
    });
    return {
      protocol: source.protocol, sourceId: source.id, destination: DODO.proxy, to: DODO.proxy, value: "0", calldata,
      functionName: "dodoSwapV2TokenToToken",
      args: { fromToken: tokenIn, toToken: tokenOut, fromTokenAmount: amountIn.toString(), minReturnAmount: amountOutMin.toString(), dodoPairs: [source.address], directions: directions.toString(), isIncentive: false, deadline: deadline.toString() },
      requiredSender: recipient,
      approval: { token: tokenIn, spender: DODO.approve, minimumAllowanceRaw: amountIn.toString(), note: "DODO V2 Proxy02 pulls through DODOApprove/DODOApproveProxy; approve DODOApprove, not the FaroSwap router." },
    };
  }
  throw new Error(`No transaction encoder exists for ${source.adapter || source.id}`);
}

export function evaluateScan({ sources, config, provenance, scanId, now = new Date(), routeObservations }) {
  if (!Array.isArray(sources) || sources.length !== 2) throw new Error("Exactly two sources are required");
  if (sources.some((source) => !source.valid || source.stale)) {
    const failed = sources.filter((source) => !source.valid || source.stale).map((source) => `${source.label}: ${source.error || (source.stale ? "stale quote" : "invalid source")}`);
    return { scanId, createdAt: now.toISOString(), mode: provenance.mode, provenance, config: serializeConfig(config), sources: serializeSources(sources), routes: [], decision: "SKIP", reason: `Source unavailable or invalid — ${failed.join("; ")}`, plan: null };
  }
  const routes = routeObservations
    ? routeObservations.map((observation) => evaluateQuotedRoute(observation, config))
    : [evaluateRoute({ buy: sources[0], sell: sources[1], config }), evaluateRoute({ buy: sources[1], sell: sources[0], config })];
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
  let plan = null;
  if (decision === "PREPARE") {
    try {
      const leg1 = buildSwapTransaction(buy, {
        tokenIn: QUOTE.address, tokenOut: BASE.address, amountIn: BigInt(best.inputRaw),
        amountOutMin: BigInt(minimumLeg1OutputRaw), recipient: config.recipient, deadline,
      });
      const leg2 = buildSwapTransaction(sell, {
        tokenIn: BASE.address, tokenOut: QUOTE.address, amountIn: BigInt(best.expectedIntermediateRaw),
        amountOutMin: BigInt(best.conservativeOutputRaw), recipient: config.recipient, deadline,
      });
      plan = {
    id: `plan-${scanId}`, label: "SIMULATED EXECUTION PLAN · UNSIGNED TRANSACTION", scanId, route: best.route, inputAmountRaw: best.inputRaw,
    expectedIntermediateRaw: best.expectedIntermediateRaw, expectedOutputRaw: best.afterFeeOutputRaw,
    minimumLeg1OutputRaw,
    minimumLeg2OutputRaw: best.conservativeOutputRaw, modeledCosts: { priceImpactRaw: best.priceImpactCostRaw, feesRaw: best.feeCostRaw, slippageRaw: best.slippageAllowanceRaw, gasQuoteRaw: best.gasCostQuoteRaw },
    thresholdRaw: config.minimumProfitRaw.toString(), provenance, createdAt, expiresAt,
    chainId: CHAIN_ID,
    atomic: false,
    requiredSender: config.recipient,
    prerequisites: [
      "The configured recipient must also submit both swaps because DODO Proxy02 returns output to msg.sender.",
      "Required token balances and both allowances must be checked before signing.",
      "Re-read both venues and rebuild leg 2 from the actual leg-1 output immediately before execution.",
    ],
    transactions: [leg1, leg2],
    approvals: [leg1.approval, leg2.approval],
    intermediateMinimum: { amountRaw: minimumLeg1OutputRaw, token: BASE.address, enforcedByLeg1: true },
    executionRisk: "NON-ATOMIC TWO-TRANSACTION PLAN: leg 1 can succeed while leg 2 fails or becomes unprofitable. No on-chain atomic executor is deployed. Do not sign stale calldata.",
    execution: provenance.mode.startsWith("SIMULATED PRICES")
      ? "UNSIGNED FIXTURE-BASED TWO-VENUE PLAN — ABI-valid venue-specific calldata only; fixture minimums are not live quotes and MUST NOT be broadcast"
      : "UNSIGNED LIVE-QUOTE TWO-VENUE PLAN — never signed or broadcast; it requires balance, allowance, freshness, and leg-2 revalidation checks before expiry",
      };
    } catch (error) {
      decision = "SKIP";
      reason = `Transaction preparation unavailable — ${error.message}`;
      plan = null;
    }
  }
  return { scanId, createdAt, mode: provenance.mode, provenance, config: serializeConfig(config), sources: serializeSources(sources), routes, bestRoute: best.route, decision, reason, plan };
}

function serializeSources(sources) {
  return sources.map((source) => ({ ...source, ...(source.reserveBaseRaw !== undefined ? { reserveBaseRaw: source.reserveBaseRaw.toString() } : {}), ...(source.reserveQuoteRaw !== undefined ? { reserveQuoteRaw: source.reserveQuoteRaw.toString() } : {}) }));
}

function serializeConfig(config) {
  return { tradeAmount: config.tradeAmount, tradeAmountRaw: config.tradeAmountRaw.toString(), minimumProfit: config.minimumProfit, minimumProfitRaw: config.minimumProfitRaw.toString(), slippageBps: config.slippageBps.toString(), gasUnits: config.gasUnits.toString(), gasPriceGwei: config.gasPriceGwei, gasPriceWei: config.gasPriceWei.toString(), gasPriceSource: config.gasPriceSource, observedGasPriceWei: config.observedGasPriceWei?.toString() ?? null, nativePriceQuote: config.nativePriceQuote, nativePriceQuoteRaw: config.nativePriceQuoteRaw.toString(), quoteTtlSeconds: config.quoteTtlSeconds.toString(), recipient: config.recipient, approvalIncluded: true };
}
