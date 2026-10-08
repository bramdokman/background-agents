/**
 * The bot's durable state, one SQLite file on the state volume (node:sqlite,
 * no native dependency): the thread -> session map, the conversation
 * references needed to post proactively after a restart, and the claims that
 * make retried deliveries idempotent (inbound activities by id, callbacks by
 * `(messageId, kind)`).
 *
 * Single writer by construction: the Deployment runs one replica, and
 * node:sqlite's synchronous API serialises every statement within it.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredConversationReference } from "../types";

export const STATE_FILE_NAME = "teams-bot.sqlite";

type TurnState = "idle" | "working";

export interface ThreadSessionRecord {
  /** Teams conversation id including the root message (`...;messageid=<root>`), or the chat id. */
  threadKey: string;
  sessionId: string;
  teamId: string | null;
  repoFullName: string | null;
  model: string;
  reasoningEffort: string | null;
  /** Where replies go: the Bot Framework connector the activity named. */
  serviceUrl: string;
  channelId: string | null;
  /** The root post of the thread; replies carry it as `replyToId`. */
  rootActivityId: string | null;
  /** The "Working..." reply the current turn edits in place. */
  progressActivityId: string | null;
  /** The control-plane message id of the prompt in flight, or the last one sent. */
  lastMessageId: string | null;
  turnState: TurnState;
  closed: boolean;
  createdAt: number;
  updatedAt: number;
}

export type NewThreadSession = Pick<
  ThreadSessionRecord,
  | "threadKey"
  | "sessionId"
  | "teamId"
  | "repoFullName"
  | "model"
  | "reasoningEffort"
  | "serviceUrl"
  | "channelId"
  | "rootActivityId"
> &
  Partial<Pick<ThreadSessionRecord, "progressActivityId" | "lastMessageId" | "turnState">>;

export type ThreadSessionPatch = Partial<
  Pick<ThreadSessionRecord, "progressActivityId" | "lastMessageId" | "turnState" | "closed">
>;

interface ThreadSessionRow {
  thread_key: string;
  session_id: string;
  team_id: string | null;
  repo_full_name: string | null;
  model: string;
  reasoning_effort: string | null;
  service_url: string;
  channel_id: string | null;
  root_activity_id: string | null;
  progress_activity_id: string | null;
  last_message_id: string | null;
  turn_state: string;
  closed: number;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_sessions (
  thread_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  team_id TEXT,
  repo_full_name TEXT,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  service_url TEXT NOT NULL,
  channel_id TEXT,
  root_activity_id TEXT,
  progress_activity_id TEXT,
  last_message_id TEXT,
  turn_state TEXT NOT NULL DEFAULT 'idle' CHECK (turn_state IN ('idle', 'working')),
  closed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_sessions_session ON thread_sessions(session_id);
CREATE TABLE IF NOT EXISTS conversation_references (
  thread_key TEXT PRIMARY KEY,
  reference_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbound_activities (
  activity_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS callback_deliveries (
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind)
);
`;

function toRecord(row: ThreadSessionRow): ThreadSessionRecord {
  return {
    threadKey: row.thread_key,
    sessionId: row.session_id,
    teamId: row.team_id,
    repoFullName: row.repo_full_name,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    serviceUrl: row.service_url,
    channelId: row.channel_id,
    rootActivityId: row.root_activity_id,
    progressActivityId: row.progress_activity_id,
    lastMessageId: row.last_message_id,
    turnState: row.turn_state === "working" ? "working" : "idle",
    closed: row.closed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TeamsStateStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number
  ) {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
  }

  /** The store on disk under `stateDir`, created on first use. */
  static open(stateDir: string, now: () => number = Date.now): TeamsStateStore {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(stateDir, STATE_FILE_NAME));
    db.exec("PRAGMA journal_mode = WAL");
    return new TeamsStateStore(db, now);
  }

  /** A throwaway store for tests. */
  static inMemory(now: () => number = Date.now): TeamsStateStore {
    return new TeamsStateStore(new DatabaseSync(":memory:"), now);
  }

  close(): void {
    this.db.close();
  }

  getThreadSession(threadKey: string): ThreadSessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM thread_sessions WHERE thread_key = ?")
      .get(threadKey) as ThreadSessionRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Every thread mapped to `sessionId`; callbacks carry the session, not the thread. */
  findThreadSessionsBySessionId(sessionId: string): ThreadSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM thread_sessions WHERE session_id = ? ORDER BY created_at")
      .all(sessionId) as unknown as ThreadSessionRow[];
    return rows.map(toRecord);
  }

  /** Insert the mapping, replacing any earlier session mapped to the same thread. */
  putThreadSession(session: NewThreadSession): ThreadSessionRecord {
    const now = this.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_sessions (
           thread_key, session_id, team_id, repo_full_name, model, reasoning_effort,
           service_url, channel_id, root_activity_id, progress_activity_id, last_message_id,
           turn_state, closed, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        session.threadKey,
        session.sessionId,
        session.teamId,
        session.repoFullName,
        session.model,
        session.reasoningEffort,
        session.serviceUrl,
        session.channelId,
        session.rootActivityId,
        session.progressActivityId ?? null,
        session.lastMessageId ?? null,
        session.turnState ?? "idle",
        now,
        now
      );
    return this.getThreadSession(session.threadKey)!;
  }

  updateThreadSession(threadKey: string, patch: ThreadSessionPatch): ThreadSessionRecord | null {
    const current = this.getThreadSession(threadKey);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE thread_sessions
           SET progress_activity_id = ?, last_message_id = ?, turn_state = ?, closed = ?, updated_at = ?
         WHERE thread_key = ?`
      )
      .run(
        next.progressActivityId,
        next.lastMessageId,
        next.turnState,
        next.closed ? 1 : 0,
        this.now(),
        threadKey
      );
    return this.getThreadSession(threadKey);
  }

