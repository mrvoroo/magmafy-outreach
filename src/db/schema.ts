export const MIGRATIONS: { id: number; sql: string }[] = [
  { id: 1, sql: `
CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  place_id TEXT UNIQUE,
  name TEXT NOT NULL,
  segment TEXT NOT NULL,            -- furniture | decor | furnishing
  city TEXT, country TEXT, address TEXT, website TEXT, instagram TEXT,
  phone TEXT, phone_type TEXT DEFAULT 'unknown', alt_phones TEXT DEFAULT '[]',
  wa_reachable INTEGER,             -- NULL unknown, 1 yes, 0 no (checked only just before sending)
  owner_name TEXT,
  sources TEXT NOT NULL DEFAULT '{}',   -- field -> {source, at}
  rating REAL, review_count INTEGER, business_status TEXT, chain_flag INTEGER DEFAULT 0,
  score REAL, tier TEXT, score_breakdown TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'discovered',
  status_note TEXT,
  variant TEXT,
  dnc INTEGER NOT NULL DEFAULT 0, dnc_reason TEXT,
  first_sent_at TEXT, reply_at TEXT,
  places_fetched_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX leads_status ON leads(status);
CREATE UNIQUE INDEX leads_phone_unique ON leads(phone) WHERE phone IS NOT NULL;
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id),
  type TEXT NOT NULL, snippet TEXT NOT NULL, source TEXT NOT NULL, source_url TEXT, captured_at TEXT NOT NULL,
  internal_only INTEGER NOT NULL DEFAULT 0, expires_at TEXT
);
CREATE INDEX evidence_lead ON evidence(lead_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES leads(id),
  direction TEXT NOT NULL,            -- out | in
  kind TEXT NOT NULL,                 -- first | followup1 | followup2 | followup3 | reply | inbound
  variant TEXT, text TEXT NOT NULL,
  personal_line TEXT, evidence_ids TEXT DEFAULT '[]', validator_results TEXT DEFAULT '{}',
  state TEXT NOT NULL,                -- draft | ready | scheduled | intent | sent | failed | needs_review | received | skipped
  scheduled_at TEXT, intent_at TEXT, sent_at TEXT,
  wa_message_id TEXT, delivery_status TEXT, failure_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (lead_id, kind, direction)   -- the idempotency key: one first message / one of each follow-up per lead
);
CREATE INDEX messages_lead ON messages(lead_id);
CREATE TABLE reply_class (
  message_id TEXT PRIMARY KEY REFERENCES messages(id), category TEXT NOT NULL, confidence REAL NOT NULL,
  suggested TEXT, handled INTEGER NOT NULL DEFAULT 0, needs_eyes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE plans (day TEXT PRIMARY KEY, created_at TEXT NOT NULL, caps TEXT NOT NULL, notes TEXT DEFAULT '[]');
CREATE TABLE plan_items (
  id TEXT PRIMARY KEY, day TEXT NOT NULL REFERENCES plans(day), lead_id TEXT NOT NULL, message_id TEXT NOT NULL,
  kind TEXT NOT NULL, target_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'planned', skip_reason TEXT,
  UNIQUE (day, message_id)
);
CREATE TABLE dnc (phone TEXT PRIMARY KEY, at TEXT NOT NULL, trigger_text TEXT, reason TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, lead_id TEXT, type TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
CREATE INDEX events_lead ON events(lead_id);
CREATE TABLE crm_outbox (
  id TEXT PRIMARY KEY, op TEXT NOT NULL, lead_id TEXT, payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, done_at TEXT
);
CREATE TABLE spend (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, provider TEXT NOT NULL, usd REAL NOT NULL, note TEXT);
CREATE TABLE reminders (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, due_day TEXT NOT NULL, kind TEXT NOT NULL, draft TEXT, done INTEGER NOT NULL DEFAULT 0);
` },
  { id: 2, sql: `ALTER TABLE leads ADD COLUMN crm_id TEXT; ALTER TABLE leads ADD COLUMN crm_cursor_ok INTEGER DEFAULT 0;
ALTER TABLE crm_outbox ADD COLUMN next_try_at TEXT; ALTER TABLE crm_outbox ADD COLUMN seq INTEGER;` }
];
