import { z } from "zod";
import type { UsagePeriodTotals, UsagePeriodWindow } from "@open-inspect/shared/types/usage-quotas";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import type { UsageScope } from "./usage-quotas";

/** One settled turn as the session reports it when `execution_complete` lands. */
export interface SettledTurn {
  messageId: string;
  sessionId: string;
  /** The metered identity of the prompt's author. */
  userId: string;
  repoExternalId: number | null;
  harness: string | null;
  model: string | null;
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  settledAt: number;
}

const totalsRowSchema = z.object({
  turns: z.number(),
  tokens: z.number(),
  cost_usd: z.number(),
});

/** Scope filter over ledger rows; the workspace scope matches every row. */
function scopePredicate(scope: UsageScope): { sql: string; binds: string[] } {
  if (scope.kind === "workspace") return { sql: "", binds: [] };
  const column = scope.kind === "user" ? "user_id" : "team_id";
  return { sql: `AND ${column} = ?`, binds: [scope.id ?? ""] };
}

/**
 * The usage ledger: one row per settled turn in the global store, which is
 * what period quotas are summed over.
 *
 * Idempotent on the message id. The session reports each turn's cumulative
 * cost and token totals, so a completion delivered twice rewrites the row
 * with the same values and the period totals do not move; `settled_at`
 * keeps the first delivery's time so the turn cannot change window.
 */
export class UsageLedgerStore {
  constructor(private readonly db: SqlDatabase) {}

  /** The ledger write, for callers that batch it with other statements. */
  bindRecordTurn(turn: SettledTurn): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO usage_ledger
          (message_id, session_id, user_id, team_id, repo_external_id, harness, model,
           cost_usd, input_tokens, output_tokens, settled_at)
         SELECT ?, s.id, ?, s.owner_team_id, ?, ?, ?, ?, ?, ?, ? FROM sessions s WHERE s.id = ?
         ON CONFLICT (message_id) DO UPDATE SET
           cost_usd = excluded.cost_usd,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens`
      )
      .bind(
        turn.messageId,
        turn.userId,
        turn.repoExternalId,
        turn.harness,
        turn.model,
        turn.costUsd,
        turn.inputTokens,
        turn.outputTokens,
        turn.settledAt,
        turn.sessionId
      );
  }

  async recordTurn(turn: SettledTurn): Promise<void> {
    await this.bindRecordTurn(turn).run();
  }

  /** Settled usage of `scope` with `settled_at` inside the window. */
  async sumForScope(scope: UsageScope, window: UsagePeriodWindow): Promise<UsagePeriodTotals> {
    const predicate = scopePredicate(scope);
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS turns,
           COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens,
           COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM usage_ledger
         WHERE settled_at >= ? AND settled_at < ? ${predicate.sql}`
      )
      .bind(window.startAt, window.endAt, ...predicate.binds)
      .first();
    const totals = totalsRowSchema.parse(row);
    return { turns: totals.turns, tokens: totals.tokens, costUsd: totals.cost_usd };
  }
}
