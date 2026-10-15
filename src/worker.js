import { runScan, newScanId } from "./scanner.js";
import { D1ScanStore } from "./store.js";
import { DEFAULT_CONFIG, NETWORK, CHAIN_ID, MCP_URL, EXPLORER, BASE, QUOTE, FACTORY, ROUTER, LIVE_SOURCES, OFFICIAL_SOURCES } from "./constants.js";

const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (value, status = 200) => new Response(JSON.stringify(value, null, 2), { status, headers });

async function createScan(request, env) {
  const body = await request.json().catch(() => ({}));
  const mode = body.mode || "live";
  const requestKey = String(body.requestKey || request.headers.get("idempotency-key") || crypto.randomUUID()).slice(0, 120);
  if (!/^[a-zA-Z0-9._:-]{8,120}$/.test(requestKey)) return json({ error: "Invalid idempotency key" }, 400);
  const store = new D1ScanStore(env.DB);
  const existing = await store.findByRequestKey(requestKey);
  if (existing) return json({ scan: existing, deduplicated: true });
  const scan = await runScan({ mode, preset: body.preset, config: body.config || {}, scanId: newScanId(mode) });
  const saved = await store.save(scan, requestKey);
  return json({ scan: saved, deduplicated: false });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/config" && request.method === "GET") return json({ network: NETWORK, chainId: CHAIN_ID, mcpEndpoint: MCP_URL, explorer: EXPLORER, pair: `${BASE.symbol}/${QUOTE.symbol}`, base: BASE, quote: QUOTE, factory: FACTORY, router: ROUTER, liveSources: LIVE_SOURCES, defaultConfig: DEFAULT_CONFIG, sourceMode: "LIVE QUOTES / SIMULATED EXECUTION", officialSources: OFFICIAL_SOURCES });
      if (url.pathname === "/api/scans" && request.method === "POST") return await createScan(request, env);
      if (url.pathname === "/api/scans" && request.method === "GET") return json({ scans: await new D1ScanStore(env.DB).list(Math.min(Number(url.searchParams.get("limit") || 30), 100)) });
      const detail = url.pathname.match(/^\/api\/scans\/([a-zA-Z0-9-]+)$/);
      if (detail && request.method === "GET") {
        const scan = await new D1ScanStore(env.DB).get(detail[1]);
        return scan ? json({ scan }) : json({ error: "Scan not found" }, 404);
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};
