CREATE TABLE IF NOT EXISTS trello_monitor_state (
  board_id TEXT PRIMARY KEY, initialized INTEGER NOT NULL DEFAULT 0,
  owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, last_ok INTEGER, last_error TEXT
);
CREATE TABLE IF NOT EXISTS trello_monitor_jobs (
  board_id TEXT NOT NULL, card_id TEXT NOT NULL, card_json TEXT NOT NULL,
  check_status TEXT NOT NULL, first_seen INTEGER NOT NULL, checked_at INTEGER,
  result_json TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_check INTEGER NOT NULL DEFAULT 0,
  send_status TEXT NOT NULL DEFAULT 'none', next_send INTEGER NOT NULL DEFAULT 0,
  message_sid TEXT, last_error TEXT, check_meta TEXT, PRIMARY KEY(board_id,card_id)
);
CREATE INDEX IF NOT EXISTS trello_monitor_pending ON trello_monitor_jobs(board_id,check_status,next_check);
CREATE INDEX IF NOT EXISTS trello_monitor_outbox ON trello_monitor_jobs(board_id,send_status,next_send);

-- Shared spacing for WhatsApp sends; safe to apply to an existing monitor DB.
CREATE TABLE IF NOT EXISTS trello_monitor_delivery (
  provider TEXT PRIMARY KEY, next_allowed INTEGER NOT NULL DEFAULT 0
);

-- Self-monitoring alerts (scan stalled, AI failing, undelivered alerts).
CREATE TABLE IF NOT EXISTS trello_monitor_health (
  board_id TEXT NOT NULL, kind TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0,
  last_sent INTEGER NOT NULL DEFAULT 0, last_value INTEGER, PRIMARY KEY(board_id,kind)
);

-- Dashboard (PDC WhatsApp Bridge add-on). Existing databases created before
-- check_meta existed also need monitor-migrate-dashboard.sql, once.
CREATE TABLE IF NOT EXISTS trello_monitor_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trello_monitor_scans (
  board_id TEXT NOT NULL, hour INTEGER NOT NULL, scans INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, cards INTEGER NOT NULL DEFAULT 0, checks INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, last_at INTEGER, last_ms INTEGER,
  last_ok INTEGER, PRIMARY KEY(board_id,hour)
);

-- WhatsApp outbox. The bridge add-on collects queued rows over HTTPS and
-- reports sent/unknown/failed, so the Pi needs no inbound connection.
CREATE TABLE IF NOT EXISTS trello_monitor_wa_outbox (
  key TEXT PRIMARY KEY, recipient TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', message_id TEXT, error TEXT,
  created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trello_monitor_wa_outbox_status ON trello_monitor_wa_outbox(status,created);
