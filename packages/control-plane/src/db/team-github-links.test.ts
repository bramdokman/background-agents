import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { TeamGitHubLinkStore } from "./team-github-links";
import { TeamStore } from "./teams";

const actor = { requestId: "link-request", actorUserId: "owner" };

describe("TeamGitHubLinkStore", () => {
  let db: NodeSqlDatabase;
  let store: TeamGitHubLinkStore;
  let teamId: string;

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    store = new TeamGitHubLinkStore(db);
    teamId = (
      await new TeamStore(db).create({
        slug: "eng",
        name: "Engineering",
        joinPolicy: "invite_only",
      })
    ).id;
  });
  afterEach(() => db.close());

  const auditActions = async () =>
    (
      await db
        .prepare(
          "SELECT action, target_user_id_snapshot AS target FROM authorization_audit_events WHERE team_id = ? ORDER BY occurred_at, id"
        )
        .bind(teamId)
        .all()
    ).results
      .map((row) => row.action)
      .sort();

  it("creates a link once, audited once, and lists it unsynced", async () => {
    const input = { githubOrg: "acme", githubTeamSlug: "platform" };
    const first = await store.add(teamId, input, actor);
    expect(first).toEqual({
      created: true,
      link: { teamId, ...input, createdAt: expect.any(Number), lastSyncedAt: null },
    });
    expect(await store.add(teamId, input, actor)).toEqual({ created: false, link: first.link });
    expect(await store.listForTeam(teamId)).toEqual([first.link]);
    expect(await auditActions()).toEqual(["team.github_link_added"]);
  });

  it("validates the request before writing", async () => {
    await expect(
      store.add(teamId, { githubOrg: "acme/evil", githubTeamSlug: "platform" }, actor)
    ).rejects.toThrow();
    await expect(
      store.add(teamId, { githubOrg: "acme", githubTeamSlug: "Platform Team" }, actor)
    ).rejects.toThrow();
    expect(await store.listForTeam(teamId)).toEqual([]);
  });

  it("removes only the named link and audits only an actual removal", async () => {
    await store.add(teamId, { githubOrg: "acme", githubTeamSlug: "platform" }, actor);
    await store.add(teamId, { githubOrg: "acme", githubTeamSlug: "security" }, actor);
    expect(await store.remove(teamId, "acme", "platform", actor)).toBe(true);
    expect(await store.remove(teamId, "acme", "platform", actor)).toBe(false);
    expect((await store.listForTeam(teamId)).map((link) => link.githubTeamSlug)).toEqual([
      "security",
    ]);
    expect(await auditActions()).toEqual([
      "team.github_link_added",
      "team.github_link_added",
      "team.github_link_removed",
    ]);
  });

  it("lists every link of a team with a due link, skipping archived teams", async () => {
    const other = await new TeamStore(db).create({ slug: "ops", name: "Ops", joinPolicy: "open" });
    await store.add(teamId, { githubOrg: "acme", githubTeamSlug: "platform" }, actor);
    await store.add(teamId, { githubOrg: "acme", githubTeamSlug: "security" }, actor);
    await store.add(other.id, { githubOrg: "acme", githubTeamSlug: "ops" }, actor);

    const dueSlugs = async (staleBefore: number) =>
      (await store.listDue(staleBefore)).map((link) => link.githubTeamSlug).sort();
    expect(await dueSlugs(1_000)).toEqual(["ops", "platform", "security"]);
    await db.batch([store.bindMarkSynced(teamId, 2_000)]);
    expect(await dueSlugs(1_000)).toEqual(["ops"]);
    expect(await dueSlugs(2_000)).toEqual(["ops", "platform", "security"]);
    await new TeamStore(db).archive(other.id);
    expect(await dueSlugs(1_000)).toEqual([]);
  });

  it("drops links with their team", async () => {
    await store.add(teamId, { githubOrg: "acme", githubTeamSlug: "platform" }, actor);
    await db.prepare("DELETE FROM teams WHERE id = ?").bind(teamId).run();
    expect(await store.listForTeam(teamId)).toEqual([]);
  });
});
