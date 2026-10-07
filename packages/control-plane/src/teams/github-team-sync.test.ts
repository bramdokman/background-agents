import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { TeamGitHubLinkStore } from "../db/team-github-links";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamStore } from "../db/teams";
import { UserStore } from "../db/user-store";
import {
  DEFAULT_GITHUB_TEAM_SYNC_INTERVAL_MS,
  GitHubTeamSync,
  createGitHubTeamMembersClient,
  parseGitHubTeamSyncIntervalMs,
  type GitHubTeamMember,
} from "./github-team-sync";

vi.mock("../auth/github-app", () => ({
  fetchWithTimeout: vi.fn(),
  getCachedInstallationToken: vi.fn(async () => "installation-token"),
  getGitHubAppConfig: vi.fn(() => null),
  getInstallationTokenCacheKey: vi.fn(async () => "cache-key"),
  invalidateInstallationTokenCache: vi.fn(async () => {}),
}));

const NOW = 1_700_000_000_000;
const REQUEST_ID = "sync-request-1";
const link = { githubOrg: "acme", githubTeamSlug: "platform" };
const actor = { requestId: "link-request", actorUserId: "owner" };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

/** A GitHub whose team rosters the test sets; unknown teams fail like a 404 would. */
function fakeGitHub(rosters: Record<string, GitHubTeamMember[]>) {
  return {
    listTeamMembers: vi.fn(async (org: string, slug: string) => {
      const members = rosters[`${org}/${slug}`];
      if (!members) throw new Error(`Failed to list GitHub team ${org}/${slug} members: 404`);
      return members;
    }),
  };
}

