import { z } from "zod";
import type { SqlDatabase } from "./sql-database";

const countRowSchema = z.object({ count: z.number() });

export interface RunningSandboxCaps {
  /** Workspace-wide cap on live sandboxes; null for none. */
  global: number | null;
  /** Cap on live sandboxes owned by the launching session's user; null for none. */
  perUser: number | null;
}

export type RunningSandboxAdmission =
  { admitted: true } | { admitted: false; cap: "global" | "user"; limit: number; running: number };

/**
 * The live-sandbox register behind `max_running_sandboxes`.
 *
 * A session holds at most one row, keyed by its id. `acquire` is the
 * admission check: one statement counts the other unexpired rows and inserts
 * only while both caps hold, so concurrent launches cannot both squeeze
 * through the last slot. `assert` keeps a row current without a cap check,
 * for a sandbox already known to be live; `release` drops it. Rows expire at
 * `expires_at`, the launched sandbox's own lifetime, so a session that never
 * released cannot occupy a slot after its sandbox is gone.
 */
export class RunningSandboxStore {
  constructor(private readonly db: SqlDatabase) {}

  async acquire(input: {
    sessionId: string;
    now: number;
    expiresAt: number;
    caps: RunningSandboxCaps;
  }): Promise<RunningSandboxAdmission> {
    const { sessionId, now, expiresAt, caps } = input;
    const [, inserted] = await this.db.batch([
      this.db.prepare("DELETE FROM running_sandboxes WHERE expires_at <= ?").bind(now),
      this.db
        .prepare(
          `INSERT INTO running_sandboxes (session_id, user_id, started_at, expires_at)
           SELECT s.id, s.user_id, ?, ? FROM sessions s
           WHERE s.id = ?
             AND (? IS NULL OR (
               SELECT COUNT(*) FROM running_sandboxes r WHERE r.session_id <> s.id) < ?)
             AND (? IS NULL OR s.user_id IS NULL OR (
               SELECT COUNT(*) FROM running_sandboxes r
               WHERE r.user_id = s.user_id AND r.session_id <> s.id) < ?)
           ON CONFLICT (session_id) DO UPDATE SET
             user_id = excluded.user_id,
             started_at = excluded.started_at,
             expires_at = excluded.expires_at`
        )
        .bind(now, expiresAt, sessionId, caps.global, caps.global, caps.perUser, caps.perUser),
    ]);
    if (inserted.meta.changes === 1) return { admitted: true };
    const running = await this.countOthers(sessionId);
    if (caps.global !== null && running.global >= caps.global) {
      return { admitted: false, cap: "global", limit: caps.global, running: running.global };
    }
    if (caps.perUser !== null && running.user >= caps.perUser) {
      return { admitted: false, cap: "user", limit: caps.perUser, running: running.user };
    }
    // No cap refused it: the session has no global row to attribute, which
    // admission does not police.
    return { admitted: true };
  }

  /** Record that `sessionId`'s sandbox is live until `expiresAt`, without a cap check. */
  async assert(input: { sessionId: string; now: number; expiresAt: number }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO running_sandboxes (session_id, user_id, started_at, expires_at)
         SELECT s.id, s.user_id, ?, ? FROM sessions s WHERE s.id = ?
         ON CONFLICT (session_id) DO UPDATE SET expires_at = excluded.expires_at`
      )
      .bind(input.now, input.expiresAt, input.sessionId)
      .run();
  }

  async release(sessionId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM running_sandboxes WHERE session_id = ?")
      .bind(sessionId)
      .run();
  }

  /** Unexpired rows owned by `userId`. */
  async countForUser(userId: string, now: number): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM running_sandboxes WHERE user_id = ? AND expires_at > ?"
      )
      .bind(userId, now)
      .first();
    return countRowSchema.parse(row).count;
  }

  /** Unexpired rows other than `sessionId`'s: all, and those sharing its user. */
  private async countOthers(sessionId: string): Promise<{ global: number; user: number }> {
    const [global, user] = await this.db.batch([
      this.db
        .prepare("SELECT COUNT(*) AS count FROM running_sandboxes WHERE session_id <> ?")
        .bind(sessionId),
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM running_sandboxes r
           WHERE r.session_id <> ?
             AND r.user_id = (SELECT user_id FROM sessions WHERE id = ?)`
        )
        .bind(sessionId, sessionId),
    ]);
    return {
      global: countRowSchema.parse(global.results[0]).count,
      user: countRowSchema.parse(user.results[0]).count,
    };
  }
}
