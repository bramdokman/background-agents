import { Hono } from "hono";
import {
  currentUsageResponseSchema,
  upsertUsageQuotaRequestSchema,
  usageQuotaListResponseSchema,
  usageQuotaSchema,
} from "@open-inspect/shared/types/usage-quotas";
import { UsageQuotaService } from "../authorization/usage-quotas";
import { UsageQuotaStore } from "../db/usage-quotas";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

async function listQuotas(_request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  return json(
    usageQuotaListResponseSchema.parse({ quotas: await new UsageQuotaStore(ctx.db).list() })
  );
}

/** Replaces the row for the request's scope and period; limits left out become unlimited. */
async function upsertQuota(request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  const body = await parseBody(request, upsertUsageQuotaRequestSchema);
  if (body instanceof Response) return body;
  const quota = await new UsageQuotaStore(ctx.db).upsert(body, {
    actorUserId: ctx.principal.userId,
    requestId: ctx.request_id,
  });
  return json(usageQuotaSchema.parse(quota));
}

async function deleteQuota(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserRouteContext
) {
  const removed = await new UsageQuotaStore(ctx.db).remove(params.id, {
    actorUserId: ctx.principal.userId,
    requestId: ctx.request_id,
  });
  return removed ? new Response(null, { status: 204 }) : error("Usage quota not found", 404);
}

/** A user's settled usage in the current day and month windows, with their own quota rows. */
async function currentUsage(
  _request: Request,
  _env: Env,
  params: { userId: string },
  ctx: UserRouteContext
) {
  return json(
    currentUsageResponseSchema.parse(
      await new UsageQuotaService(ctx.db).currentUsage(params.userId)
    )
  );
}

export const usageQuotaRoutes = new Hono<ControlPlaneHonoEnv>();
const manage = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  cacheControl: "private, no-store",
  authorization: requirePermission("usage_quotas.manage", { service: "deny" }),
});
usageQuotaRoutes.get("/usage-quotas", manage, (c) => dispatch(c, listQuotas));
usageQuotaRoutes.put("/usage-quotas", manage, (c) => dispatch(c, upsertQuota));
usageQuotaRoutes.delete("/usage-quotas/:id", manage, (c) => dispatch(c, deleteQuota));
usageQuotaRoutes.get("/usage-quotas/usage/:userId", manage, (c) => dispatch(c, currentUsage));
