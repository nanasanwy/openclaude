import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  pin_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS package_accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  visits_left INTEGER NOT NULL CHECK (visits_left >= 0),
  receipt_no TEXT,
  expires_at INTEGER,
  created_by INTEGER NOT NULL REFERENCES staff(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS package_accounts_phone ON package_accounts(phone);

CREATE TABLE IF NOT EXISTS visit_groups (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('walkin', 'party')),
  receipt_no TEXT,
  table_no TEXT,
  party_id INTEGER,
  package_account_id INTEGER REFERENCES package_accounts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  first_scan_at INTEGER,
  play_end_at INTEGER,
  extension_minutes INTEGER NOT NULL DEFAULT 0,
  blocks_paid INTEGER NOT NULL DEFAULT 0,
  cleared_at INTEGER,
  cleared_by INTEGER REFERENCES staff(id),
  created_by INTEGER NOT NULL REFERENCES staff(id),
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS visit_groups_status ON visit_groups(status);

CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES visit_groups(id),
  name TEXT NOT NULL,
  room TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  expected_guests INTEGER NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  host_name TEXT NOT NULL,
  host_phone TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES staff(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS parties_start ON parties(start_at);

CREATE TABLE IF NOT EXISTS bands (
  barcode TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('adult', 'kid', 'under2')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'void')),
  group_id INTEGER NOT NULL REFERENCES visit_groups(id),
  inside INTEGER NOT NULL DEFAULT 0,
  first_in_at INTEGER,
  last_scan_at INTEGER,
  activated_by INTEGER NOT NULL REFERENCES staff(id),
  activated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bands_group ON bands(group_id);
CREATE INDEX IF NOT EXISTS bands_inside ON bands(inside);

-- Append-only history. Triggers below make these tables impossible to edit or delete from.
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  lane TEXT NOT NULL,
  barcode TEXT NOT NULL,
  band_type TEXT,
  group_id INTEGER,
  result TEXT NOT NULL CHECK (result IN ('opened', 'refused')),
  code TEXT NOT NULL,
  source TEXT NOT NULL,
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS scans_at ON scans(at);
CREATE INDEX IF NOT EXISTS scans_group_at ON scans(group_id, at);

CREATE TABLE IF NOT EXISTS package_ledger (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES package_accounts(id),
  at INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchase', 'visit', 'transfer_out', 'transfer_in')),
  group_id INTEGER,
  counterparty_account_id INTEGER,
  receipt_no TEXT,
  staff_id INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS package_ledger_account ON package_ledger(account_id);

CREATE TABLE IF NOT EXISTS overtime_payments (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  blocks INTEGER NOT NULL,
  kids INTEGER NOT NULL,
  amount REAL NOT NULL,
  receipt_no TEXT,
  staff_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS overrides (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  group_id INTEGER,
  lane TEXT,
  barcode TEXT,
  details TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  staff_id INTEGER,
  action TEXT NOT NULL,
  details TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('normal', 'held_open')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

const APPEND_ONLY = ['scans', 'package_ledger', 'overtime_payments', 'overrides', 'audit_log']

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true, strict: true })
  db.exec('PRAGMA journal_mode = WAL')
  // FULL: a committed scan survives a power cut, not just a process crash.
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  for (const table of APPEND_ONLY) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`)
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`)
  }
  db.query(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`).run()
  return db
}
