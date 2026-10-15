export const MCP_URL = "https://mcp.pharos.xyz/mcp";
export const CHAIN_ID = 1672;
export const NETWORK = "Pharos Pacific Mainnet";
export const EXPLORER = "https://www.pharosscan.xyz";
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const FACTORY = "0x18Fab7d7027E9FB33Fa90ca607439449209F7B09";
export const ROUTER = "0xd285E37678F07631f33EB99927EB3fF0591a12d7";
export const DEFAULT_RECIPIENT = "0xf2039216c4320CFFC5FB1B704642f9a706b95eE2";
export const BASE = { address: "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0", symbol: "WPROS", decimals: 18 };
export const QUOTE = { address: "0xC879C018dB60520F4355C26eD1a6D572cdAC1815", symbol: "USDC", decimals: 6 };
export const LIVE_SOURCES = [
  { id: "faroswap-v2-30bps", label: "FaroSwap V2 · 30 bps", address: "0x7F4A462FC320db1E26dd1366DcE9E276eE6c5930", expectedFeeBps: 30 },
  { id: "faroswap-v2-1bp", label: "FaroSwap V2 · 1 bp", address: "0x8e3fDBEf5cD72D2dAE407dB1DC61bff44d1DBE9F", expectedFeeBps: 1 },
];
export const OFFICIAL_SOURCES = {
  chainMcp: "https://github.com/PharosNetwork/pharos-mcp",
  mcpEndpoint: MCP_URL,
  faroswapInterface: "https://github.com/faroswap/interface",
  faroswapContracts: "https://github.com/faroswap/contracts",
  faroswapLive: "https://faroswap.xyz/",
  faroswapLiveBundle: "https://faroswap.xyz/_next/static/chunks/6b635545-78d979903a3ed6d7.js",
  usdc: "https://www.circle.com/multi-chain-usdc/pharos",
};
export const DEFAULT_CONFIG = {
  tradeAmount: "0.0001",
  minimumProfit: "0.00001",
  slippageBps: "50",
  gasUnits: "300000",
  gasPriceGwei: "10",
  nativePriceQuote: "0.75",
  quoteTtlSeconds: "60",
  recipient: DEFAULT_RECIPIENT,
  approvalIncluded: true,
};
