import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { encodeFunctionData, decodeFunctionResult } from "viem";
import { MCP_URL, CHAIN_ID, MULTICALL3, FACTORY, ROUTER, BASE, QUOTE, LIVE_SOURCES } from "./constants.js";

const contractAbi = [
  { type: "function", name: "getPair", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeRate", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
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
  const client = new Client({ name: "pharos-arbitrage-scanner", version: "1.0.0" });
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

export async function readLiveSources() {
  return withPharosMcp(async ({ client, call }) => {
    const tools = (await client.listTools()).tools.map(({ name }) => name);
    const missing = requiredTools.filter((name) => !tools.includes(name));
    if (missing.length) throw new Error(`Official MCP is missing required tools: ${missing.join(", ")}`);
    const chain = await call("get_chain_info");
    if (chain.chainId !== CHAIN_ID || !chain.chainIdMatches) throw new Error(`Wrong MCP network: expected ${CHAIN_ID}, received ${chain.chainId}`);
    const block = chain.latestBlock;
    const blockData = await call("get_block", { block, includeTransactions: false });
    const gas = await call("get_gas_price");
    const codeAddresses = { factory: FACTORY, router: ROUTER, base: BASE.address, quote: QUOTE.address, sourceA: LIVE_SOURCES[0].address, sourceB: LIVE_SOURCES[1].address };
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
      ...LIVE_SOURCES.flatMap((source) => [
        callSpec(FACTORY, "getPair", [BASE.address, QUOTE.address, BigInt(source.expectedFeeBps)]),
        callSpec(source.address, "token0"), callSpec(source.address, "token1"), callSpec(source.address, "feeRate"), callSpec(source.address, "getReserves"),
      ]),
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
    if (values[6].toLowerCase() !== FACTORY.toLowerCase()) throw new Error("Official FaroSwap router does not reference the verified factory");
    let offset = 7;
    const sources = LIVE_SOURCES.map((configured) => {
      const [factoryPair, token0, token1, fee, reserves] = values.slice(offset, offset + 5); offset += 5;
      if (factoryPair.toLowerCase() !== configured.address.toLowerCase()) throw new Error(`${configured.label} is not returned by the verified factory`);
      if (token0.toLowerCase() !== BASE.address.toLowerCase() || token1.toLowerCase() !== QUOTE.address.toLowerCase()) throw new Error(`${configured.label} token ordering changed`);
      if (Number(fee) !== configured.expectedFeeBps) throw new Error(`${configured.label} fee changed from ${configured.expectedFeeBps} bps to ${fee}`);
      if (reserves[0] <= 0n || reserves[1] <= 0n) throw new Error(`${configured.label} has insufficient liquidity`);
      return { ...configured, factory: FACTORY, token0, token1, feeBps: Number(fee), reserveBaseRaw: reserves[0].toString(), reserveQuoteRaw: reserves[1].toString(), reserveTimestamp: Number(reserves[2]), observedBlock: block, valid: true, simulated: false };
    });
    return { tools, chain, blockNumber: block, blockTimestamp: Number(BigInt(blockData.timestamp)), gas, bytecode, tokens, router: { address: ROUTER, factory: values[6] }, sources, unpinnedObservations: ["get_gas_price"] };
  });
}
