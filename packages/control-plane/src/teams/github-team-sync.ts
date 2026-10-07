/**
 * Mirrors GitHub organization teams into Open-Inspect teams.
 *
 * Each `team_github_links` row names a GitHub team; the sync lists its members
 * through the GitHub App installation and reconciles the Open-Inspect team's
 * `github_team`-sourced memberships against the union over the team's links:
 * members who are known users (by GitHub identity) and not yet on the team are
 * added, synced members no longer in any linked GitHub team are removed, and
 * memberships with any other source are never touched. A second run over the
 * same state changes nothing.
 *
 * The sync rides the every-minute scheduler tick and gates itself on each
 * link's `last_synced_at`, so the interval is a deployment setting rather than
 * a cron expression, and a deployment without links costs one indexed read a
 * minute. A team whose GitHub listing fails is skipped whole: a partial
 * listing must never remove members.
 */

import { resolveAppName } from "@open-inspect/shared/app-name";
import type { CacheStore } from "@open-inspect/shared/cache-store";
import { z } from "zod";
import {
  fetchWithTimeout,
  getCachedInstallationToken,
  getGitHubAppConfig,
  getInstallationTokenCacheKey,
  invalidateInstallationTokenCache,
  type GitHubAppConfig,
} from "../auth/github-app";
import { MAX_D1_QUERY_PARAMETERS } from "../db/query-limits";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import { TeamGitHubLinkStore } from "../db/team-github-links";
import { TeamMembershipStore } from "../db/team-memberships";
import type { Logger } from "../logger";
import type { Env, EnvConfig } from "../types";

/** How long a synced link stays fresh when `GITHUB_TEAM_SYNC_INTERVAL_MS` is unset. */
export const DEFAULT_GITHUB_TEAM_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** The sync's audit rows name it as their service actor; it acts for no user. */
const SYNC_ACTOR_SERVICE = "github-team-sync";

const GITHUB_TEAM_MEMBERS_PER_PAGE = 100;

export interface GitHubTeamMember {
  /** GitHub's numeric user id, the key `user_identities` stores for the `github` provider. */
  id: number;
  login: string;
}

/** The one GitHub call the sync makes; the production client goes through the App installation. */
export interface GitHubTeamMembersClient {
  listTeamMembers(githubOrg: string, githubTeamSlug: string): Promise<GitHubTeamMember[]>;
}

/** What one team's reconcile did; user ids are Open-Inspect users. */
export interface TeamGitHubSyncResult {
  teamId: string;
  /** The GitHub teams reconciled against, as `org/slug`. */
  githubTeams: string[];
  addedUserIds: string[];
  removedUserIds: string[];
  /** GitHub members with no Open-Inspect identity; they join once they sign in. */
  unmatchedGitHubUserIds: string[];
}

export function parseGitHubTeamSyncIntervalMs(
  env: Pick<EnvConfig, "GITHUB_TEAM_SYNC_INTERVAL_MS">
): number {
  const raw = env.GITHUB_TEAM_SYNC_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_GITHUB_TEAM_SYNC_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid GITHUB_TEAM_SYNC_INTERVAL_MS: ${raw}`);
  }
  return parsed;
}

const githubTeamMembersSchema = z.array(z.object({ id: z.number().int(), login: z.string() }));

/** Lists a GitHub team's members with the App installation token, retrying once on a stale token. */
export function createGitHubTeamMembersClient(
  config: GitHubAppConfig,
  tokenEnv: { cacheStore?: CacheStore; userAgent: string }
): GitHubTeamMembersClient {
  const scope = { kind: "all" } as const;
  const fetchPage = async (url: string, forceRefresh: boolean): Promise<Response> => {
    const token = await getCachedInstallationToken(config, tokenEnv, { scope, forceRefresh });
    return fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": tokenEnv.userAgent,
      },
    });
  };
  return {
    async listTeamMembers(githubOrg, githubTeamSlug) {
      const members: GitHubTeamMember[] = [];
      const base = `https://api.github.com/orgs/${encodeURIComponent(githubOrg)}/teams/${encodeURIComponent(githubTeamSlug)}/members`;
      for (let page = 1; ; page++) {
        const url = `${base}?per_page=${GITHUB_TEAM_MEMBERS_PER_PAGE}&page=${page}`;
        let response = await fetchPage(url, false);
        if (response.status === 401) {
          await invalidateInstallationTokenCache(
            tokenEnv,
            await getInstallationTokenCacheKey(config, scope)
          );
          response = await fetchPage(url, true);
        }
        if (!response.ok) {
          throw new Error(
            `Failed to list GitHub team ${githubOrg}/${githubTeamSlug} members: ${response.status} ${await response.text()}`
          );
        }
        const parsed = githubTeamMembersSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new Error(
            `Failed to list GitHub team ${githubOrg}/${githubTeamSlug} members: invalid response`
          );
        }
        members.push(...parsed.data);
        if (parsed.data.length < GITHUB_TEAM_MEMBERS_PER_PAGE) return members;
      }
    },
  };
}

