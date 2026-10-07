import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { permissionsForBuiltInRole } from "@open-inspect/shared/rbac";
import type * as AuthenticateModule from "../auth/authenticate";
import type { SqlDatabase } from "../db/sql-database";
import { TeamStore } from "../db/teams";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  authorizationDatabase,
  type AuthorizationDatabaseOptions,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
  TEST_USER_ID,
} from "../router.test-support";
import { teamGitHubLinkRoutes } from "./team-github-links";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([teamGitHubLinkRoutes]);
const body = { githubOrg: "acme", githubTeamSlug: "platform" };

describe("team GitHub link routes", () => {
  let sqlite: NodeSqlDatabase;
  let teamId: string;

  /** Admission's role lookup answers for the viewer; every other statement reaches SQLite. */
  const viewerDatabase = (permissions?: AuthorizationDatabaseOptions["permissions"]): SqlDatabase =>
    authorizationDatabase({
      permissions,
      statement: (sql) => sqlite.prepare(sql),
      batch: (statements) => sqlite.batch(statements),
    });
  const call = (db: SqlDatabase, method: string, path: string, json?: unknown) =>
    handleRequest(
      new Request(`https://test.local${path}`, {
        method,
        ...(json === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }),
      }),
      createTestEnv({ ...TEST_SERVICE_SECRETS, DB: db }),
      TEST_BACKGROUND_TASK_CONTEXT
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: TEST_USER_ID },
      request,
    }));
    const raw = new DatabaseSync(":memory:");
    applyMigrations(
      raw,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    sqlite = createNodeSqlDatabase(raw);
    teamId = (
      await new TeamStore(sqlite).create({ slug: "eng", name: "Engineering", joinPolicy: "open" })
    ).id;
  });
  afterEach(() => sqlite.close());

  it("lets an Owner create, list and delete a link, each audited", async () => {
    const owner = viewerDatabase();
    const created = await call(owner, "POST", `/teams/${teamId}/github-links`, body);
    expect(created.status).toBe(201);
    const link = { teamId, ...body, createdAt: expect.any(Number), lastSyncedAt: null };
    expect(await created.json()).toEqual({ link });

    const repeated = await call(owner, "POST", `/teams/${teamId}/github-links`, body);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ link });

    const listed = await call(owner, "GET", `/teams/${teamId}/github-links`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ links: [link] });

    const deleted = await call(owner, "DELETE", `/teams/${teamId}/github-links/acme/platform`);
    expect(deleted.status).toBe(204);
    expect(
      (await call(owner, "DELETE", `/teams/${teamId}/github-links/acme/platform`)).status
    ).toBe(404);
    expect(await (await call(owner, "GET", `/teams/${teamId}/github-links`)).json()).toEqual({
      links: [],
    });

    const audit = await sqlite
      .prepare(
        "SELECT action, actor_user_id_snapshot AS actor FROM authorization_audit_events WHERE team_id = ? AND action LIKE 'team.github_link_%' ORDER BY occurred_at, id"
      )
      .bind(teamId)
      .all();
    expect(audit.results).toEqual([
      { action: "team.github_link_added", actor: TEST_USER_ID },
      { action: "team.github_link_removed", actor: TEST_USER_ID },
    ]);
  });

  it("rejects a malformed link and an unknown team", async () => {
    const owner = viewerDatabase();
    const invalid = await call(owner, "POST", `/teams/${teamId}/github-links`, {
      githubOrg: "acme/evil",
      githubTeamSlug: "platform",
    });
    expect(invalid.status).toBe(400);
    expect((await call(owner, "GET", "/teams/team_missing/github-links")).status).toBe(404);
    expect(await (await call(owner, "GET", `/teams/${teamId}/github-links`)).json()).toEqual({
      links: [],
    });
  });

  it("refuses a Member, even one who leads the team", async () => {
    await sqlite
      .prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)")
      .bind(TEST_USER_ID)
      .run();
    await sqlite
      .prepare(
        "INSERT INTO team_memberships (team_id, user_id, role, source, created_at) VALUES (?, ?, 'lead', 'manual', 1)"
      )
      .bind(teamId, TEST_USER_ID)
      .run();
    const member = viewerDatabase(permissionsForBuiltInRole("member"));
    for (const [method, path, json] of [
      ["GET", `/teams/${teamId}/github-links`],
      ["POST", `/teams/${teamId}/github-links`, body],
      ["DELETE", `/teams/${teamId}/github-links/acme/platform`],
    ] as const) {
      const response = await call(member, method, path, json);
      expect(response.status).toBe(403);
    }
    expect(
      (await sqlite.prepare("SELECT COUNT(*) AS count FROM team_github_links").first())?.count
    ).toBe(0);
  });
});