describe("GitHubTeamSync", () => {
  let db: NodeSqlDatabase;
  let teamId: string;
  let links: TeamGitHubLinkStore;
  let memberships: TeamMembershipStore;
  /** Open-Inspect users keyed by their GitHub login; `ada` is GitHub id 1, and so on. */
  const users: Record<string, string> = {};

  const githubUser = (login: string, id: number): GitHubTeamMember => ({ id, login });
  const roster = async () =>
    (await memberships.listMembers(teamId))
      .map(({ userId, role, source }) => ({ userId, role, source }))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  const sorted = <T extends { userId: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => a.userId.localeCompare(b.userId));
  const auditRows = async () =>
    (
      await db
        .prepare(
          `SELECT action, request_id, principal_kind, actor_user_id_snapshot, actor_service_snapshot,
                  target_user_id_snapshot, team_id, operation_result, metadata_json
           FROM authorization_audit_events WHERE action = 'team.github_sync_changed'
           ORDER BY occurred_at, target_user_id_snapshot`
        )
        .all()
    ).results.map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json as string) }));

  beforeEach(async () => {
    vi.clearAllMocks();
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    links = new TeamGitHubLinkStore(db);
    memberships = new TeamMembershipStore(db);
    const userStore = new UserStore(db);
    for (const [index, login] of ["ada", "bob", "cy", "dee"].entries()) {
      const user = await userStore.createUser({ displayName: login });
      await userStore.createIdentity({
        userId: user.id,
        provider: "github",
        providerUserId: String(index + 1),
        providerLogin: login,
      });
      users[login] = user.id;
    }
    teamId = (
      await new TeamStore(db).createWithLead(
        { slug: "eng", name: "Engineering", joinPolicy: "invite_only" },
        users.ada!,
        "create-request"
      )
    ).id;
    await links.add(teamId, link, actor);
  });
  afterEach(() => db.close());

  it("adds synced memberships for GitHub members who are known users, once", async () => {
    const github = fakeGitHub({
      "acme/platform": [githubUser("ada", 1), githubUser("bob", 2), githubUser("zed", 99)],
    });
    const sync = new GitHubTeamSync(db, github, log);

    const [first] = await sync.run(NOW, DEFAULT_GITHUB_TEAM_SYNC_INTERVAL_MS, REQUEST_ID);

    expect(first).toEqual({
      teamId,
      githubTeams: ["acme/platform"],
      addedUserIds: [users.bob],
      removedUserIds: [],
      unmatchedGitHubUserIds: ["99"],
    });
    expect(await roster()).toEqual(
      sorted([
        { userId: users.ada!, role: "lead", source: "manual" },
        { userId: users.bob!, role: "member", source: "github_team" },
      ])
    );
    expect((await links.listForTeam(teamId))[0]?.lastSyncedAt).toBe(NOW);
    expect(await auditRows()).toEqual([
      {
        action: "team.github_sync_changed",
        request_id: REQUEST_ID,
        principal_kind: "service",
        actor_user_id_snapshot: null,
        actor_service_snapshot: "github-team-sync",
        target_user_id_snapshot: users.bob,
        team_id: teamId,
        operation_result: "applied",
        metadata_json: expect.any(String),
        metadata: {
          before: {},
          requested: {},
          after: {
            teamId,
            userId: users.bob,
            role: "member",
            source: "github_team",
            createdAt: NOW,
          },
          githubTeams: ["acme/platform"],
          syncedCountBefore: 0,
          syncedCountAfter: 1,
        },
      },
    ]);

    // Within the interval the link is fresh; past it, the same roster is a no-op.
    expect(await sync.run(NOW + 1_000, DEFAULT_GITHUB_TEAM_SYNC_INTERVAL_MS, "sync-2")).toEqual([]);
    expect(github.listTeamMembers).toHaveBeenCalledTimes(1);
    const later = NOW + DEFAULT_GITHUB_TEAM_SYNC_INTERVAL_MS;
    expect(await sync.run(later, DEFAULT_GITHUB_TEAM_SYNC_INTERVAL_MS, "sync-3")).toEqual([
      {
        teamId,
        githubTeams: ["acme/platform"],
        addedUserIds: [],
        removedUserIds: [],
        unmatchedGitHubUserIds: ["99"],
      },
    ]);
    expect(await roster()).toHaveLength(2);
    expect(await auditRows()).toHaveLength(1);
    expect((await links.listForTeam(teamId))[0]?.lastSyncedAt).toBe(later);
  });

  it("removes only github_team memberships that left GitHub and leaves manual rows alone", async () => {
    await memberships.add(teamId, users.bob!, "member", "github_team");
    await memberships.add(teamId, users.cy!, "member", "github_team");
    await memberships.add(teamId, users.dee!, "member", "manual");
    const github = fakeGitHub({ "acme/platform": [githubUser("cy", 3)] });

    const [result] = await new GitHubTeamSync(db, github, log).run(NOW, 1, REQUEST_ID);

    expect(result).toMatchObject({ addedUserIds: [], removedUserIds: [users.bob] });
    expect(await roster()).toEqual(
      sorted([
        { userId: users.ada!, role: "lead", source: "manual" },
        { userId: users.cy!, role: "member", source: "github_team" },
        { userId: users.dee!, role: "member", source: "manual" },
      ])
    );
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      target_user_id_snapshot: users.bob,
      metadata: {
        before: { teamId, userId: users.bob, role: "member", source: "github_team" },
        after: {},
        syncedCountBefore: 2,
        syncedCountAfter: 1,
      },
    });
    expect(await auditRows()).toHaveLength(1);
  });

  it("does not re-add a manual member and keeps a synced last lead", async () => {
    await memberships.add(teamId, users.bob!, "member", "manual");
    await db
      .prepare(
        "UPDATE team_memberships SET role = 'lead', source = 'github_team' WHERE user_id = ?"
      )
      .bind(users.ada)
      .run();
    const github = fakeGitHub({ "acme/platform": [githubUser("bob", 2)] });

    const [result] = await new GitHubTeamSync(db, github, log).run(NOW, 1, REQUEST_ID);

    expect(result).toMatchObject({ addedUserIds: [], removedUserIds: [] });
    expect(await roster()).toEqual(
      sorted([
        { userId: users.ada!, role: "lead", source: "github_team" },
        { userId: users.bob!, role: "member", source: "manual" },
      ])
    );
    expect(await auditRows()).toEqual([]);
  });

  it("reconciles against the union of a team's links", async () => {
    await links.add(teamId, { githubOrg: "acme", githubTeamSlug: "security" }, actor);
    await memberships.add(teamId, users.dee!, "member", "github_team");
    const github = fakeGitHub({
      "acme/platform": [githubUser("bob", 2)],
      "acme/security": [githubUser("cy", 3)],
    });

    const [result] = await new GitHubTeamSync(db, github, log).run(NOW, 1, REQUEST_ID);

    expect(result).toEqual({
      teamId,
      githubTeams: ["acme/platform", "acme/security"],
      addedUserIds: [users.bob, users.cy].sort(),
      removedUserIds: [users.dee],
      unmatchedGitHubUserIds: [],
    });
    expect((await links.listForTeam(teamId)).map((row) => row.lastSyncedAt)).toEqual([NOW, NOW]);
  });

  it("skips a team whose GitHub listing fails without removing anyone", async () => {
    await memberships.add(teamId, users.bob!, "member", "github_team");
    const other = await new TeamStore(db).create({ slug: "ops", name: "Ops", joinPolicy: "open" });
    await links.add(other.id, { githubOrg: "acme", githubTeamSlug: "ops" }, actor);
    const github = fakeGitHub({ "acme/ops": [githubUser("cy", 3)] });

    const results = await new GitHubTeamSync(db, github, log).run(NOW, 1, REQUEST_ID);

    expect(results).toEqual([
      {
        teamId: other.id,
        githubTeams: ["acme/ops"],
        addedUserIds: [users.cy],
        removedUserIds: [],
        unmatchedGitHubUserIds: [],
      },
    ]);
    expect(await roster()).toEqual(
      sorted([
        { userId: users.ada!, role: "lead", source: "manual" },
        { userId: users.bob!, role: "member", source: "github_team" },
      ])
    );
    expect((await links.listForTeam(teamId))[0]?.lastSyncedAt).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "github_team_sync.team_skipped",
      expect.objectContaining({ team_id: teamId, request_id: REQUEST_ID })
    );
  });
});

