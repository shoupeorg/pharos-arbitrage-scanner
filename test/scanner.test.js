import test from "node:test";
import assert from "node:assert/strict";
import { runScan } from "../src/scanner.js";
import { normalizeConfig, evaluateScan, ammOut, parseDecimal } from "../src/math.js";
import { MemoryScanStore } from "../src/store.js";
import { decodeFunctionData } from "viem";
import { ROUTER, DODO, QUOTE, BASE } from "../src/constants.js";
const routerAbi = [{ type: "function", name: "swapExactTokensForTokens", stateMutability: "nonpayable", inputs: [{ name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "fees", type: "uint256[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }], outputs: [{ name: "amounts", type: "uint256[]" }] }];
const dodoProxyAbi = [{ type: "function", name: "dodoSwapV2TokenToToken", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "address[]" }, { type: "uint256" }, { type: "bool" }, { type: "uint256" }], outputs: [{ type: "uint256" }] }];

test("profitable deterministic cycle prepares exactly one plan", async () => {
  const scan = await runScan({ mode: "simulation", preset: "profitable", scanId: "simulation-profitable-test" });
  assert.equal(scan.decision, "PREPARE"); assert.ok(scan.plan); assert.match(scan.plan.execution, /UNSIGNED FIXTURE-BASED TWO-VENUE PLAN/);
  assert.equal(scan.plan.chainId, 1672); assert.equal(scan.plan.atomic, false); assert.equal(scan.plan.transactions.length, 2);
  assert.equal(scan.plan.transactions[0].destination, DODO.proxy); assert.equal(scan.plan.transactions[1].destination, ROUTER);
  const dodoDecoded = decodeFunctionData({ abi: dodoProxyAbi, data: scan.plan.transactions[0].calldata });
  assert.equal(dodoDecoded.functionName, "dodoSwapV2TokenToToken");
  assert.equal(dodoDecoded.args[2].toString(), scan.plan.inputAmountRaw);
  assert.deepEqual(dodoDecoded.args[0], QUOTE.address); assert.deepEqual(dodoDecoded.args[1], BASE.address);
  const faroDecoded = decodeFunctionData({ abi: routerAbi, data: scan.plan.transactions[1].calldata });
  assert.equal(faroDecoded.functionName, "swapExactTokensForTokens");
  assert.equal(faroDecoded.args[0].toString(), scan.plan.expectedIntermediateRaw);
  assert.equal(faroDecoded.args[1].toString(), scan.plan.minimumLeg2OutputRaw);
  assert.deepEqual(faroDecoded.args[2], [BASE.address, QUOTE.address]);
  assert.deepEqual(faroDecoded.args[3].map(String), ["1"]);
  assert.equal(scan.plan.modelExecution.matchesScannerAfterFeeOutput, true);
  const store = new MemoryScanStore(); await store.save(scan, "request-profitable"); await store.save({ ...scan, plan: { ...scan.plan, id: "duplicate" } }, "request-profitable");
  assert.equal(store.plans.size, 1); assert.equal((await store.list()).length, 1);
});

test("positive spread erased by modeled costs skips", async () => {
  const scan = await runScan({ mode: "simulation", preset: "costsErase", scanId: "simulation-costs-test" });
  assert.equal(scan.decision, "SKIP"); assert.match(scan.reason, /erase/); assert.equal(scan.plan, null);
  assert.ok(scan.routes.some((route) => BigInt(route.grossSpotSpreadRaw) > 0n));
});

test("net profit below or equal to threshold skips", async () => {
  const scan = await runScan({ mode: "simulation", preset: "belowThreshold", scanId: "simulation-threshold-test" });
  assert.equal(scan.decision, "SKIP"); assert.match(scan.reason, /threshold/); assert.equal(scan.plan, null);
});

test("strict threshold equality skips instead of preparing", async () => {
  const scan = await runScan({
    mode: "simulation",
    preset: "profitable",
    scanId: "simulation-threshold-equality-test",
    config: { minimumProfit: "218.709894" },
  });
  assert.equal(scan.decision, "SKIP");
  assert.ok(scan.routes.some((route) => route.display.netProfit === "218.709894"));
  assert.match(scan.reason, /strictly exceed/);
  assert.equal(scan.plan, null);
});

test("a live source failure produces a persistable two-source error record", async () => {
  const scan = await runScan({
    mode: "live",
    scanId: "live-source-error-test",
    liveReader: async () => { throw new Error("simulated MCP timeout"); },
  });
  assert.equal(scan.decision, "SKIP");
  assert.equal(scan.plan, null);
  assert.equal(scan.sources.length, 2);
  assert.ok(scan.sources.every((source) => source.valid === false && source.error === "simulated MCP timeout"));
  const store = new MemoryScanStore();
  await store.save(scan, "request-source-error");
  assert.deepEqual(await store.get(scan.scanId), scan);
});

test("both route directions are evaluated", async () => {
  const scan = await runScan({ mode: "simulation", preset: "profitable", scanId: "simulation-directions-test" });
  assert.equal(scan.routes.length, 2); assert.notEqual(scan.routes[0].buySource, scan.routes[1].buySource);
});

test("decimal parsing and AMM output use conservative integer rounding", () => {
  assert.equal(parseDecimal("0.000001", 6), 1n);
  assert.throws(() => parseDecimal("0.0000001", 6), /at most 6/);
  const out = ammOut(1_000_000n, 100_000_000n, 1_000_000_000_000_000_000n, 30n);
  const numerator = 1_000_000n * 9_970n * 1_000_000_000_000_000_000n;
  const denominator = 100_000_000n * 10_000n + 1_000_000n * 9_970n;
  assert.equal(out, numerator / denominator);
});

test("fees and price impact are separated without double counting", async () => {
  const scan = await runScan({ mode: "simulation", preset: "profitable", scanId: "simulation-cost-model-test" });
  for (const route of scan.routes) {
    const ideal = BigInt(route.idealNoFeeNoImpactOutputRaw), noFee = BigInt(route.noFeePriceImpactOutputRaw), afterFee = BigInt(route.afterFeeOutputRaw);
    assert.equal(BigInt(route.priceImpactCostRaw), ideal > noFee ? ideal - noFee : 0n);
    assert.equal(BigInt(route.feeCostRaw), noFee > afterFee ? noFee - afterFee : 0n);
  }
});

test("invalid, stale, or missing source data cannot prepare", () => {
  const config = normalizeConfig({ tradeAmount: "1", minimumProfit: "0", slippageBps: "0", gasUnits: "21000", gasPriceGwei: "1", nativePriceQuote: "1", quoteTtlSeconds: "60" });
  const valid = { id: "a", label: "A", valid: true, reserveBaseRaw: 1_000_000_000_000_000_000n, reserveQuoteRaw: 1_000_000n, feeBps: 1 };
  for (const bad of [{ ...valid, id: "bad", valid: false, error: "source unavailable" }, { ...valid, id: "stale", stale: true }]) {
    const scan = evaluateScan({ scanId: `invalid-${bad.id}`, config, sources: [valid, bad], provenance: { mode: "TEST" } });
    assert.equal(scan.decision, "SKIP"); assert.equal(scan.plan, null);
  }
  assert.throws(() => evaluateScan({ scanId: "missing-source", config, sources: [valid], provenance: { mode: "TEST" } }), /Exactly two/);
});

test("CLI and web entry points share the same deterministic scanner result", async () => {
  const now = new Date("2026-10-15T00:00:00.000Z");
  const left = await runScan({ mode: "simulation", preset: "profitable", scanId: "shared-result", now });
  const right = await runScan({ mode: "simulation", preset: "profitable", scanId: "shared-result", now });
  assert.deepEqual(left, right);
});

test("a profitable live observation is refreshed before a plan is prepared", async () => {
  let calls = 0;
  const liveReader = async () => {
    calls += 1;
    return {
      blockNumber: String(100 + calls),
      blockTimestamp: 1_700_000_000 + calls,
      tools: ["eth_call"], tokens: {}, bytecode: {}, gas: { gasPriceWei: "1" }, unpinnedObservations: ["get_gas_price"],
      sources: [
        { id: "live-a", label: "Live A", protocol: "DODO", adapter: "dodo-v2-pmm", address: DODO.pool, feeBps: 30, reserveBaseRaw: parseDecimal("1000", 18).toString(), reserveQuoteRaw: parseDecimal("100000", 6).toString(), valid: true },
        { id: "live-b", label: "Live B", protocol: "FaroSwap", adapter: "faroswap-v2", address: "0x8e3fDBEf5cD72D2dAE407dB1DC61bff44d1DBE9F", feeBps: 1, reserveBaseRaw: parseDecimal("1000", 18).toString(), reserveQuoteRaw: parseDecimal("125000", 6).toString(), valid: true },
      ],
    };
  };
  const scan = await runScan({
    mode: "live", scanId: "live-revalidation-test", liveReader,
    config: { tradeAmount: "1000", minimumProfit: "5", slippageBps: "25", gasUnits: "300000", gasPriceGwei: "1", nativePriceQuote: "1", quoteTtlSeconds: "60" },
  });
  assert.equal(calls, 2);
  assert.equal(scan.decision, "PREPARE");
  assert.equal(scan.provenance.quoteStage, "revalidated-before-plan");
  assert.equal(scan.provenance.initialBlockNumber, "101");
  assert.equal(scan.provenance.blockNumber, "102");
});

test("live default gas uses the MCP observation while an override stays explicit", async () => {
  const sourceResult = {
    blockNumber: "500", blockTimestamp: 1_700_000_000, tools: ["eth_call"], tokens: {}, bytecode: {}, venues: {},
    gas: { gasPriceWei: "7000000000", gasPriceGwei: "7" }, unpinnedObservations: ["get_gas_price"],
    sources: [
      { id: "a", label: "A", protocol: "DODO", adapter: "dodo-v2-pmm", address: DODO.pool, feeBps: 30, reserveBaseRaw: parseDecimal("1000", 18).toString(), reserveQuoteRaw: parseDecimal("100000", 6).toString(), valid: true },
      { id: "b", label: "B", protocol: "FaroSwap", adapter: "faroswap-v2", address: "0x8e3fDBEf5cD72D2dAE407dB1DC61bff44d1DBE9F", feeBps: 1, reserveBaseRaw: parseDecimal("1000", 18).toString(), reserveQuoteRaw: parseDecimal("100000", 6).toString(), valid: true },
    ],
  };
  const observed = await runScan({ mode: "live", scanId: "live-observed-gas", liveReader: async () => sourceResult });
  assert.equal(observed.config.gasPriceWei, "7000000000");
  assert.equal(observed.config.gasPriceSource, "MCP get_gas_price observation");
  const override = await runScan({ mode: "live", scanId: "live-override-gas", config: { gasPriceGwei: "3" }, liveReader: async () => sourceResult });
  assert.equal(override.config.gasPriceWei, "3000000000");
  assert.equal(override.config.gasPriceSource, "EXPLICIT USER OVERRIDE");
});

test("primary fixture exposes two protocol adapters and non-atomic venue-correct prerequisites", async () => {
  const scan = await runScan({ mode: "simulation", preset: "profitable", scanId: "simulation-protocol-plan" });
  assert.deepEqual(scan.sources.map((source) => source.adapter), ["dodo-v2-pmm", "faroswap-v2"]);
  assert.equal(scan.plan.atomic, false);
  assert.match(scan.plan.executionRisk, /leg 1 can succeed while leg 2 fails/i);
  assert.equal(scan.plan.approvals[0].spender, DODO.approve);
  assert.equal(scan.plan.approvals[1].spender, ROUTER);
});