export class GitHubTeamSync {
  private readonly links: TeamGitHubLinkStore;
  private readonly memberships: TeamMembershipStore;

  constructor(
    private readonly db: SqlDatabase,
    private readonly github: GitHubTeamMembersClient,
    private readonly log: Logger
  ) {
    this.links = new TeamGitHubLinkStore(db);
    this.memberships = new TeamMembershipStore(db);
  }

  /** Reconciles every active team with a link older than `intervalMs`, one team at a time. */
  async run(nowMs: number, intervalMs: number, requestId: string): Promise<TeamGitHubSyncResult[]> {
    const due = await this.links.listDue(nowMs - intervalMs);
    const byTeam = new Map<string, { githubOrg: string; githubTeamSlug: string }[]>();
    for (const link of due) {
      byTeam.set(link.teamId, [...(byTeam.get(link.teamId) ?? []), link]);
    }
    const results: TeamGitHubSyncResult[] = [];
    for (const [teamId, links] of byTeam) {
      try {
        results.push(await this.reconcileTeam(teamId, links, nowMs, requestId));
      } catch (error) {
        this.log.warn("github_team_sync.team_skipped", {
          team_id: teamId,
          request_id: requestId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return results;
  }

  /** Reconciles one team against the union of its linked GitHub teams' current members. */
  async reconcileTeam(
    teamId: string,
    links: readonly { githubOrg: string; githubTeamSlug: string }[],
    nowMs: number,
    requestId: string
  ): Promise<TeamGitHubSyncResult> {
    const githubUserIds = new Set<string>();
    for (const { githubOrg, githubTeamSlug } of links) {
      for (const member of await this.github.listTeamMembers(githubOrg, githubTeamSlug)) {
        githubUserIds.add(String(member.id));
      }
    }
    const identities = await this.resolveGitHubIdentities([...githubUserIds]);
    const desiredUserIds = new Set(identities.values());
    const current = await this.memberships.listMembers(teamId);
    const currentUserIds = new Set(current.map((member) => member.userId));
    const syncedBefore = current.filter((member) => member.source === "github_team");

    const toAdd = [...desiredUserIds].filter((userId) => !currentUserIds.has(userId)).sort();
    const toRemove = syncedBefore.filter((member) => !desiredUserIds.has(member.userId));
    const githubTeams = links.map((link) => `${link.githubOrg}/${link.githubTeamSlug}`);
    const audit = (userId: string, before: unknown, after: unknown) =>
      this.bindAudit(teamId, userId, requestId, {
        before,
        requested: {},
        after,
        githubTeams,
        syncedCountBefore: syncedBefore.length,
        syncedCountAfter: syncedBefore.length + toAdd.length - toRemove.length,
      });

    const statements: SqlStatement[] = [];
    for (const userId of toAdd) {
      const row = { teamId, userId, role: "member", source: "github_team", createdAt: nowMs };
      statements.push(
        this.db
          .prepare(
            `INSERT INTO team_memberships (team_id, user_id, role, source, created_at)
             VALUES (?, ?, 'member', 'github_team', ?) ON CONFLICT DO NOTHING`
          )
          .bind(teamId, userId, nowMs),
        audit(userId, {}, row)
      );
    }
    for (const member of toRemove) {
      // The last lead stays, as in TeamMembershipStore.remove; a lead or admin resolves it.
      statements.push(
        this.db
          .prepare(
            `DELETE FROM team_memberships WHERE team_id = ? AND user_id = ? AND source = 'github_team'
             AND (role != 'lead' OR (SELECT COUNT(*) FROM team_memberships WHERE team_id = ? AND role = 'lead') > 1)`
          )
          .bind(teamId, member.userId, teamId),
        audit(member.userId, member, {})
      );
    }
    statements.push(this.links.bindMarkSynced(teamId, nowMs));
    const results = await this.db.batch(statements);

    // Every mutation sits at an even index, followed by its audit row.
    const applied = (index: number) => results[index * 2]!.meta.changes === 1;
    const result: TeamGitHubSyncResult = {
      teamId,
      githubTeams,
      addedUserIds: toAdd.filter((_, index) => applied(index)),
      removedUserIds: toRemove
        .filter((_, index) => applied(toAdd.length + index))
        .map((member) => member.userId),
      unmatchedGitHubUserIds: [...githubUserIds].filter((id) => !identities.has(id)).sort(),
    };
    if (result.addedUserIds.length > 0 || result.removedUserIds.length > 0) {
      this.log.info("github_team_sync.team_reconciled", {
        team_id: teamId,
        request_id: requestId,
        github_teams: githubTeams,
        added: result.addedUserIds.length,
        removed: result.removedUserIds.length,
        unmatched: result.unmatchedGitHubUserIds.length,
      });
    }
    return result;
  }

  /** GitHub user id → Open-Inspect user id, for the ids that have a `github` identity. */
  private async resolveGitHubIdentities(
    githubUserIds: readonly string[]
  ): Promise<ReadonlyMap<string, string>> {
    const resolved = new Map<string, string>();
    for (let start = 0; start < githubUserIds.length; start += MAX_D1_QUERY_PARAMETERS) {
      const chunk = githubUserIds.slice(start, start + MAX_D1_QUERY_PARAMETERS);
      const rows = await this.db
        .prepare(
          `SELECT user_id, provider_user_id FROM user_identities
           WHERE provider = 'github' AND provider_user_id IN (${chunk.map(() => "?").join(", ")})`
        )
        .bind(...chunk)
        .all<{ user_id: string; provider_user_id: string }>();
      for (const row of rows.results) resolved.set(row.provider_user_id, row.user_id);
    }
    return resolved;
  }

  /** The audit row for the mutation immediately before it in the batch, written only when that applied. */
  private bindAudit(
    teamId: string,
    userId: string,
    requestId: string,
    metadata: Record<string, unknown>
  ): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot, actor_service_snapshot,
           action, resource_type, resource_id, target_user_id_snapshot, team_id,
           reason_code, operation_result, metadata_json)
         SELECT ?, ?, ?, 'service', NULL, ?, 'team.github_sync_changed', 'team', ?, ?, ?,
                'team.github_sync_changed', 'applied', ?
         WHERE changes() = 1`
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        requestId,
        SYNC_ACTOR_SERVICE,
        teamId,
        userId,
        teamId,
        JSON.stringify(metadata)
      );
  }
}

/** The scheduled entry point: nothing to do without GitHub App credentials or due links. */
export async function runGitHubTeamSync(
  env: Env,
  db: SqlDatabase,
  log: Logger,
  nowMs: number,
  requestId: string
): Promise<TeamGitHubSyncResult[]> {
  const config = getGitHubAppConfig(env);
  if (!config) return [];
  const client = createGitHubTeamMembersClient(config, {
    cacheStore: env.REPOS_CACHE,
    userAgent: resolveAppName(env),
  });
  return new GitHubTeamSync(db, client, log).run(
    nowMs,
    parseGitHubTeamSyncIntervalMs(env),
    requestId
  );
}
