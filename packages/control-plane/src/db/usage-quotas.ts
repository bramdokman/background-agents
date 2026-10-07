import { z } from "zod";
import {
  usageQuotaSchema,
  type UpsertUsageQuotaRequest,
  type UsageQuota,
  type UsageQuotaScopeKind,
} from "@open-inspect/shared/types/usage-quotas";
import { generateId } from "../auth/crypto";
import { bindAppliedAuditEvent } from "./team-audit";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/** Workspace rows store `''`; the API shows `null`. */
const WORKSPACE_SCOPE_ID = "";

const quotaRowSchema = z.object({
  id: z.string(),
  scope_kind: usageQuotaSchema.shape.scopeKind,
  scope_id: z.string(),
  period: usageQuotaSchema.shape.period,
  max_cost_usd: z.number().nullable(),
  max_turns: z.number().nullable(),
  max_tokens: z.number().nullable(),
  max_running_sandboxes: z.number().nullable(),
  action: usageQuotaSchema.shape.action,
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

function toQuota(raw: unknown): UsageQuota {
  const row = quotaRowSchema.parse(raw);
  return usageQuotaSchema.parse({
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id === WORKSPACE_SCOPE_ID ? null : row.scope_id,
    period: row.period,
    maxCostUsd: row.max_cost_usd,
    maxTurns: row.max_turns,
    maxTokens: row.max_tokens,
    maxRunningSandboxes: row.max_running_sandboxes,
    action: row.action,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** One metered scope: a user, a team, or the workspace (`id` null). */
export interface UsageScope {
  kind: UsageQuotaScopeKind;
  id: string | null;
}

export interface UsageQuotaActor {
  actorUserId: string;
  requestId: string;
}

const QUOTA_COLUMNS = `id, scope_kind, scope_id, period, max_cost_usd, max_turns, max_tokens,
  max_running_sandboxes, action, created_by, created_at, updated_at`;

/** Quota rows and the `budget.quota_changed` audit trail of their edits. */
export class UsageQuotaStore {
  constructor(private readonly db: SqlDatabase) {}

  async list(): Promise<UsageQuota[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${QUOTA_COLUMNS} FROM usage_quotas ORDER BY scope_kind, scope_id, period, id`
      )
      .all();
    return rows.results.map(toQuota);
  }

  /** Every row of the given scopes, in no particular order; an empty list for none. */
  async listForScopes(scopes: readonly UsageScope[]): Promise<UsageQuota[]> {
    if (scopes.length === 0) return [];
    const rows = await this.db
      .prepare(
        `SELECT ${QUOTA_COLUMNS} FROM usage_quotas
         WHERE ${scopes.map(() => "(scope_kind = ? AND scope_id = ?)").join(" OR ")}`
      )
      .bind(...scopes.flatMap((scope) => [scope.kind, scope.id ?? WORKSPACE_SCOPE_ID]))
      .all();
    return rows.results.map(toQuota);
  }

  /** Create or replace the row for `(scopeKind, scopeId, period)`; every limit is overwritten. */
  async upsert(input: UpsertUsageQuotaRequest, actor: UsageQuotaActor): Promise<UsageQuota> {
    const scopeId = input.scopeId ?? WORKSPACE_SCOPE_ID;
    const before = await this.find(input.scopeKind, scopeId, input.period);
    const now = Date.now();
    const after = usageQuotaSchema.parse({
      id: before?.id ?? `quota_${generateId()}`,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      period: input.period,
      maxCostUsd: input.maxCostUsd,
      maxTurns: input.maxTurns,
      maxTokens: input.maxTokens,
      maxRunningSandboxes: input.maxRunningSandboxes,
      action: input.action,
      createdBy: before?.createdBy ?? actor.actorUserId,
      createdAt: before?.createdAt ?? now,
      updatedAt: now,
    } satisfies UsageQuota);
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO usage_quotas (${QUOTA_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope_kind, scope_id, period) DO UPDATE SET
             max_cost_usd = excluded.max_cost_usd,
             max_turns = excluded.max_turns,
             max_tokens = excluded.max_tokens,
             max_running_sandboxes = excluded.max_running_sandboxes,
             action = excluded.action,
             updated_at = excluded.updated_at`
        )
        .bind(
          after.id,
          after.scopeKind,
          scopeId,
          after.period,
          after.maxCostUsd,
          after.maxTurns,
          after.maxTokens,
          after.maxRunningSandboxes,
          after.action,
          after.createdBy,
          after.createdAt,
          after.updatedAt
        ),
      this.audit(actor, after, before, after),
    ]);
    return after;
  }

  /** Delete one row; false when no row had that id. */
  async remove(id: string, actor: UsageQuotaActor): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT ${QUOTA_COLUMNS} FROM usage_quotas WHERE id = ?`)
      .bind(id)
      .first();
    if (!row) return false;
    const before = toQuota(row);
    const [deleted] = await this.db.batch([
      this.db.prepare("DELETE FROM usage_quotas WHERE id = ?").bind(id),
      this.audit(actor, before, before, null, true),
    ]);
    return deleted.meta.changes === 1;
  }

  private async find(
    scopeKind: UsageQuotaScopeKind,
    scopeId: string,
    period: UsageQuota["period"]
  ): Promise<UsageQuota | null> {
    const row = await this.db
      .prepare(
        `SELECT ${QUOTA_COLUMNS} FROM usage_quotas
         WHERE scope_kind = ? AND scope_id = ? AND period = ?`
      )
      .bind(scopeKind, scopeId, period)
      .first();
    return row ? toQuota(row) : null;
  }

  private audit(
    actor: UsageQuotaActor,
    subject: UsageQuota,
    before: UsageQuota | null,
    after: UsageQuota | null,
    onlyIfPreviousChanged = false
  ): SqlStatement {
    return bindAppliedAuditEvent(
      this.db,
      {
        ...actor,
        action: "budget.quota_changed",
        resourceType: "usage_quota",
        resourceId: subject.id,
        teamId: subject.scopeKind === "team" ? subject.scopeId : null,
        targetUserId: subject.scopeKind === "user" ? (subject.scopeId ?? undefined) : undefined,
        before: before ?? {},
        after: after ?? {},
      },
      onlyIfPreviousChanged
    );
  }
}
