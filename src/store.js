function withExpiry(scan, now = Date.now()) {
  if (scan?.plan) scan.plan = { ...scan.plan, expired: now >= Date.parse(scan.plan.expiresAt) };
  return scan;
}

export class D1ScanStore {
  constructor(db) { this.db = db; }
  async findByRequestKey(requestKey) {
    const row = await this.db.prepare("SELECT json FROM scans WHERE request_key = ?").bind(requestKey).first();
    return row ? withExpiry(JSON.parse(row.json)) : null;
  }
  async save(scan, requestKey) {
    const json = JSON.stringify(scan);
    await this.db.prepare("INSERT OR IGNORE INTO scans (id,request_key,created_at,mode,decision,reason,plan_id,expires_at,json) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(scan.scanId, requestKey, scan.createdAt, scan.mode, scan.decision, scan.reason, scan.plan?.id ?? null, scan.plan?.expiresAt ?? null, json).run();
    if (scan.plan) await this.db.prepare("INSERT OR IGNORE INTO plans (id,scan_id,created_at,expires_at,json) VALUES (?,?,?,?,?)").bind(scan.plan.id, scan.scanId, scan.plan.createdAt, scan.plan.expiresAt, JSON.stringify(scan.plan)).run();
    return await this.findByRequestKey(requestKey);
  }
  async get(id) {
    const row = await this.db.prepare("SELECT json FROM scans WHERE id = ?").bind(id).first();
    return row ? withExpiry(JSON.parse(row.json)) : null;
  }
  async list(limit = 30) {
    const result = await this.db.prepare("SELECT json FROM scans ORDER BY created_at DESC LIMIT ?").bind(limit).all();
    return (result.results || []).map((row) => withExpiry(JSON.parse(row.json)));
  }
}

export class MemoryScanStore {
  constructor() { this.scans = new Map(); this.requests = new Map(); this.plans = new Map(); }
  async findByRequestKey(key) { return this.requests.get(key) || null; }
  async save(scan, key) {
    if (this.requests.has(key)) return this.requests.get(key);
    this.scans.set(scan.scanId, scan); this.requests.set(key, scan);
    if (scan.plan && !this.plans.has(scan.scanId)) this.plans.set(scan.scanId, scan.plan);
    return scan;
  }
  async get(id) { return this.scans.get(id) || null; }
  async list(limit = 30) { return [...this.scans.values()].reverse().slice(0, limit); }
}
