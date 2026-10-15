import { DEFAULT_CONFIG, NETWORK, CHAIN_ID, MCP_URL, BASE, QUOTE, OFFICIAL_SOURCES } from "./constants.js";
import { normalizeConfig, evaluateScan, parseDecimal, parseInteger } from "./math.js";
import { FIXTURES } from "./fixtures.js";
import { readLiveSources } from "./pharos-mcp.js";
import { simulateConstantProductPlan } from "./simulation.js";

const hydrateSources = (sources) => sources.map((source) => ({ ...source, reserveBaseRaw: BigInt(source.reserveBaseRaw), reserveQuoteRaw: BigInt(source.reserveQuoteRaw) }));
export const newScanId = (mode = "scan") => `${mode}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

function liveProvenance(live, extra = {}) {
  return {
    mode: "LIVE CROSS-PROTOCOL QUOTES / SIMULATED EXECUTION",
    network: NETWORK,
    chainId: CHAIN_ID,
    blockNumber: live.blockNumber,
    blockTimestamp: live.blockTimestamp,
    mcpEndpoint: MCP_URL,
    mcpTools: live.tools,
    tokenPair: `${BASE.symbol}/${QUOTE.symbol}`,
    tokens: live.tokens,
    venues: live.venues,
    bytecode: live.bytecode,
    gasObservation: live.gas,
    gasModel: "Default: the economic model uses the current MCP get_gas_price observation. A user-entered numeric gwei value is an explicit, visible override.",
    unpinnedObservations: live.unpinnedObservations,
    sourceUrls: OFFICIAL_SOURCES,
    ...extra,
  };
}

export async function runScan({ mode = "live", preset, config = {}, scanId = newScanId(mode), now = new Date(), liveReader = readLiveSources } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{7,100}$/i.test(scanId)) throw new Error("Invalid scan ID");
  if (mode === "live") {
    const merged = { ...DEFAULT_CONFIG, ...config };
    const tradeAmountRaw = parseDecimal(merged.tradeAmount, QUOTE.decimals, "Trade amount", { positive: true });
    try {
      const live = await liveReader({ tradeAmountRaw, trader: merged.recipient || DEFAULT_CONFIG.recipient });
      const observedGasPriceWei = BigInt(live.gas.gasPriceWei);
      const normalized = normalizeConfig(merged, QUOTE.decimals, { observedGasPriceWei });
      const initial = evaluateScan({ scanId, now, config: normalized, sources: hydrateSources(live.sources), routeObservations: live.routeObservations, provenance: liveProvenance(live, { quoteStage: "initial", protocolIndependence: "VERIFIED: DODO V2 PMM and FaroSwap V2" }) });
      if (initial.decision !== "PREPARE") return initial;

      // A plan is never created from the first profitable observation. Refresh both
      // sources and rebuild the economics from one new pinned block immediately
      // before returning a reviewable plan.
      const refreshed = await liveReader({ tradeAmountRaw, trader: merged.recipient || DEFAULT_CONFIG.recipient });
      const refreshedConfig = normalizeConfig(merged, QUOTE.decimals, { observedGasPriceWei: BigInt(refreshed.gas.gasPriceWei) });
      return evaluateScan({
        scanId,
        now,
        config: refreshedConfig,
        sources: hydrateSources(refreshed.sources),
        routeObservations: refreshed.routeObservations,
        provenance: liveProvenance(refreshed, {
          quoteStage: "revalidated-before-plan",
          initialBlockNumber: live.blockNumber,
          revalidated: true,
          protocolIndependence: "VERIFIED: DODO V2 PMM and FaroSwap V2",
        }),
      });
    } catch (error) {
      const invalid = [
        { id: "dodo-v2-pmm", label: "DODO V2 PMM", protocol: "DODO V2 PMM" },
        { id: "faroswap-v2-30bps", label: "FaroSwap V2", protocol: "FaroSwap V2" },
      ].map((source) => ({ ...source, valid: false, error: error.message }));
      const errorConfig = normalizeConfig({ ...merged, gasPriceGwei: merged.gasPriceGwei === "observed" ? "1" : merged.gasPriceGwei });
      errorConfig.gasPriceWei = 0n;
      errorConfig.gasPriceSource = "UNAVAILABLE — source read failed; economics were not evaluated";
      return evaluateScan({ scanId, now, config: errorConfig, sources: invalid, provenance: { mode: "LIVE CROSS-PROTOCOL QUOTES / SIMULATED EXECUTION", network: NETWORK, chainId: CHAIN_ID, mcpEndpoint: MCP_URL, error: error.message, sourceUrls: OFFICIAL_SOURCES } });
    }
  }
  if (mode !== "simulation") throw new Error("Mode must be live or simulation");
  const fixture = FIXTURES[preset || "profitable"];
  if (!fixture) throw new Error("Unknown deterministic preset");
  const merged = { ...DEFAULT_CONFIG, ...fixture.config, ...config };
  const normalized = normalizeConfig(merged);
  const sources = hydrateSources(fixture.sources.map((source, index) => {
    const key = index === 0 ? "sourceA" : "sourceB";
    const custom = config[key] || {};
    return { ...source, feeBps: custom.feeBps === undefined ? source.feeBps : Number(custom.feeBps), reserveBaseRaw: source.reserveBaseRaw, reserveQuoteRaw: source.reserveQuoteRaw };
  }));
  // Apply optional reserve overrides with the same strict decimal parser used by live economic inputs.
  for (const [index, key] of [[0, "sourceA"], [1, "sourceB"]]) {
    const custom = config[key] || {};
    if (custom.reserveBase !== undefined || custom.reserveQuote !== undefined || custom.feeBps !== undefined) {
      if (custom.reserveBase !== undefined) sources[index].reserveBaseRaw = parseDecimal(custom.reserveBase, 18, `${key} base reserve`, { positive: true });
      if (custom.reserveQuote !== undefined) sources[index].reserveQuoteRaw = parseDecimal(custom.reserveQuote, 6, `${key} quote reserve`, { positive: true });
      if (custom.feeBps !== undefined) sources[index].feeBps = Number(parseInteger(custom.feeBps, `${key} fee`, 0, 9999));
    }
  }
  const scan = evaluateScan({ scanId, now, config: normalized, sources, provenance: { mode: "SIMULATED PRICES / SIMULATED EXECUTION", scenario: fixture.label, network: "DETERMINISTIC FIXTURE — NOT LIVE CHAIN DATA", chainId: null, snapshot: "two independent in-memory constant-product AMM instances", assumptions: ["Both pool reserves", "pool fees", "gas price", "native-token price"], separation: "Fixtures test the shared policy/plan engine only and are never presented as live Pharos observations." } });
  if (scan.plan) scan.plan.modelExecution = simulateConstantProductPlan(sources, scan);
  return scan;
}
