import { z } from "zod";

/**
 * Workspace usage quotas: period limits on metered turns, tokens and notional
 * cost, plus a cap on concurrently running sandboxes.
 *
 * A quota row limits the aggregate usage of its own scope — one user, one
 * team, or the whole workspace — over one period window. Usage is read from
 * the `usage_ledger`, which holds one row per settled turn, so a limit counts
 * turns that have finished, not turns still running.
 */

export const USAGE_QUOTA_SCOPE_KINDS = ["workspace", "team", "user"] as const;
export const usageQuotaScopeKindSchema = z.enum(USAGE_QUOTA_SCOPE_KINDS);
export type UsageQuotaScopeKind = z.infer<typeof usageQuotaScopeKindSchema>;

export const USAGE_QUOTA_PERIODS = ["day", "month"] as const;
export const usageQuotaPeriodSchema = z.enum(USAGE_QUOTA_PERIODS);
export type UsageQuotaPeriod = z.infer<typeof usageQuotaPeriodSchema>;

/** `warn` records an audit event and lets the work proceed; `block` refuses it. */
export const usageQuotaActionSchema = z.enum(["warn", "block"]);
export type UsageQuotaAction = z.infer<typeof usageQuotaActionSchema>;

/** A limit of `null` is unlimited for that meter. */
export const usageQuotaLimitsSchema = z.object({
  /** Notional on flat-fee model plans; compared against the ledger's reported cost. */
  maxCostUsd: z.number().finite().positive().nullable(),
  maxTurns: z.number().int().positive().nullable(),
  /** Input plus output tokens. */
  maxTokens: z.number().int().positive().nullable(),
  maxRunningSandboxes: z.number().int().positive().nullable(),
});
export type UsageQuotaLimits = z.infer<typeof usageQuotaLimitsSchema>;

export const USAGE_QUOTA_LIMIT_KEYS = [
  "maxCostUsd",
  "maxTurns",
  "maxTokens",
  "maxRunningSandboxes",
] as const satisfies readonly (keyof UsageQuotaLimits)[];

export const usageQuotaSchema = usageQuotaLimitsSchema
  .extend({
    id: z.string().min(1),
    scopeKind: usageQuotaScopeKindSchema,
    /** `null` for the workspace scope. */
    scopeId: z.string().min(1).nullable(),
    period: usageQuotaPeriodSchema,
    action: usageQuotaActionSchema,
    createdBy: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type UsageQuota = z.infer<typeof usageQuotaSchema>;

/**
 * Upserts by `(scopeKind, scopeId, period)`. Limits left out are unlimited,
 * so a request replaces the whole row rather than patching it; at least one
 * limit must be set.
 */
export const upsertUsageQuotaRequestSchema = z
  .strictObject({
    scopeKind: usageQuotaScopeKindSchema,
    scopeId: z.string().min(1).nullable().optional(),
    period: usageQuotaPeriodSchema.default("month"),
    maxCostUsd: usageQuotaLimitsSchema.shape.maxCostUsd.default(null),
    maxTurns: usageQuotaLimitsSchema.shape.maxTurns.default(null),
    maxTokens: usageQuotaLimitsSchema.shape.maxTokens.default(null),
    maxRunningSandboxes: usageQuotaLimitsSchema.shape.maxRunningSandboxes.default(null),
    action: usageQuotaActionSchema.default("block"),
  })
  .transform((value) => ({ ...value, scopeId: value.scopeId ?? null }))
  .superRefine((value, context) => {
    if ((value.scopeKind === "workspace") !== (value.scopeId === null)) {
      context.addIssue({
        code: "custom",
        path: ["scopeId"],
        message:
          value.scopeKind === "workspace"
            ? "A workspace quota has no scopeId"
            : `A ${value.scopeKind} quota needs a scopeId`,
      });
    }
    if (USAGE_QUOTA_LIMIT_KEYS.every((key) => value[key] === null)) {
      context.addIssue({
        code: "custom",
        path: ["maxTurns"],
        message: "Set at least one limit",
      });
    }
  });
export type UpsertUsageQuotaRequest = z.infer<typeof upsertUsageQuotaRequestSchema>;

export const usageQuotaListResponseSchema = z.object({ quotas: z.array(usageQuotaSchema) });
export type UsageQuotaListResponse = z.infer<typeof usageQuotaListResponseSchema>;

/** Settled usage of one scope inside one period window. */
export const usagePeriodTotalsSchema = z.object({
  turns: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type UsagePeriodTotals = z.infer<typeof usagePeriodTotalsSchema>;

export const usagePeriodWindowSchema = z.object({
  period: usageQuotaPeriodSchema,
  /** Inclusive start, exclusive end, in epoch milliseconds (UTC day or calendar month). */
  startAt: z.number().int().nonnegative(),
  endAt: z.number().int().nonnegative(),
});
export type UsagePeriodWindow = z.infer<typeof usagePeriodWindowSchema>;

export const currentUsageResponseSchema = z.object({
  userId: z.string().min(1),
  periods: z.array(
    usagePeriodWindowSchema.extend({
      usage: usagePeriodTotalsSchema,
      /** The user-scoped quota for this period when one exists. */
      quota: usageQuotaSchema.nullable(),
    })
  ),
  runningSandboxes: z.number().int().nonnegative(),
});
export type CurrentUsageResponse = z.infer<typeof currentUsageResponseSchema>;

/**
 * The period window containing `now`: the UTC calendar day or month. The
 * ledger is keyed by `settled_at`, so a turn belongs to the window in which
 * it finished, and the window rolls over at the UTC boundary.
 */
export function usagePeriodWindow(period: UsageQuotaPeriod, now: number): UsagePeriodWindow {
  const date = new Date(now);
  if (period === "day") {
    const startAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return { period, startAt, endAt: startAt + 86_400_000 };
  }
  return {
    period,
    startAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    endAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}

/** The meters a quota row's usage exceeds; empty when it is within every set limit. */
export function exceededUsageLimits(
  limits: Pick<UsageQuotaLimits, "maxCostUsd" | "maxTurns" | "maxTokens">,
  usage: UsagePeriodTotals
): ("turns" | "tokens" | "cost")[] {
  const exceeded: ("turns" | "tokens" | "cost")[] = [];
  if (limits.maxTurns !== null && usage.turns >= limits.maxTurns) exceeded.push("turns");
  if (limits.maxTokens !== null && usage.tokens >= limits.maxTokens) exceeded.push("tokens");
  if (limits.maxCostUsd !== null && usage.costUsd >= limits.maxCostUsd) exceeded.push("cost");
  return exceeded;
}
