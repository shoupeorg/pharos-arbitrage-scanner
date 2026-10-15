import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { encodeFunctionData, decodeFunctionResult } from "viem";
import { ammOut, ceilDiv, pow10 } from "./math.js";
import {
  MCP_URL, CHAIN_ID, MULTICALL3, FACTORY, ROUTER, DODO,
  BASE, QUOTE, LIVE_SOURCES, DEFAULT_RECIPIENT,
} from "./constants.js";

const ONE = 10n ** 18n;
const contractAbi = [
  { type: "function", name: "getPair", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getDODOPoolBidirection", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address[]" }, { type: "address[]" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeRate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "_BASE_TOKEN_", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "_QUOTE_TOKEN_", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getVaultReserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "getUserFeeRate", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "getMidPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "querySellBase", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "querySellQuote", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
];
const multicallAbi = [{ type: "function", name: "aggregate3", stateMutability: "payable", inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] }], outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] }];
const requiredTools = ["get_chain_info", "get_block_number", "get_block", "get_code", "get_gas_price", "eth_call"];

function parseResult(response) {
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP returned no text result");
  const value = JSON.parse(text);
  if (response.isError || value?.error) throw new Error(value?.error?.message || "MCP tool failed");
  return value;
}

async function retry(operation, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); } catch (error) {
      last = error;
      if (attempt === attempts || !/timeout|fetch|network|502|503|429|connection|reset/i.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw last;
}

export async function withPharosMcp(operation) {
  const client = new Client({ name: "pharos-arbitrage-scanner", version: "1.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }) });
  await retry(() => client.connect(transport));
  const call = (name, args = {}) => retry(async () => parseResult(await client.callTool({ name, arguments: args })));
  try { return await operation({ client, call }); } finally { await client.close(); }
}

function callSpec(target, functionName, args = []) {
  return { target, allowFailure: false, callData: encodeFunctionData({ abi: contractAbi, functionName, args }), functionName };
}

function decodeSpec(spec, result) {
  if (!result.success) throw new Error(`${spec.functionName} failed for ${spec.target}`);
  return decodeFunctionResult({ abi: contractAbi, functionName: spec.functionName, data: result.returnData });
}

function sameAddress(left, right) { return left.toLowerCase() === right.toLowerCase(); }

function reconstructBeforeLpFee(net, maintainerFee, lpRate) {
  let gross = ceilDiv((net + maintainerFee) * ONE, ONE - lpRate);
  for (let offset = -3n; offset <= 3n; offset += 1n) {
    const candidate = gross + offset;
    if (candidate < 0n) continue;
    if (candidate - (candidate * lpRate / ONE) - maintainerFee === net) return candidate;
  }
  return gross;
}

async function pinnedCall(call, block, target, functionName, args) {
  const data = encodeFunctionData({ abi: contractAbi, functionName, args });
  const raw = await call("eth_call", { transaction: { to: target, data }, block });
  return decodeFunctionResult({ abi: contractAbi, functionName, data: raw.result });
}

export async function readLiveSources({ tradeAmountRaw, trader = DEFAULT_RECIPIENT } = {}) {
  if (typeof tradeAmountRaw !== "bigint" || tradeAmountRaw <= 0n) throw new Error("A positive raw trade amount is required for executable live quotes");
  return withPharosMcp(async ({ client, call }) => {
    const tools = (await client.listTools()).tools.map(({ name }) => name);
    const missing = requiredTools.filter((name) => !tools.includes(name));
    if (missing.length) throw new Error(`Official MCP is missing required tools: ${missing.join(", ")}`);
    const chain = await call("get_chain_info");
    if (chain.chainId !== CHAIN_ID || !chain.chainIdMatches) throw new Error(`Wrong MCP network: expected ${CHAIN_ID}, received ${chain.chainId}`);
    const block = chain.latestBlock;
    const blockData = await call("get_block", { block, includeTransactions: false });
    const gas = await call("get_gas_price");
    const faro = LIVE_SOURCES.find((source) => source.adapter === "faroswap-v2");
    const dodo = LIVE_SOURCES.find((source) => source.adapter === "dodo-v2-pmm");
    const codeAddresses = {
      faroFactory: FACTORY, faroRouter: ROUTER, faroPool: faro.address,
      dodoFactory: DODO.factory, dodoPool: DODO.pool, dodoProxy: DODO.proxy,
      dodoApprove: DODO.approve, dodoApproveProxy: DODO.approveProxy,
      base: BASE.address, quote: QUOTE.address,
    };
    const bytecode = {};
    for (const [label, address] of Object.entries(codeAddresses)) {
      const result = await call("get_code", { address, block });
      if (!result.code || result.code === "0x") throw new Error(`Missing bytecode for ${label} at ${address}`);
      bytecode[label] = { address, bytes: (result.code.length - 2) / 2 };
    }

    const specs = [
      callSpec(BASE.address, "name"), callSpec(BASE.address, "symbol"), callSpec(BASE.address, "decimals"),
      callSpec(QUOTE.address, "name"), callSpec(QUOTE.address, "symbol"), callSpec(QUOTE.address, "decimals"),
      callSpec(ROUTER, "factory"),
      callSpec(FACTORY, "getPair", [BASE.address, QUOTE.address, BigInt(faro.expectedFeeBps)]),
      callSpec(faro.address, "token0"), callSpec(faro.address, "token1"), callSpec(faro.address, "feeRate"), callSpec(faro.address, "getReserves"),
      callSpec(DODO.factory, "getDODOPoolBidirection", [BASE.address, QUOTE.address]),
      callSpec(DODO.pool, "_BASE_TOKEN_"), callSpec(DODO.pool, "_QUOTE_TOKEN_"), callSpec(DODO.pool, "getVaultReserve"),
      callSpec(DODO.pool, "getUserFeeRate", [trader]), callSpec(DODO.pool, "getMidPrice"),
    ];
    const data = encodeFunctionData({ abi: multicallAbi, functionName: "aggregate3", args: [specs.map(({ target, allowFailure, callData }) => ({ target, allowFailure, callData }))] });
    const raw = await call("eth_call", { transaction: { to: MULTICALL3, data }, block });
    const results = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data: raw.result });
    const values = specs.map((spec, index) => decodeSpec(spec, results[index]));
    const tokens = {
      base: { address: BASE.address, name: values[0], symbol: values[1], decimals: Number(values[2]) },
      quote: { address: QUOTE.address, name: values[3], symbol: values[4], decimals: Number(values[5]) },
    };
    if (tokens.base.decimals !== BASE.decimals || tokens.quote.decimals !== QUOTE.decimals) throw new Error("Live token decimals do not match verified configuration");
    if (!sameAddress(values[6], FACTORY)) throw new Error("FaroSwap router does not reference the verified factory");
    if (!sameAddress(values[7], faro.address)) throw new Error("FaroSwap pool is not returned by the verified factory");
    if (!sameAddress(values[8], BASE.address) || !sameAddress(values[9], QUOTE.address)) throw new Error("FaroSwap token ordering changed");
    if (Number(values[10]) !== faro.expectedFeeBps) throw new Error(`FaroSwap fee changed to ${values[10]} bps`);
    const faroReserves = values[11];
    if (faroReserves[0] <= 0n || faroReserves[1] <= 0n) throw new Error("FaroSwap pool has insufficient liquidity");
    const [dodoForward] = values[12];
    if (!dodoForward.some((address) => sameAddress(address, DODO.pool))) throw new Error("DODO pool is not registered by the official DVM factory");
    if (!sameAddress(values[13], BASE.address) || !sameAddress(values[14], QUOTE.address)) throw new Error("DODO pool token ordering changed");
    const dodoReserves = values[15];
    const [dodoLpFeeRate, dodoMaintainerFeeRate] = values[16];
    const dodoMidPrice = values[17];
    if (dodoReserves[0] <= 0n || dodoReserves[1] <= 0n || dodoMidPrice <= 0n) throw new Error("DODO pool has insufficient liquidity or an invalid mid price");

    const dodoBuy = await pinnedCall(call, block, DODO.pool, "querySellQuote", [trader, tradeAmountRaw]);
    const faroBaseAfterFee = ammOut(tradeAmountRaw, faroReserves[1], faroReserves[0], BigInt(faro.expectedFeeBps));
    const faroBaseNoFee = ammOut(tradeAmountRaw, faroReserves[1], faroReserves[0], 0n);
    const dodoSellAfterFee = await pinnedCall(call, block, DODO.pool, "querySellBase", [trader, faroBaseAfterFee]);
    const dodoSellNoFaroFee = await pinnedCall(call, block, DODO.pool, "querySellBase", [trader, faroBaseNoFee]);
    const dodoBuyGross = reconstructBeforeLpFee(dodoBuy[0], dodoBuy[1], dodoLpFeeRate);
    const dodoSellGross = reconstructBeforeLpFee(dodoSellAfterFee[0], dodoSellAfterFee[1], dodoLpFeeRate);
    const dodoSellNoFaroFeeGross = reconstructBeforeLpFee(dodoSellNoFaroFee[0], dodoSellNoFaroFee[1], dodoLpFeeRate);
    const dodoSpotQuoteRaw = dodoMidPrice * pow10(BASE.decimals) / ONE;
    const faroSpotQuoteRaw = faroReserves[1] * pow10(BASE.decimals) / faroReserves[0];

    const dodoToFaroIdealIntermediate = tradeAmountRaw * ONE / dodoMidPrice;
    const dodoToFaroIdealOutput = dodoToFaroIdealIntermediate * faroReserves[1] / faroReserves[0];
    const dodoToFaroNoFeeOutput = ammOut(dodoBuyGross, faroReserves[0], faroReserves[1], 0n);
    const dodoToFaroAfterFeeOutput = ammOut(dodoBuy[0], faroReserves[0], faroReserves[1], BigInt(faro.expectedFeeBps));
    const faroToDodoIdealIntermediate = tradeAmountRaw * faroReserves[0] / faroReserves[1];
    const faroToDodoIdealOutput = faroToDodoIdealIntermediate * dodoMidPrice / ONE;

    const sources = [
      {
        ...dodo, token0: BASE.address, token1: QUOTE.address,
        reserveBaseRaw: dodoReserves[0].toString(), reserveQuoteRaw: dodoReserves[1].toString(),
        feeBps: Number((dodoLpFeeRate + dodoMaintainerFeeRate) * 10_000n / ONE),
        feeModel: { type: "dynamic-user-rate", scale: "1e18", lpFeeRate: dodoLpFeeRate.toString(), maintainerFeeRate: dodoMaintainerFeeRate.toString(), quoteIncludesFees: true },
        pricingModel: "DODO PMM; executable querySellBase/querySellQuote outputs",
        midPriceRaw1e18: dodoMidPrice.toString(), observedBlock: block, valid: true, simulated: false,
      },
      {
        ...faro, token0: BASE.address, token1: QUOTE.address,
        reserveBaseRaw: faroReserves[0].toString(), reserveQuoteRaw: faroReserves[1].toString(),
        feeBps: faro.expectedFeeBps,
        feeModel: { type: "fixed-bps", feeBps: faro.expectedFeeBps, quoteIncludesFees: true },
        pricingModel: "Uniswap V2-style constant product with feeRate()",
        reserveTimestamp: Number(faroReserves[2]), observedBlock: block, valid: true, simulated: false,
      },
    ];
    const routeObservations = [
      {
        buySource: dodo.id, sellSource: faro.id, inputRaw: tradeAmountRaw,
        buyPriceRaw: dodoSpotQuoteRaw, sellPriceRaw: faroSpotQuoteRaw,
        idealIntermediateRaw: dodoToFaroIdealIntermediate, idealOutputRaw: dodoToFaroIdealOutput,
        noFeeIntermediateRaw: dodoBuyGross, noFeeOutputRaw: dodoToFaroNoFeeOutput,
        expectedIntermediateRaw: dodoBuy[0], afterFeeOutputRaw: dodoToFaroAfterFeeOutput,
        quoteEvidence: { dodoFunction: "querySellQuote", dodoInputRaw: tradeAmountRaw.toString(), dodoOutputRaw: dodoBuy[0].toString(), dodoMaintainerFeeRaw: dodoBuy[1].toString(), faroFormula: "constant-product feeRate 30 bps" },
      },
      {
        buySource: faro.id, sellSource: dodo.id, inputRaw: tradeAmountRaw,
        buyPriceRaw: faroSpotQuoteRaw, sellPriceRaw: dodoSpotQuoteRaw,
        idealIntermediateRaw: faroToDodoIdealIntermediate, idealOutputRaw: faroToDodoIdealOutput,
        noFeeIntermediateRaw: faroBaseNoFee, noFeeOutputRaw: dodoSellNoFaroFeeGross,
        expectedIntermediateRaw: faroBaseAfterFee, afterFeeOutputRaw: dodoSellAfterFee[0],
        quoteEvidence: { faroFormula: "constant-product feeRate 30 bps", dodoFunction: "querySellBase", dodoInputRaw: faroBaseAfterFee.toString(), dodoOutputRaw: dodoSellAfterFee[0].toString(), dodoMaintainerFeeRaw: dodoSellAfterFee[1].toString(), dodoGrossBeforeFeeRaw: dodoSellGross.toString() },
      },
    ];
    return {
      tools, chain, blockNumber: block, blockTimestamp: Number(BigInt(blockData.timestamp)), gas, bytecode, tokens,
      venues: { dodo: { factory: DODO.factory, pool: DODO.pool, proxy: DODO.proxy, approve: DODO.approve }, faroswap: { factory: FACTORY, pool: faro.address, router: ROUTER } },
      sources, routeObservations, unpinnedObservations: ["get_gas_price"], observedAt: new Date().toISOString(),
    };
  });
}
