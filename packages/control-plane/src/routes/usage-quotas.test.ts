import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import type { SqlDatabase } from "../db/sql-database";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { usageQuotaSchema } from "@open-inspect/shared/types/usage-quotas";
import { usageQuotaRoutes } from "./usage-quotas";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([usageQuotaRoutes]);
const FIXED_NOW = Date.UTC(2026, 2, 10, 12);

describe("usage quota routes", () => {
  let store: NodeSqlDatabase;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    store = createNodeSqlDatabase(sqlite);
    for (const userId of ["owner-1", "member-1", "alice"]) {
      await store
        .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)")
        .bind(userId, userId)
        .run();
    }
    await store
      .prepare(
        "INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('session-alice', 'alice', 1, 1)"
      )
      .run();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: request.headers.get("x-test-user") ?? "owner-1" },
      request,
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  /** Admission answers from the fake; every other statement reaches the real store. */
  function envFor(role: "owner" | "member") {
    const DB: SqlDatabase = authorizationDatabase({
      userId: role === "owner" ? "owner-1" : "member-1",
      permissions: role === "member" ? ["sessions.create", "sessions.read"] : undefined,
      statement: (sql) => store.prepare(sql),
      batch: (statements) => store.batch(statements),
    });
    return createTestEnv({ ...TEST_SERVICE_SECRETS, DB });
  }

  function call(role: "owner" | "member", method: string, path: string, body?: unknown) {
    return handleRequest(
      new Request(`https://test.local${path}`, {
        method,
        headers: {
          "x-test-user": role === "owner" ? "owner-1" : "member-1",
          "x-request-id": `req-${method}-${path}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      envFor(role),
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  it("lets an Owner upsert, list, read usage for and delete a quota, auditing each change", async () => {
    const created = await call("owner", "PUT", "/usage-quotas", {
      scopeKind: "user",
      scopeId: "alice",
      period: "day",
      maxTurns: 3,
    });
    expect(created.status).toBe(200);
    const quota = usageQuotaSchema.parse(await created.json());
    expect(quota).toEqual({
      id: expect.stringMatching(/^quota_/),
      scopeKind: "user",
      scopeId: "alice",
      period: "day",
      maxCostUsd: null,
      maxTurns: 3,
      maxTokens: null,
      maxRunningSandboxes: null,
      action: "block",
      createdBy: "owner-1",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });

    const listed = await call("owner", "GET", "/usage-quotas");
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ quotas: [quota] });

    await store
      .prepare(
        `INSERT INTO usage_ledger (message_id, session_id, user_id, cost_usd, input_tokens, output_tokens, settled_at)
         VALUES ('msg-1', 'session-alice', 'alice', 0.5, 100, 50, ?)`
      )
      .bind(FIXED_NOW - 60_000)
      .run();
    const usage = await call("owner", "GET", "/usage-quotas/usage/alice");
    expect(usage.status).toBe(200);
    await expect(usage.json()).resolves.toEqual({
      userId: "alice",
      runningSandboxes: 0,
      periods: [
        {
          period: "day",
          startAt: Date.UTC(2026, 2, 10),
          endAt: Date.UTC(2026, 2, 11),
          usage: { turns: 1, tokens: 150, costUsd: 0.5 },
          quota,
        },
        {
          period: "month",
          startAt: Date.UTC(2026, 2, 1),
          endAt: Date.UTC(2026, 3, 1),
          usage: { turns: 1, tokens: 150, costUsd: 0.5 },
          quota: null,
        },
      ],
    });

    expect((await call("owner", "DELETE", `/usage-quotas/${quota.id}`)).status).toBe(204);
    expect((await call("owner", "DELETE", `/usage-quotas/${quota.id}`)).status).toBe(404);
    const audit = await store
      .prepare(
        "SELECT action, actor_user_id_snapshot, resource_type, resource_id FROM authorization_audit_events WHERE action = 'budget.quota_changed' ORDER BY occurred_at, id"
      )
      .all();
    expect(audit.results).toEqual([
      {
        action: "budget.quota_changed",
        actor_user_id_snapshot: "owner-1",
        resource_type: "usage_quota",
        resource_id: quota.id,
      },
      {
        action: "budget.quota_changed",
        actor_user_id_snapshot: "owner-1",
        resource_type: "usage_quota",
        resource_id: quota.id,
      },
    ]);
  });

  it("rejects a quota without a limit or with a scope id on the workspace", async () => {
    const noLimit = await call("owner", "PUT", "/usage-quotas", {
      scopeKind: "user",
      scopeId: "alice",
    });
    expect(noLimit.status).toBe(400);
    await expect(noLimit.json()).resolves.toEqual({ error: "maxTurns: Set at least one limit" });
    const scoped = await call("owner", "PUT", "/usage-quotas", {
      scopeKind: "workspace",
      scopeId: "x",
      maxRunningSandboxes: 2,
    });
    expect(scoped.status).toBe(400);
    await expect(scoped.json()).resolves.toEqual({
      error: "scopeId: A workspace quota has no scopeId",
    });
  });

  it("answers a Member with 403 on every route and writes nothing", async () => {
    for (const [method, path, body] of [
      ["GET", "/usage-quotas", undefined],
      ["PUT", "/usage-quotas", { scopeKind: "workspace", maxTurns: 1 }],
      ["DELETE", "/usage-quotas/quota_1", undefined],
      ["GET", "/usage-quotas/usage/member-1", undefined],
    ] as const) {
      const response = await call("member", method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Forbidden",
        code: "permission_required",
        permission: "usage_quotas.manage",
      });
    }
    expect((await store.prepare("SELECT COUNT(*) AS count FROM usage_quotas").first())?.count).toBe(
      0
    );
  });
});
