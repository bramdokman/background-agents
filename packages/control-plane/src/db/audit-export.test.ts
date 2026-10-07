import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { exportAuditEvents, type AuditExportRecord } from "./audit-export";
import { createRequestMetrics, instrumentSqlDatabase } from "./instrumented-sql-database";
import { SessionAuditStore } from "./session-audit";
import type { SqlDatabase } from "./sql-database";
import { bindAppliedAuditEvent } from "./team-audit";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);

/** The documented line layout: event ID first, then the fields in this order. */
const RECORD_FIELDS = [
  "id",
  "occurredAt",
  "action",
  "operationResult",
  "reasonCode",
  "requestId",
  "principal",
  "target",
  "resource",
  "metadata",
];

const log: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => log,
};

describe("exportAuditEvents", () => {
  let store: NodeSqlDatabase;
  let db: SqlDatabase;
  let exported: AuditExportRecord[];

  beforeEach(async () => {
    const connection = new DatabaseSync(":memory:");
    applyMigrations(connection, MIGRATIONS_DIR);
    store = createNodeSqlDatabase(connection);
    await store.prepare("CREATE TABLE scratch (id INTEGER PRIMARY KEY, v TEXT)").run();
    await store.prepare("INSERT INTO scratch (id, v) VALUES (1, 'a')").run();
    exported = [];
    db = exportAuditEvents(store, { write: (record) => exported.push(record) }, log);
    vi.mocked(log.error).mockClear();
  });

  afterEach(() => {
    store.close();
  });

  const auditRows = () =>
    store
      .prepare(
        "SELECT id, occurred_at, action FROM authorization_audit_events ORDER BY occurred_at"
      )
      .all<{ id: string; occurred_at: number; action: string }>()
      .then((result) => result.results);

  it("exports exactly one record, with the row's ID, when an audit insert commits", async () => {
    await new SessionAuditStore(db).write({
      requestId: "req-1",
      actorUserId: "user-1",
      action: "session.visibility_changed",
      sessionId: "session-1",
      teamId: "team-1",
      targetUserId: null,
      before: { visibility: "team" },
      after: { visibility: "private" },
    });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(exported).toHaveLength(1);
    const [record] = exported;
    expect(Object.keys(record)).toEqual(RECORD_FIELDS);
    expect(record).toEqual({
      id: rows[0].id,
      occurredAt: new Date(rows[0].occurred_at).toISOString(),
      action: "session.visibility_changed",
      operationResult: "applied",
      reasonCode: "session.visibility_changed",
      requestId: "req-1",
      principal: { kind: "user", userId: "user-1", service: null },
      target: { userId: null },
      resource: { type: "session", id: "session-1", teamId: "team-1" },
      metadata: {
        before: { visibility: "team" },
        requested: {},
        after: { visibility: "private" },
      },
    });
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it("exports a gated insert only when the batch wrote it, and only after the batch committed", async () => {
    const event = {
      requestId: "req-2",
      actorUserId: "user-1",
      action: "team.updated" as const,
      resourceType: "team" as const,
      resourceId: "team-1",
      teamId: "team-1",
      before: {},
      after: {},
    };

    // The guarded UPDATE changes nothing, so `WHERE changes() = 1` writes no audit row.
    await db.batch([
      db.prepare("UPDATE scratch SET v = 'b' WHERE id = 999"),
      bindAppliedAuditEvent(db, event, true),
    ]);
    expect(exported).toEqual([]);
    expect(await auditRows()).toEqual([]);

    // A later statement fails, so the whole batch, audit insert included, rolls back.
    await expect(
      db.batch([
        bindAppliedAuditEvent(db, event),
        db.prepare("INSERT INTO scratch (id, v) VALUES (1, 'duplicate')"),
      ])
    ).rejects.toThrow();
    expect(exported).toEqual([]);
    expect(await auditRows()).toEqual([]);

    // The same batch with the UPDATE taking effect writes and exports the row.
    const [, result] = await db.batch([
      db.prepare("UPDATE scratch SET v = 'b' WHERE id = 1"),
      bindAppliedAuditEvent(db, event, true),
    ]);
    expect(result.meta.changes).toBe(1);
    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual(["team.updated"]);
    expect(exported.map((record) => record.id)).toEqual([rows[0].id]);
  });

  it("exports an insert whose statement has a CTE prefix and its own RETURNING clause", async () => {
    const result = await db
      .prepare(
        `WITH decision(status) AS (SELECT 'applied')
         INSERT INTO authorization_audit_events
           (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot, action,
            resource_type, resource_id, reason_code, operation_result, metadata_json)
         SELECT ?, ?, ?, 'user', ?, 'workspace.member_role_updated', 'user', ?,
           'member_role_updated', status, '{"before":{},"requested":{},"after":{}}'
         FROM decision
         RETURNING reason_code AS status`
      )
      .bind("audit-cte", 1_700_000_000_000, "req-3", "user-1", "user-2")
      .run<{ status: string }>();

    expect(result.results).toEqual([{ status: "member_role_updated" }]);
    expect(exported.map((record) => [record.id, record.resource.id])).toEqual([
      ["audit-cte", "user-2"],
    ]);
  });

  it("exports nothing for a duplicate insert that ON CONFLICT DO NOTHING skipped", async () => {
    const insert = () =>
      db
        .prepare(
          `INSERT INTO authorization_audit_events
             (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot, action,
              resource_type, resource_id, reason_code, operation_result, metadata_json)
           VALUES (?, ?, ?, 'user', ?, 'session.shadow_denied', 'session', ?, ?, 'denied', '{"before":{},"requested":{},"after":{}}')
           ON CONFLICT (id) DO NOTHING`
        )
        .bind("ws-shadow-1", 1_700_000_000_000, "conn-1", "user-1", "session-1", "shadow_denied:x")
        .run();

    await insert();
    await insert();
    expect(await auditRows()).toHaveLength(1);
    expect(exported.map((record) => record.id)).toEqual(["ws-shadow-1"]);
  });

  it("logs a failing sink and still completes the write", async () => {
    const failing = exportAuditEvents(
      store,
      {
        write: () => {
          throw new Error("disk full");
        },
      },
      log
    );
    await expect(
      new SessionAuditStore(failing).write({
        requestId: "req-4",
        actorUserId: "user-1",
        action: "session.created_private",
        sessionId: "session-2",
        teamId: null,
        before: {},
        after: {},
      })
    ).resolves.toBeUndefined();

    expect(await auditRows()).toHaveLength(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.error).mock.calls[0][1]).toMatchObject({
      event: "audit.export_failed",
      error: expect.objectContaining({ message: "disk full" }),
    });
  });

  it("works under the per-request instrumentation wrapper", async () => {
    const instrumented = instrumentSqlDatabase(db, createRequestMetrics());
    await instrumented.batch([
      instrumented.prepare("UPDATE scratch SET v = 'c' WHERE id = 1"),
      bindAppliedAuditEvent(
        instrumented,
        {
          requestId: "req-5",
          actorUserId: "user-1",
          action: "team.created",
          resourceType: "team",
          resourceId: "team-2",
          teamId: "team-2",
          before: {},
          after: {},
        },
        true
      ),
    ]);
    expect(exported.map((record) => record.action)).toEqual(["team.created"]);
  });

  it("leaves other statements alone", async () => {
    await db.prepare("INSERT INTO scratch (id, v) VALUES (?, ?)").bind(2, "x").run();
    expect(await db.prepare("SELECT v FROM scratch WHERE id = ?").bind(2).first()).toEqual({
      v: "x",
    });
    expect(exported).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });
});
