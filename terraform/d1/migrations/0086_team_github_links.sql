-- A team may mirror one or more GitHub organization teams. The scheduled sync reconciles only
-- memberships with source = 'github_team' against the linked teams' current members; rows with
-- any other source are never touched. `last_synced_at` is NULL until the first successful sync.
CREATE TABLE team_github_links (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  github_org TEXT NOT NULL,
  github_team_slug TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_synced_at INTEGER,
  PRIMARY KEY (team_id, github_org, github_team_slug)
);
CREATE INDEX idx_team_github_links_due ON team_github_links(last_synced_at);
