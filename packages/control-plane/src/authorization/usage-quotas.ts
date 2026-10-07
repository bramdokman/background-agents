import {
  exceededUsageLimits,
  usagePeriodWindow,
  USAGE_QUOTA_PERIODS,
  type CurrentUsageResponse,
  type UsagePeriodTotals,
  type UsagePeriodWindow,
  type UsageQuota,
} from "@open-inspect/shared/types/usage-quotas";
import { bindAppliedAuditEvent } from "../db/team-audit";
import { RunningSandboxStore, type RunningSandboxAdmission } from "../db/running-sandboxes";
import type { SqlDatabase } from "../db/sql-database";
import { UsageLedgerStore } from "../db/usage-ledger";
import { UsageQuotaStore, type UsageScope } from "../db/usage-quotas";

/** One quota row whose scope has used up a limit in the current window. */
export interface UsageQuotaViolation {
  quota: UsageQuota;
  window: UsagePeriodWindow;
  usage: UsagePeriodTotals;
  exceeded: ("turns" | "tokens" | "cost")[];
}

/**
 * The outcome of checking the applicable rows. `block` carries the most
 * specific blocking violation (a user row beats a team row beats a workspace
 * row); `warn` means every exceeded row only warns.
 */
export type UsageQuotaDecision =
  | { kind: "allow" }
  | { kind: "warn"; violations: UsageQuotaViolation[] }
  | { kind: "block"; violation: UsageQuotaViolation; violations: UsageQuotaViolation[] };

export class UsageQuotaExceededError extends Error {
  constructor(readonly violation: UsageQuotaViolation) {
    super(describeViolation(violation));
    this.name = "UsageQuotaExceededError";
  }
}

export interface PromptUsageSubject {
  /** The metered identity of the prompting user. */
  userId: string;
  /** The session's owning team, whose quota also applies. */
  teamId: string | null;
  sessionId: string;
  /** Correlates the audit row; a socket prompt supplies a synthetic id. */
  requestId: string;
}

const SCOPE_RANK: Record<UsageQuota["scopeKind"], number> = { user: 0, team: 1, workspace: 2 };

function scopesFor(userId: string, teamId: string | null): UsageScope[] {
  const scopes: UsageScope[] = [{ kind: "user", id: userId }];
  if (teamId) scopes.push({ kind: "team", id: teamId });
  scopes.push({ kind: "workspace", id: null });
  return scopes;
}

function scopeOf(quota: UsageQuota): UsageScope {
  return { kind: quota.scopeKind, id: quota.scopeId };
}

function describeScope(quota: UsageQuota): string {
  if (quota.scopeKind === "workspace") return "the workspace";
  return quota.scopeKind === "team" ? "your team" : "you";
}

function describeViolation(violation: UsageQuotaViolation): string {
  const { quota, usage } = violation;
  const meter = violation.exceeded[0];
  const used =
    meter === "turns"
      ? `${usage.turns} of ${quota.maxTurns} turns`
      : meter === "tokens"
        ? `${usage.tokens} of ${quota.maxTokens} tokens`
        : `$${usage.costUsd.toFixed(2)} of $${quota.maxCostUsd?.toFixed(2)}`;
  const period = quota.period === "day" ? "today" : "this month";
  return `Usage quota reached: ${describeScope(quota)} used ${used} ${period}. The window resets at the next UTC ${quota.period} boundary.`;
}

export function describeSandboxCapRefusal(
  refusal: Extract<RunningSandboxAdmission, { admitted: false }>
): string {
  const who = refusal.cap === "global" ? "The workspace" : "You";
  return `Sandbox limit reached: ${who} already ${refusal.cap === "global" ? "has" : "have"} ${refusal.running} of ${refusal.limit} sandboxes running. This prompt stays queued and starts when the session is prompted again after one stops.`;
}

/**
 * Evaluates workspace usage quotas against the ledger, writes the
 * `budget.blocked` / `budget.warned` audit trail, and admits sandbox launches
 * against the running-sandbox caps. With no quota rows everything is allowed.
 */
