import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { UsageLedgerStore, type SettledTurn } from "../db/usage-ledger";
import { UsageQuotaStore } from "../db/usage-quotas";
import { UsageQuotaExceededError, UsageQuotaService } from "./usage-quotas";

/** 2026-03-10T22:00:00Z: two hours before a UTC day boundary. */
const NOW = Date.UTC(2026, 2, 10, 22);
const DAY_MS = 86_400_000;
const ACTOR = { actorUserId: "owner-1", requestId: "req-1" };

describe("usage quotas", () => {
  let db: NodeSqlDatabase;
  let now: number;
  let quotas: UsageQuotaStore;
  let ledger: UsageLedgerStore;
  let service: UsageQuotaService;

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    now = NOW;
    quotas = new UsageQuotaStore(db);
    ledger = new UsageLedgerStore(db);
    service = new UsageQuotaService(db, () => now);
    await db
      .prepare(
        "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-platform', 'platform', 'Platform', 1, 1)"
      )
      .run();
    for (const userId of ["alice", "bob", "owner-1"]) {
      await db
        .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)")
        .bind(userId, userId)
        .run();
    }
    await seedSession("session-alice", "alice", "team-platform");
    await seedSession("session-alice-2", "alice", null);
    await seedSession("session-alice-3", "alice", null);
    await seedSession("session-bob", "bob", "team-platform");
    await seedSession("session-bob-2", "bob", null);
  });
  afterEach(() => db.close());

  function seedSession(id: string, userId: string, teamId: string | null) {
    return db
      .prepare(
        "INSERT INTO sessions (id, user_id, owner_team_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)"
      )
      .bind(id, userId, teamId)
      .run();
  }

  function turn(messageId: string, overrides: Partial<SettledTurn> = {}): SettledTurn {
    return {
      messageId,
      sessionId: "session-alice",
      userId: "alice",
      repoExternalId: 42,
      harness: "opencode",
      model: "anthropic/claude-sonnet-4-5",
      costUsd: 0.25,
      inputTokens: 1000,
      outputTokens: 500,
      settledAt: now,
      ...overrides,
    };
  }

  async function settleTurns(count: number, overrides: Partial<SettledTurn> = {}) {
    for (let i = 0; i < count; i++) {
      await ledger.recordTurn(turn(`${overrides.userId ?? "alice"}-msg-${i}`, overrides));
    }
  }

  async function auditRows(action: string) {
    const rows = await db
      .prepare(
        `SELECT actor_user_id_snapshot, resource_type, resource_id, target_user_id_snapshot, team_id, metadata_json
         FROM authorization_audit_events WHERE action = ? ORDER BY occurred_at, id`
      )
      .bind(action)
      .all();
    return rows.results;
  }

  const dayWindow = () => ({
    period: "day" as const,
    startAt: NOW - 22 * 3_600_000,
    endAt: NOW + 2 * 3_600_000,
  });

  it("writes one ledger row per settled turn and leaves totals unchanged on replay", async () => {
    await ledger.recordTurn(turn("msg-1"));
    await ledger.recordTurn(turn("msg-1"));
    await ledger.recordTurn(turn("msg-1", { settledAt: now + 5_000 }));

    expect(await ledger.sumForScope({ kind: "user", id: "alice" }, dayWindow())).toEqual({
      turns: 1,
      tokens: 1500,
      costUsd: 0.25,
    });
    const row = await db.prepare("SELECT * FROM usage_ledger").first();
    expect(row).toMatchObject({
      message_id: "msg-1",
      session_id: "session-alice",
      user_id: "alice",
      team_id: "team-platform",
      repo_external_id: 42,
      harness: "opencode",
      model: "anthropic/claude-sonnet-4-5",
      cost_usd: 0.25,
      input_tokens: 1000,
      output_tokens: 500,
      settled_at: NOW,
    });
  });

  it("sums the team and the workspace from the same rows", async () => {
    await settleTurns(2);
    await settleTurns(1, { userId: "bob", sessionId: "session-bob-2", costUsd: 1 });

    expect(await ledger.sumForScope({ kind: "team", id: "team-platform" }, dayWindow())).toEqual({
      turns: 2,
      tokens: 3000,
      costUsd: 0.5,
    });
    expect(await ledger.sumForScope({ kind: "workspace", id: null }, dayWindow())).toEqual({
      turns: 3,
      tokens: 4500,
      costUsd: 1.5,
    });
  });

  it("upserts one row per scope and period, audits it, and deletes it", async () => {
    const created = await quotas.upsert(
      {
        scopeKind: "user",
        scopeId: "alice",
        period: "day",
        maxTurns: 3,
        maxCostUsd: null,
        maxTokens: null,
        maxRunningSandboxes: null,
        action: "block",
      },
      ACTOR
    );
    const replaced = await quotas.upsert(
      {
        scopeKind: "user",
        scopeId: "alice",
        period: "day",
        maxTurns: 5,
        maxCostUsd: 2,
        maxTokens: null,
        maxRunningSandboxes: null,
        action: "warn",
      },
      ACTOR
    );
    expect(replaced).toMatchObject({
      id: created.id,
      maxTurns: 5,
      maxCostUsd: 2,
      action: "warn",
      createdBy: "owner-1",
    });
    expect(await quotas.list()).toEqual([replaced]);
    expect(await auditRows("budget.quota_changed")).toMatchObject([
      { resource_type: "usage_quota", resource_id: created.id, target_user_id_snapshot: "alice" },
      { resource_type: "usage_quota", resource_id: created.id, target_user_id_snapshot: "alice" },
    ]);

    expect(await quotas.remove(created.id, ACTOR)).toBe(true);
    expect(await quotas.remove(created.id, ACTOR)).toBe(false);
    expect(await quotas.list()).toEqual([]);
    expect(await auditRows("budget.quota_changed")).toHaveLength(3);
  });

  it("stores the workspace scope under an empty scope id so the upsert key holds", async () => {
    await quotas.upsert(
      {
        scopeKind: "workspace",
        scopeId: null,
        period: "month",
        maxTurns: 100,
        maxCostUsd: null,
        maxTokens: null,
        maxRunningSandboxes: null,
        action: "block",
      },
      ACTOR
    );
    await quotas.upsert(
      {
        scopeKind: "workspace",
        scopeId: null,
        period: "month",
        maxTurns: 200,
        maxCostUsd: null,
        maxTokens: null,
        maxRunningSandboxes: null,
        action: "block",
      },
      ACTOR
    );
    const rows = await quotas.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeKind: "workspace", scopeId: null, maxTurns: 200 });
  });

  it("allows everything when no quota rows exist", async () => {
    await settleTurns(50);
    await expect(service.admitPrompt(subject("alice"))).resolves.toEqual({ kind: "allow" });
    expect(await auditRows("budget.blocked")).toEqual([]);
  });

  it("blocks the fourth prompt of a user with max_turns=3/day and audits it, leaving another user unaffected", async () => {
    await quotas.upsert(
      {
        scopeKind: "user",
        scopeId: "alice",
        period: "day",
        maxTurns: 3,
        maxCostUsd: null,
        maxTokens: null,
        maxRunningSandboxes: null,
        action: "block",
      },
      ACTOR
    );
    await settleTurns(2);
    await expect(service.admitPrompt(subject("alice"))).resolves.toEqual({ kind: "allow" });

    await ledger.recordTurn(turn("alice-msg-third"));
    const blocked = service.admitPrompt(subject("alice"));
    await expect(blocked).rejects.toBeInstanceOf(UsageQuotaExceededError);
    await expect(blocked).rejects.toThrow(
      "Usage quota reached: you used 3 of 3 turns today. The window resets at the next UTC day boundary."
    );
    expect(await auditRows("budget.blocked")).toMatchObject([
      {
        actor_user_id_snapshot: "alice",
        resource_type: "session",
        resource_id: "session-alice",
        target_user_id_snapshot: "alice",
        team_id: "team-platform",
      },
    ]);
    expect(JSON.parse(String((await auditRows("budget.blocked"))[0].metadata_json))).toMatchObject({
      before: { usage: { turns: 3, tokens: 4500, costUsd: 0.75 } },
      after: { exceeded: ["turns"], quota: { scopeKind: "user", scopeId: "alice", maxTurns: 3 } },
    });

    await expect(service.admitPrompt(subject("bob", "session-bob"))).resolves.toEqual({
      kind: "allow",
    });
    expect(await auditRows("budget.blocked")).toHaveLength(1);
  });

  it("resets the window at the UTC day boundary", async () => {
    await quotas.upsert(
      {
        scopeKind: "user",
        scopeId: "alice",
        period: "day",
        maxTurns: 3,
        maxCostUsd: null,
        maxTokens: null,
        maxRunningSandboxes: null,
        action: "block",
      },
      ACTOR
    );
    await settleTurns(3);
    await expect(service.admitPrompt(subject("alice"))).rejects.toBeInstanceOf(
      UsageQuotaExceededError
    );

    now = NOW + 2 * 3_600_000;
    await expect(service.admitPrompt(subject("alice"))).resolves.toEqual({ kind: "allow" });
    expect((await service.currentUsage("alice")).periods).toMatchObject([
      { period: "day", startAt: NOW + 2 * 3_600_000, usage: { turns: 0 }, quota: { maxTurns: 3 } },
      {
        period: "month",
        startAt: Date.UTC(2026, 2, 1),
        endAt: Date.UTC(2026, 3, 1),
        usage: { turns: 3 },
        quota: null,
      },
    ]);
  });

  it("warns without blocking and audits budget.warned", async () => {
    await quotas.upsert(
      {
        scopeKind: "team",
        scopeId: "team-platform",
        period: "month",
        maxCostUsd: 1,
        maxTurns: null,
        maxTokens: null,
        maxRunningSandboxes: null,
        action: "warn",
      },
      ACTOR
    );
    await settleTurns(4);
    const decision = await service.admitPrompt(subject("alice"));
    expect(decision.kind).toBe("warn");
    expect(await auditRows("budget.warned")).toMatchObject([
      { resource_id: "session-alice", team_id: "team-platform", target_user_id_snapshot: "alice" },
    ]);
    expect(await auditRows("budget.blocked")).toEqual([]);
  });

  it("lets a blocking team row override a warning user row", async () => {
    await quotas.upsert(
      {
        scopeKind: "user",
        scopeId: "alice",
        period: "day",
        maxTurns: 1,
        maxCostUsd: null,
        maxTokens: null,
        maxRunningSandboxes: null,
        action: "warn",
      },
      ACTOR
    );
    await quotas.upsert(
      {
        scopeKind: "team",
        scopeId: "team-platform",
        period: "day",
        maxTurns: 2,
        maxCostUsd: null,
        maxTokens: null,
        maxRunningSandboxes: null,
        action: "block",
      },
      ACTOR
    );
    await settleTurns(2);
    await expect(service.admitPrompt(subject("alice"))).rejects.toThrow(
      "your team used 2 of 2 turns today"
    );
  });

  it("caps running sandboxes per user independently of the global cap", async () => {
    await quotas.upsert(
      {
        scopeKind: "user",
        scopeId: "alice",
        period: "month",
        maxRunningSandboxes: 2,
        maxCostUsd: null,
        maxTurns: null,
        maxTokens: null,
        action: "block",
      },
      ACTOR
    );
    await quotas.upsert(
      {
        scopeKind: "workspace",
        scopeId: null,
        period: "month",
        maxRunningSandboxes: 3,
        maxCostUsd: null,
        maxTurns: null,
        maxTokens: null,
        action: "block",
      },
      ACTOR
    );
    const launch = (sessionId: string, userId: string) =>
      service.admitSandboxLaunch({ sessionId, userId, teamId: null, expiresAt: now + DAY_MS });

    expect(await launch("session-alice", "alice")).toEqual({ admitted: true });
    expect(await launch("session-alice-2", "alice")).toEqual({ admitted: true });
    expect(await launch("session-alice-3", "alice")).toEqual({
      admitted: false,
      cap: "user",
      limit: 2,
      running: 2,
    });
    expect(await launch("session-bob", "bob")).toEqual({ admitted: true });
    expect(await launch("session-bob-2", "bob")).toEqual({
      admitted: false,
      cap: "global",
      limit: 3,
      running: 3,
    });
    expect(await auditRows("budget.blocked")).toMatchObject([
      { resource_id: "session-alice-3", target_user_id_snapshot: "alice" },
      { resource_id: "session-bob-2", target_user_id_snapshot: "bob" },
    ]);

    await service.releaseSandbox("session-alice");
    expect(await launch("session-alice-3", "alice")).toEqual({ admitted: true });
    expect(await launch("session-alice-3", "alice")).toEqual({ admitted: true });
    expect((await service.currentUsage("alice")).runningSandboxes).toBe(2);
  });

  it("frees a slot whose session never released it once it expires", async () => {
    await quotas.upsert(
      {
        scopeKind: "workspace",
        scopeId: null,
        period: "month",
        maxRunningSandboxes: 1,
        maxCostUsd: null,
        maxTurns: null,
        maxTokens: null,
        action: "block",
      },
      ACTOR
    );
    expect(
      await service.admitSandboxLaunch({
        sessionId: "session-alice",
        userId: "alice",
        teamId: null,
        expiresAt: now + 60_000,
      })
    ).toEqual({ admitted: true });
    expect(
      await service.admitSandboxLaunch({
        sessionId: "session-bob",
        userId: "bob",
        teamId: null,
        expiresAt: now + 60_000,
      })
    ).toMatchObject({ admitted: false, cap: "global" });
    now += 60_000;
    expect(
      await service.admitSandboxLaunch({
        sessionId: "session-bob",
        userId: "bob",
        teamId: null,
        expiresAt: now + 60_000,
      })
    ).toEqual({ admitted: true });
  });

  function subject(userId: string, sessionId = "session-alice") {
    return { userId, teamId: "team-platform", sessionId, requestId: `req-${userId}` };
  }
});
