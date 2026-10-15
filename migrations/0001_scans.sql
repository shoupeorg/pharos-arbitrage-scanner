CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  request_key TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  plan_id TEXT,
  expires_at TEXT,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scans_created_at ON scans(created_at DESC);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  scan_id TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  json TEXT NOT NULL
);