export class UsageQuotaService {
  private readonly quotas: UsageQuotaStore;
  private readonly ledger: UsageLedgerStore;
  private readonly runningSandboxes: RunningSandboxStore;

  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => number = () => Date.now()
  ) {
    this.quotas = new UsageQuotaStore(db);
    this.ledger = new UsageLedgerStore(db);
    this.runningSandboxes = new RunningSandboxStore(db);
  }

  /** Check every applicable row's period limits for a prompt from `userId` in `teamId`'s session. */
  async evaluatePrompt(userId: string, teamId: string | null): Promise<UsageQuotaDecision> {
    const now = this.now();
    const rows = (await this.quotas.listForScopes(scopesFor(userId, teamId))).filter(
      (quota) => quota.maxTurns !== null || quota.maxTokens !== null || quota.maxCostUsd !== null
    );
    if (rows.length === 0) return { kind: "allow" };
    const violations: UsageQuotaViolation[] = [];
    for (const quota of rows) {
      const window = usagePeriodWindow(quota.period, now);
      const usage = await this.ledger.sumForScope(scopeOf(quota), window);
      const exceeded = exceededUsageLimits(quota, usage);
      if (exceeded.length > 0) violations.push({ quota, window, usage, exceeded });
    }
    violations.sort((a, b) => SCOPE_RANK[a.quota.scopeKind] - SCOPE_RANK[b.quota.scopeKind]);
    const blocking = violations.find((violation) => violation.quota.action === "block");
    if (blocking) return { kind: "block", violation: blocking, violations };
    return violations.length > 0 ? { kind: "warn", violations } : { kind: "allow" };
  }

  /**
   * Admit a prompt or throw `UsageQuotaExceededError`. A block is audited
   * before it is thrown; a warning is audited and the prompt proceeds.
   */
  async admitPrompt(subject: PromptUsageSubject): Promise<UsageQuotaDecision> {
    const decision = await this.evaluatePrompt(subject.userId, subject.teamId);
    if (decision.kind === "block") {
      await this.auditDecision("budget.blocked", subject, decision.violation).run();
      throw new UsageQuotaExceededError(decision.violation);
    }
    if (decision.kind === "warn") {
      await this.auditDecision("budget.warned", subject, decision.violations[0]).run();
    }
    return decision;
  }

  /**
   * Take a running-sandbox slot for `sessionId` or report which cap refused
   * it. The workspace row's `maxRunningSandboxes` is the global cap; the
   * session owner's user row is the per-user cap. A refusal by a `warn` row
   * is audited and admitted.
   */
  async admitSandboxLaunch(input: {
    sessionId: string;
    userId: string | null;
    teamId: string | null;
    expiresAt: number;
  }): Promise<RunningSandboxAdmission> {
    const now = this.now();
    const scopes: UsageScope[] = [{ kind: "workspace", id: null }];
    if (input.userId) scopes.push({ kind: "user", id: input.userId });
    const rows = await this.quotas.listForScopes(scopes);
    const capOf = (kind: UsageQuota["scopeKind"]) =>
      rows
        .filter((quota) => quota.scopeKind === kind && quota.maxRunningSandboxes !== null)
        .reduce<UsageQuota | null>(
          (tightest, quota) =>
            tightest === null || quota.maxRunningSandboxes! < tightest.maxRunningSandboxes!
              ? quota
              : tightest,
          null
        );
    const globalRow = capOf("workspace");
    const userRow = capOf("user");
    const admission = await this.runningSandboxes.acquire({
      sessionId: input.sessionId,
      now,
      expiresAt: input.expiresAt,
      caps: {
        global: globalRow?.action === "block" ? globalRow.maxRunningSandboxes : null,
        perUser: userRow?.action === "block" ? userRow.maxRunningSandboxes : null,
      },
    });
    const subject = {
      userId: input.userId ?? "unknown",
      teamId: input.teamId,
      sessionId: input.sessionId,
      requestId: crypto.randomUUID(),
    };
    if (!admission.admitted) {
      const quota = admission.cap === "global" ? globalRow! : userRow!;
      await this.auditSandboxCap("budget.blocked", subject, quota, admission.running).run();
      return admission;
    }
    // Warn-only caps are checked after the slot is taken, against the new count.
    for (const quota of [userRow, globalRow]) {
      if (!quota || quota.action !== "warn") continue;
      const running =
        quota.scopeKind === "user"
          ? await this.runningSandboxes.countForUser(input.userId!, now)
          : await this.countAll(now);
      if (running > quota.maxRunningSandboxes!) {
        await this.auditSandboxCap("budget.warned", subject, quota, running).run();
        break;
      }
    }
    return admission;
  }

  /** A session's owner and owning team in the global store, which the session's own storage does not hold. */
  async sessionOwnership(
    sessionId: string
  ): Promise<{ userId: string | null; teamId: string | null }> {
    const row = await this.db
      .prepare("SELECT user_id, owner_team_id FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ user_id: string | null; owner_team_id: string | null }>();
    return { userId: row?.user_id ?? null, teamId: row?.owner_team_id ?? null };
  }

  /** The caller's sandbox is live until `expiresAt`; keeps its slot current. */
  assertSandboxRunning(sessionId: string, expiresAt: number): Promise<void> {
    return this.runningSandboxes.assert({ sessionId, now: this.now(), expiresAt });
  }

  releaseSandbox(sessionId: string): Promise<void> {
    return this.runningSandboxes.release(sessionId);
  }

  /** A user's settled usage in each current period window, with their own quota rows. */
  async currentUsage(userId: string): Promise<CurrentUsageResponse> {
    const now = this.now();
    const scope: UsageScope = { kind: "user", id: userId };
    const quotas = await this.quotas.listForScopes([scope]);
    const periods = [];
    for (const period of USAGE_QUOTA_PERIODS) {
      const window = usagePeriodWindow(period, now);
      periods.push({
        ...window,
        usage: await this.ledger.sumForScope(scope, window),
        quota: quotas.find((quota) => quota.period === period) ?? null,
      });
    }
    return {
      userId,
      periods,
      runningSandboxes: await this.runningSandboxes.countForUser(userId, now),
    };
  }

  private async countAll(now: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM running_sandboxes WHERE expires_at > ?")
      .bind(now)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  private auditDecision(
    action: "budget.blocked" | "budget.warned",
    subject: PromptUsageSubject,
    violation: UsageQuotaViolation
  ) {
    return bindAppliedAuditEvent(this.db, {
      requestId: subject.requestId,
      actorUserId: subject.userId,
      action,
      resourceType: "session",
      resourceId: subject.sessionId,
      teamId: subject.teamId,
      targetUserId: subject.userId,
      before: { usage: violation.usage, window: violation.window },
      after: { quota: violation.quota, exceeded: violation.exceeded },
    });
  }

  private auditSandboxCap(
    action: "budget.blocked" | "budget.warned",
    subject: PromptUsageSubject,
    quota: UsageQuota,
    running: number
  ) {
    return bindAppliedAuditEvent(this.db, {
      requestId: subject.requestId,
      actorUserId: subject.userId,
      action,
      resourceType: "session",
      resourceId: subject.sessionId,
      teamId: subject.teamId,
      targetUserId: subject.userId,
      before: { runningSandboxes: running },
      after: { quota, exceeded: ["running_sandboxes"] },
    });
  }
}
