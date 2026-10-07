import {
  createTeamGitHubLinkRequestSchema,
  teamGitHubLinkSchema,
  type CreateTeamGitHubLinkRequest,
  type TeamGitHubLink,
} from "@open-inspect/shared/types/teams";
import { TeamAuditStore, type TeamAuditActor } from "./team-audit";
import type { SqlDatabase, SqlStatement } from "./sql-database";

const LINK_COLUMNS = `team_id AS "teamId", github_org AS "githubOrg", github_team_slug AS "githubTeamSlug",
  created_at AS "createdAt", last_synced_at AS "lastSyncedAt"`;

/** Links between teams and the GitHub organization teams whose members they mirror. */
export class TeamGitHubLinkStore {
  constructor(private readonly db: SqlDatabase) {}

  async listForTeam(teamId: string): Promise<TeamGitHubLink[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM team_github_links
         WHERE team_id = ? ORDER BY github_org, github_team_slug`
      )
      .bind(teamId)
      .all();
    return rows.results.map((row) => teamGitHubLinkSchema.parse(row));
  }

  /**
   * Every link of an active team that has at least one link not synced since
   * `staleBefore`. A team reconciles against the union of its links, so one
   * due link brings its siblings along.
   */
  async listDue(staleBefore: number): Promise<TeamGitHubLink[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${LINK_COLUMNS} FROM team_github_links l
         WHERE EXISTS (SELECT 1 FROM teams t WHERE t.id = l.team_id AND t.archived_at IS NULL)
           AND EXISTS (SELECT 1 FROM team_github_links d WHERE d.team_id = l.team_id
                         AND (d.last_synced_at IS NULL OR d.last_synced_at <= ?))
         ORDER BY team_id, github_org, github_team_slug`
      )
      .bind(staleBefore)
      .all();
    return rows.results.map((row) => teamGitHubLinkSchema.parse(row));
  }

  /** The link, and whether this call created it; a repeat is a no-op with no audit row. */
  async add(
    teamId: string,
    input: CreateTeamGitHubLinkRequest,
    actor: TeamAuditActor
  ): Promise<{ link: TeamGitHubLink; created: boolean }> {
    const { githubOrg, githubTeamSlug } = createTeamGitHubLinkRequestSchema.parse(input);
    const link: TeamGitHubLink = {
      teamId,
      githubOrg,
      githubTeamSlug,
      createdAt: Date.now(),
      lastSyncedAt: null,
    };
    const [inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO team_github_links (team_id, github_org, github_team_slug, created_at)
           VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`
        )
        .bind(teamId, githubOrg, githubTeamSlug, link.createdAt),
      new TeamAuditStore(this.db).bind(
        { ...actor, teamId, action: "team.github_link_added", before: {}, after: link },
        true
      ),
    ]);
    if (inserted.meta.changes === 1) return { link, created: true };
    const existing = (await this.listForTeam(teamId)).find(
      (row) => row.githubOrg === githubOrg && row.githubTeamSlug === githubTeamSlug
    );
    if (!existing) throw new Error("Team GitHub link was not created");
    return { link: existing, created: false };
  }

  /** Removes the link only; memberships it synced stay until a lead or admin removes them. */
  async remove(
    teamId: string,
    githubOrg: string,
    githubTeamSlug: string,
    actor: TeamAuditActor
  ): Promise<boolean> {
    const [deleted] = await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM team_github_links WHERE team_id = ? AND github_org = ? AND github_team_slug = ?"
        )
        .bind(teamId, githubOrg, githubTeamSlug),
      new TeamAuditStore(this.db).bind(
        {
          ...actor,
          teamId,
          action: "team.github_link_removed",
          before: { teamId, githubOrg, githubTeamSlug },
          after: {},
        },
        true
      ),
    ]);
    return deleted.meta.changes === 1;
  }

  /** Stamps every link of the team; the sync batches it with the membership changes. */
  bindMarkSynced(teamId: string, syncedAt: number): SqlStatement {
    return this.db
      .prepare("UPDATE team_github_links SET last_synced_at = ? WHERE team_id = ?")
      .bind(syncedAt, teamId);
  }
}