describe("parseGitHubTeamSyncIntervalMs", () => {
  it("defaults when unset and accepts a positive integer", () => {
    expect(parseGitHubTeamSyncIntervalMs({})).toBe(DEFAULT_GITHUB_TEAM_SYNC_INTERVAL_MS);
    expect(parseGitHubTeamSyncIntervalMs({ GITHUB_TEAM_SYNC_INTERVAL_MS: "" })).toBe(
      DEFAULT_GITHUB_TEAM_SYNC_INTERVAL_MS
    );
    expect(parseGitHubTeamSyncIntervalMs({ GITHUB_TEAM_SYNC_INTERVAL_MS: "60000" })).toBe(60_000);
  });

  it.each(["0", "-1", "soon", "1.5"])("rejects %s", (value) => {
    expect(() => parseGitHubTeamSyncIntervalMs({ GITHUB_TEAM_SYNC_INTERVAL_MS: value })).toThrow(
      "Invalid GITHUB_TEAM_SYNC_INTERVAL_MS"
    );
  });
});

describe("createGitHubTeamMembersClient", () => {
  const config = { appId: "1", privateKey: "key", installationId: "2" };

  it("pages the installation-authenticated members listing and retries once on 401", async () => {
    const { fetchWithTimeout, getCachedInstallationToken, invalidateInstallationTokenCache } =
      await import("../auth/github-app");
    const page = (members: GitHubTeamMember[], status = 200) =>
      new Response(JSON.stringify(members), { status });
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(
        page(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, login: `u${i + 1}` })))
      )
      .mockResolvedValueOnce(page([{ id: 101, login: "u101" }]));

    const members = await createGitHubTeamMembersClient(config, {
      userAgent: "test-agent",
    }).listTeamMembers("acme", "platform");

    expect(members).toHaveLength(101);
    expect(members.at(-1)).toEqual({ id: 101, login: "u101" });
    expect(invalidateInstallationTokenCache).toHaveBeenCalledOnce();
    expect(getCachedInstallationToken).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ userAgent: "test-agent" }),
      { scope: { kind: "all" }, forceRefresh: true }
    );
    const urls = vi.mocked(fetchWithTimeout).mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      "https://api.github.com/orgs/acme/teams/platform/members?per_page=100&page=1",
      "https://api.github.com/orgs/acme/teams/platform/members?per_page=100&page=1",
      "https://api.github.com/orgs/acme/teams/platform/members?per_page=100&page=2",
    ]);
    expect(vi.mocked(fetchWithTimeout).mock.calls[2]![1]).toEqual({
      headers: expect.objectContaining({
        Authorization: "Bearer installation-token",
        "User-Agent": "test-agent",
      }),
    });
  });

  it("fails on a non-OK status and on an unexpected body", async () => {
    const { fetchWithTimeout } = await import("../auth/github-app");
    const client = createGitHubTeamMembersClient(config, { userAgent: "test-agent" });
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(new Response("nope", { status: 404 }));
    await expect(client.listTeamMembers("acme", "gone")).rejects.toThrow(
      "Failed to list GitHub team acme/gone members: 404 nope"
    );
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(new Response(JSON.stringify({ x: 1 })));
    await expect(client.listTeamMembers("acme", "odd")).rejects.toThrow("invalid response");
  });
});
