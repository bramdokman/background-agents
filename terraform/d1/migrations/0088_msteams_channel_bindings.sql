-- Microsoft Teams channels join the channel-binding providers (slack, linear, msteams).
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt. Nothing
-- references team_channel_bindings by foreign key, and dropping the table
-- drops its partial unique index, which is recreated under its own name.
CREATE TABLE team_channel_bindings_new (
  provider TEXT NOT NULL CHECK (provider IN ('slack', 'linear', 'msteams')),
  external_id TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'source' CHECK (kind IN ('primary', 'source')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, external_id)
);

INSERT INTO team_channel_bindings_new (provider, external_id, team_id, kind, created_at)
SELECT provider, external_id, team_id, kind, created_at FROM team_channel_bindings;

DROP TABLE team_channel_bindings;
ALTER TABLE team_channel_bindings_new RENAME TO team_channel_bindings;

CREATE UNIQUE INDEX idx_team_bindings_primary ON team_channel_bindings(team_id, provider) WHERE kind = 'primary';
