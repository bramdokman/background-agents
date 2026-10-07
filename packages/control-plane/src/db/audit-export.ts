/**
 * Append-only export of the workspace audit log.
 *
 * Audit rows are written by their operation owners through ten different
 * INSERT statements, most of them inside a `batch()` and gated on the
 * preceding statement having changed a row. There is no shared insert
 * helper to hook, but every write crosses the one `SqlDatabase` a host
 * opens, so the export is a wrapper over that port in the manner of
 * `instrumentSqlDatabase`: it recognises an insert into
 * `authorization_audit_events` by its text, lets the engine commit it, and
 * only then reads the committed row back and hands it to the sink.
 *
 * The row is read back rather than reconstructed from the bound values
 * because the statements differ in column order and gate on SQL the
 * wrapper cannot evaluate. Every site binds the event ID as a parameter,
 * so the committed rows are the ones whose ID is among the statement's
 * bound strings; `meta.changes` says how many there must be.
 *
 * The export runs after the commit and never before it: a batch that rolls
 * back exports nothing, and a gated insert that wrote no row exports
 * nothing. A failing sink or read-back is logged and the write still
 * succeeds, so the audit row (the record of truth) is never lost to the
 * export.
 */

import type { Logger } from "../logger";
import { toAuditEvent, type AuditEventRow } from "./audit-event-store";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

/** One exported audit event. Key order is the line's field order and is part of the contract. */
export interface AuditExportRecord {
  id: string;
  /** ISO 8601 rendering of the row's `occurred_at`. */
  occurredAt: string;
  action: string;
  operationResult: string;
  reasonCode: string;
  requestId: string;
  principal: { kind: string; userId: string | null; service: string | null };
  target: { userId: string | null };
  resource: { type: string; id: string | null; teamId: string | null };
  metadata: Record<string, unknown>;
}

/** Where exported records go. `write` may throw; the wrapper logs and continues. */
export interface AuditExportSink {
  write(record: AuditExportRecord): void;
}

type ExportedAuditRow = AuditEventRow & { team_id: string | null };

/** The export record for a committed row, in the documented field order. */
function toAuditExportRecord(row: ExportedAuditRow): AuditExportRecord {
  const event = toAuditEvent(row);
  return {
    id: event.id,
    occurredAt: new Date(event.occurredAt).toISOString(),
    action: event.action,
    operationResult: event.operationResult,
    reasonCode: event.reasonCode,
    requestId: event.requestId,
    principal: {
      kind: event.principalKind,
      userId: event.actorUserIdSnapshot,
      service: event.actorServiceSnapshot,
    },
    target: { userId: event.targetUserIdSnapshot },
    resource: { type: event.resourceType, id: event.resourceId, teamId: row.team_id ?? null },
    metadata: event.metadata,
  };
}

const AUDIT_INSERT = /\bINSERT\s+INTO\s+authorization_audit_events\b/i;

/** Statements the wrapper hands back; `original` is what the engine executes. */
const ORIGINAL_STMT = Symbol("originalSqlStatement");

interface AuditStatement extends SqlStatement {
  [ORIGINAL_STMT]: SqlStatement;
  /** Set when the text inserts an audit row: the strings bound to it, one of which is the ID. */
  readonly auditCandidateIds: readonly string[] | null;
}

function isAuditStatement(statement: SqlStatement): statement is AuditStatement {
  return ORIGINAL_STMT in statement;
}

/**
 * Wrap `db` so that every audit row it commits is written to `sink`. The
 * wrapper's own read-back and the sink run inside the caller's `run()` or
 * `batch()`, after the engine resolved, so a request that wrote an audit
 * row has exported it before it answers.
 */
export function exportAuditEvents(
  db: SqlDatabase,
  sink: AuditExportSink,
  log: Logger
): SqlDatabase {
  const exportCommitted = async (
    statements: readonly SqlStatement[],
    results: readonly SqlResult<unknown>[]
  ): Promise<void> => {
    const candidateIds = new Set<string>();
    let expected = 0;
    statements.forEach((statement, index) => {
      if (!isAuditStatement(statement) || statement.auditCandidateIds === null) return;
      const changes = results[index]?.meta.changes ?? 0;
      if (changes === 0) return;
      expected += changes;
      for (const id of statement.auditCandidateIds) candidateIds.add(id);
    });
    if (expected === 0) return;
    try {
      const rows = await readBack(db, [...candidateIds]);
      for (const row of rows) sink.write(toAuditExportRecord(row));
      if (rows.length !== expected) {
        log.error("Audit export could not identify every committed row", {
          event: "audit.export_incomplete",
          expected,
          exported: rows.length,
        });
      }
    } catch (cause) {
      log.error("Audit export failed; the audit row is committed", {
        event: "audit.export_failed",
        error: cause instanceof Error ? cause : String(cause),
      });
    }
  };

  const wrap = (statement: SqlStatement, query: string, bound: unknown[]): SqlStatement => {
    const wrapper: AuditStatement = {
      [ORIGINAL_STMT]: statement,
      auditCandidateIds: AUDIT_INSERT.test(query)
        ? bound.filter((value): value is string => typeof value === "string")
        : null,
      bind: (...values) => wrap(statement.bind(...values), query, values),
      first: <T = Record<string, unknown>>() => statement.first<T>(),
      async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
        const result = await statement.run<T>();
        await exportCommitted([wrapper], [result]);
        return result;
      },
      async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
        const result = await statement.all<T>();
        await exportCommitted([wrapper], [result]);
        return result;
      },
    };
    return wrapper;
  };

  return {
    prepare: (query) => wrap(db.prepare(query), query, []),
    async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      const results = await db.batch<T>(
        statements.map((statement) =>
          isAuditStatement(statement) ? statement[ORIGINAL_STMT] : statement
        )
      );
      await exportCommitted(statements, results);
      return results;
    },
  };
}

async function readBack(db: SqlDatabase, ids: readonly string[]): Promise<ExportedAuditRow[]> {
  if (ids.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT * FROM authorization_audit_events
       WHERE id IN (${ids.map(() => "?").join(", ")})
       ORDER BY occurred_at, id`
    )
    .bind(...ids)
    .all<ExportedAuditRow>();
  return result.results;
}
