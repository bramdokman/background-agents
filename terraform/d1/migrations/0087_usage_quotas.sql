-- Workspace usage metering and quotas.
--
-- usage_quotas: one row per (scope, period). A row limits the aggregate usage
-- of its own scope: one user, one team, or the whole workspace. Workspace rows
-- store scope_id = '' rather than NULL because NULL values are distinct under
-- UNIQUE on SQLite and Postgres alike, which would defeat the upsert key.
-- max_running_sandboxes is a concurrency cap and ignores the period.
CREATE TABLE usage_quotas (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'team', 'user')),
  scope_id TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT 'month' CHECK (period IN ('day', 'month')),
  max_cost_usd REAL,
  max_turns INTEGER,
  max_tokens INTEGER,
  max_running_sandboxes INTEGER,
  action TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('warn', 'block')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope_kind = 'workspace') = (scope_id = '')),
  UNIQUE (scope_kind, scope_id, period)
);

-- usage_ledger: one row per settled turn, keyed by the prompt's message id so
-- a replayed completion rewrites the same row instead of adding to totals.
-- settled_at places the turn in a period window.
CREATE TABLE usage_ledger (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team_id TEXT,
  repo_external_id INTEGER,
  harness TEXT,
  model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  settled_at INTEGER NOT NULL
);
CREATE INDEX idx_usage_ledger_user ON usage_ledger(user_id, settled_at);
CREATE INDEX idx_usage_ledger_team ON usage_ledger(team_id, settled_at);
CREATE INDEX idx_usage_ledger_settled ON usage_ledger(settled_at);

-- running_sandboxes: the sessions whose sandbox is live, for the concurrency
-- cap. A session holds at most one row; it is written when a launch is
-- admitted, re-asserted while the sandbox reports a live status, and removed
-- when it reports a dead one. expires_at bounds a row the session never
-- removed, so a lost durable object cannot hold a slot forever.
CREATE TABLE running_sandboxes (
  session_id TEXT PRIMARY KEY,
  user_id TEXT,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_running_sandboxes_user ON running_sandboxes(user_id, expires_at);
