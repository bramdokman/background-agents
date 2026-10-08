/**
 * The HTTP surface: `GET /healthz`, and `POST /api/messages` where the Bot
 * Framework connector delivers activities. The route authenticates the
 * bearer token, acknowledges within the connector's deadline, and hands the
 * activity to the handler in the background. Callback routes arrive in
 * stage 2.
 */

import { Hono } from "hono";
import type { InboundAuthenticator } from "./bot-framework/auth";
import { asError, type Logger } from "./logger";
import type { ActivityHandler } from "./sessions/handler";
import type { TeamsActivity } from "./types";

/** Teams messages are small; anything bigger is not an activity. */
const MAX_ACTIVITY_BODY_BYTES = 256 * 1024;

type BackgroundTaskScheduler = (task: Promise<void>) => void;

export interface AppDeps {
  auth: InboundAuthenticator;
  handleActivity: ActivityHandler;
  log: Logger;
  /** Where the handler's promise goes after the 200; tests collect it. */
  schedule?: BackgroundTaskScheduler;
}

function isActivity(value: unknown): value is TeamsActivity {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createApp(deps: AppDeps): Hono {
  const schedule: BackgroundTaskScheduler =
    deps.schedule ??
    ((task) => {
      task.catch((error: unknown) => {
        deps.log.error("activity.unhandled", { error: asError(error) });
      });
    });
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok", service: "open-inspect-teams-bot" }));

  app.post("/api/messages", async (c) => {
    const startedAt = Date.now();
    const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
    const logBase = { trace_id: traceId, http_method: "POST", http_path: "/api/messages" };
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_ACTIVITY_BODY_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_ACTIVITY_BODY_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }
    let activity: unknown;
    try {
      activity = JSON.parse(raw);
    } catch {
      activity = undefined;
    }
    if (!isActivity(activity)) {
      deps.log.warn("http.request", {
        ...logBase,
        http_status: 400,
        outcome: "rejected",
        reject_reason: "invalid_payload",
        duration_ms: Date.now() - startedAt,
      });
      return c.json({ error: "invalid payload" }, 400);
    }

    const auth = await deps.auth.authenticate(c.req.header("authorization"), activity);
    if (!auth.ok) {
      deps.log.warn("http.request", {
        ...logBase,
        http_status: 401,
        outcome: "rejected",
        reject_reason: auth.reason,
        duration_ms: Date.now() - startedAt,
      });
      return c.json({ error: "unauthorized" }, 401);
    }

    schedule(deps.handleActivity(activity, traceId));
    deps.log.info("http.request", {
      ...logBase,
      http_status: 200,
      activity_id: activity.id,
      activity_type: activity.type,
      duration_ms: Date.now() - startedAt,
    });
    return c.json({}, 200);
  });

  return app;
}
