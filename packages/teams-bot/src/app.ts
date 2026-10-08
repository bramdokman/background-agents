/**
 * The HTTP surface: `GET /healthz`, and `POST /api/messages` where the Bot
 * Framework connector delivers activities. The route authenticates the
 * bearer token before it reads a byte of the body, reads the body under a
 * streaming cap, binds the token to the parsed activity, acknowledges within
 * the connector's deadline, and hands the activity to the handler in the
 * background. The control plane's callback routes mount under `/callbacks`
 * (see callbacks/routes.ts).
 */

import { readBodyCapped } from "@open-inspect/shared/http-body";
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
  /** The `/callbacks/*` routes; absent only in tests of the inbound path alone. */
  callbacks?: Hono;
}

function isActivity(value: unknown): value is TeamsActivity {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A declared length over the cap is refused before the body is touched; anything else is checked while reading. */
function declaresOversizedBody(contentLength: string | undefined): boolean {
  const declared = Number.parseInt(contentLength ?? "", 10);
  return Number.isFinite(declared) && declared > MAX_ACTIVITY_BODY_BYTES;
}

function parseActivity(bytes: Uint8Array): TeamsActivity | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return isActivity(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
  if (deps.callbacks) app.route("/callbacks", deps.callbacks);

  app.post("/api/messages", async (c) => {
    const startedAt = Date.now();
    const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
    const logBase = { trace_id: traceId, http_method: "POST", http_path: "/api/messages" };
    const rejected = (status: 400 | 401 | 413, reason: string, error: string) => {
      deps.log.warn("http.request", {
        ...logBase,
        http_status: status,
        outcome: "rejected",
        reject_reason: reason,
        duration_ms: Date.now() - startedAt,
      });
      return c.json({ error }, status);
    };

    // The token first: this is the one public route, and nobody without a
    // valid token gets the bot to buffer or parse anything on their behalf.
    const auth = await deps.auth.authenticate(c.req.header("authorization"));
    if (!auth.ok) return rejected(401, auth.reason, "unauthorized");

    if (declaresOversizedBody(c.req.header("content-length"))) {
      return rejected(413, "payload_too_large", "payload too large");
    }
    const bytes = await readBodyCapped(c.req.raw.body, MAX_ACTIVITY_BODY_BYTES);
    if (bytes === null) return rejected(413, "payload_too_large", "payload too large");
    const activity = parseActivity(bytes);
    if (!activity) return rejected(400, "invalid_payload", "invalid payload");

    const bound = deps.auth.bindActivity(auth.claims, activity);
    if (!bound.ok) return rejected(401, bound.reason, "unauthorized");

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