  /** Mark the thread's session closed; false when the thread maps to a different session. */
  closeThreadSession(threadKey: string, sessionId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE thread_sessions SET closed = 1, turn_state = 'idle', updated_at = ?
         WHERE thread_key = ? AND session_id = ?`
      )
      .run(this.now(), threadKey, sessionId);
    return result.changes > 0;
  }

  getConversationReference(threadKey: string): StoredConversationReference | null {
    const row = this.db
      .prepare("SELECT reference_json FROM conversation_references WHERE thread_key = ?")
      .get(threadKey) as { reference_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.reference_json) as StoredConversationReference;
    } catch {
      return null;
    }
  }

  putConversationReference(threadKey: string, reference: StoredConversationReference): void {
    this.db
      .prepare(
        `INSERT INTO conversation_references (thread_key, reference_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_key) DO UPDATE SET reference_json = excluded.reference_json,
           updated_at = excluded.updated_at`
      )
      .run(threadKey, JSON.stringify(reference), this.now());
  }

  /**
   * Claim an inbound activity id. True the first time, false on a redelivery
   * (Bot Framework retries when the bot does not answer in time).
   */
  claimInboundActivity(activityId: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO inbound_activities (activity_id, received_at) VALUES (?, ?)")
      .run(activityId, this.now());
    return result.changes > 0;
  }

  /** Forget inbound claims older than `maxAgeMs`; redeliveries never come that late. */
  pruneInboundActivities(maxAgeMs: number): number {
    const result = this.db
      .prepare("DELETE FROM inbound_activities WHERE received_at < ?")
      .run(this.now() - maxAgeMs);
    return Number(result.changes);
  }

  /**
   * Claim a callback delivery by `(messageId, kind)`. True the first time;
   * false when it was already claimed, so a retried callback renders nothing.
   */
  claimCallback(messageId: string, kind: string): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO callback_deliveries (message_id, kind, claimed_at) VALUES (?, ?, ?)"
      )
      .run(messageId, kind, this.now());
    return result.changes > 0;
  }

  /** Give a claim back when rendering failed, so the control plane's retry gets through. */
  releaseCallback(messageId: string, kind: string): void {
    this.db
      .prepare("DELETE FROM callback_deliveries WHERE message_id = ? AND kind = ?")
      .run(messageId, kind);
  }
}
