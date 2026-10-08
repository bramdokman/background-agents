/**
 * The bot's outbound control-plane calls: sig1-signed as "teams-bot" with
 * SERVICE_AUTH_SECRET_TEAMS_BOT, asserting the Teams user as actor
 * `microsoft:<aadObjectId>`. All signing mechanics live in
 * `@open-inspect/shared/service-auth`; this module binds the service name,
 * the base URL and the response shapes, and turns every non-2xx into a
 * classified failure the command layer can render.
 */

import { signedControlPlaneFetch, type FetchClient } from "@open-inspect/shared/service-auth";
import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
  type CreateSessionResponse,
  type MsTeamsCallbackContext,
  type SendPromptResponse,
} from "@open-inspect/shared/types/session-api";
import {
  channelBindingResponseSchema,
  type ChannelBindingResponse,
} from "@open-inspect/shared/types/team-channel-bindings";
import {
  controlPlaneReposResponseSchema,
  type InstallationRepository,
} from "@open-inspect/shared/types/repository-catalog";
import { sessionMessageSchema, type SessionMessage } from "@open-inspect/shared/types/sessions";
import {
  listArtifactsResponseSchema,
  type ArtifactResponse,
} from "@open-inspect/shared/types/artifacts";
import {
  listEventsResponseSchema,
  type EventResponse,
} from "@open-inspect/shared/types/sandbox-events";
import { z } from "zod";
import { asError, type Logger } from "../logger";
import type { FetchFn } from "../types";

const OUTBOUND_REQUEST_TIMEOUT_MS = 20_000;

/** The events route's server-side page limit. */
const EVENTS_PAGE_LIMIT = 200;
/** Pages of events one completion may read; a turn that produced more is rendered from these. */
const EVENTS_MAX_PAGES = 25;

/** The actor namespace the control plane enrols web sign-ins under; Teams surfaces the same oid. */
export function microsoftActor(aadObjectId: string): string {
  return `microsoft:${aadObjectId}`;
}

/** The `channel` query coordinate for a Teams channel; the id keeps its own `:` and `@`. */
export function msteamsChannelScope(channelId: string): string {
  return `msteams:${channelId}`;
}

/** Why a control-plane call did not succeed, from the response the bot renders. */
type ControlPlaneFailureReason =
  "not_enrolled" | "quota" | "forbidden" | "not_found" | "invalid" | "transient";

export interface ControlPlaneFailure {
  ok: false;
  reason: ControlPlaneFailureReason;
  status: number;
  code?: string;
  /** The control plane's own error text, when it sent one. */
  message?: string;
}

export type ControlPlaneResult<T> = { ok: true; data: T } | ControlPlaneFailure;

export type ChannelBindingLookup =
  | { kind: "resolved"; binding: ChannelBindingResponse }
  | { kind: "rejected" }
  | { kind: "unavailable"; status?: number };

export interface CreateSessionInput {
  teamId: string;
  repoOwner: string;
  repoName: string;
  model: string;
  reasoningEffort?: string;
  actorDisplayName?: string;
}

export interface SendPromptInput {
  content: string;
  model?: string;
  reasoningEffort?: string;
  callbackContext: MsTeamsCallbackContext;
}

export interface ControlPlaneClientOptions {
  baseUrl: string;
  secret: string;
  fetch?: FetchFn;
  log?: Logger;
  timeoutMs?: number;
}

const sessionMessagesPageSchema = z.object({ messages: z.array(sessionMessageSchema) });

async function classifyFailure(response: Response): Promise<ControlPlaneFailure> {
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code : undefined;
  const message = typeof record.error === "string" ? record.error : undefined;
  const status = response.status;
  const reason: ControlPlaneFailureReason =
    status === 403 && code === "service_actor_not_enrolled"
      ? "not_enrolled"
      : status === 429 && code === "USAGE_QUOTA_EXCEEDED"
        ? "quota"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not_found"
            : status === 400 || status === 409 || status === 422
              ? "invalid"
              : "transient";
  return { ok: false, reason, status, ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

export class ControlPlaneClient {
  private readonly env: { SERVICE_AUTH_SECRET: string; CONTROL_PLANE: FetchClient };
  private readonly baseUrl: string;
  private readonly log: Logger | undefined;
  private readonly timeoutMs: number;

  constructor(options: ControlPlaneClientOptions) {
    const fetchFn = options.fetch ?? fetch;
    this.env = {
      SERVICE_AUTH_SECRET: options.secret,
      CONTROL_PLANE: { fetch: (input, init) => fetchFn(input, init) },
    };
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.log = options.log;
    this.timeoutMs = options.timeoutMs ?? OUTBOUND_REQUEST_TIMEOUT_MS;
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private async request<T>(
    operation: string,
    request: {
      method: "GET" | "POST";
      url: string;
      body?: string;
      actor?: string;
      traceId?: string;
    },
    parse: (payload: unknown) => T
  ): Promise<ControlPlaneResult<T>> {
    const startedAt = Date.now();
    const base = {
      trace_id: request.traceId,
      http_method: request.method,
      http_path: new URL(request.url).pathname,
    };
    try {
      const response = await signedControlPlaneFetch("teams-bot", this.env, request, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        const failure = await classifyFailure(response);
        this.log?.warn(operation, {
          ...base,
          outcome: "error",
          http_status: response.status,
          reject_reason: failure.reason,
          code: failure.code,
          duration_ms: Date.now() - startedAt,
        });
        return failure;
      }
      const payload: unknown = await response.json().catch(() => null);
      let data: T;
      try {
        data = parse(payload);
      } catch (error) {
        this.log?.error(operation, {
          ...base,
          outcome: "error",
          http_status: response.status,
          error: asError(error),
          duration_ms: Date.now() - startedAt,
        });
        return { ok: false, reason: "transient", status: response.status };
      }
      this.log?.info(operation, {
        ...base,
        outcome: "success",
        http_status: response.status,
        duration_ms: Date.now() - startedAt,
      });
      return { ok: true, data };
    } catch (error) {
      this.log?.error(operation, {
        ...base,
        outcome: "error",
        error: asError(error),
        duration_ms: Date.now() - startedAt,
      });
      return { ok: false, reason: "transient", status: 0 };
    }
  }

  /** Binding reads are authority: never cached, and a lookup failure is never treated as "bound". */
  async lookupChannelBinding(channelId: string, traceId?: string): Promise<ChannelBindingLookup> {
    const result = await this.request(
      "control_plane.channel_binding",
      {
        method: "GET",
        url: this.url(`/channel-bindings/msteams/${encodeURIComponent(channelId)}`),
        traceId,
      },
      (payload) => channelBindingResponseSchema.parse(payload)
    );
    if (result.ok) return { kind: "resolved", binding: result.data };
    if (result.status === 404 && result.code === "channel_unbound") return { kind: "rejected" };
    return { kind: "unavailable", status: result.status };
  }

  /**
   * The repositories the channel's team may use, as the actor sees them. The
   * scope is the channel (`channel=msteams:<channelId>`): the control plane
   * derives the team from the live binding and refuses a `teamId` from a
   * channel-scoped bot, so the bot never names the team itself.
   */
  listRepositories(
    actor: string,
    channelId: string,
    traceId?: string
  ): Promise<ControlPlaneResult<InstallationRepository[]>> {
    return this.request(
      "control_plane.list_repositories",
      {
        method: "GET",
        url: this.url("/repos", { channel: msteamsChannelScope(channelId) }),
        actor,
        traceId,
      },
      (payload) => controlPlaneReposResponseSchema.parse(payload).repos
    );
  }

  createSession(
    actor: string,
    input: CreateSessionInput,
    traceId?: string
  ): Promise<ControlPlaneResult<CreateSessionResponse>> {
    const body = JSON.stringify({
      teamId: input.teamId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      model: input.model,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.actorDisplayName ? { actorDisplayName: input.actorDisplayName } : {}),
    });
    return this.request(
      "control_plane.create_session",
      { method: "POST", url: this.url("/sessions"), body, actor, traceId },
      (payload) => createSessionResponseSchema.parse(payload)
    );
  }

  sendPrompt(
    actor: string,
    sessionId: string,
    input: SendPromptInput,
    traceId?: string
  ): Promise<ControlPlaneResult<SendPromptResponse>> {
    const body = JSON.stringify({
      content: input.content,
      source: "msteams",
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      callbackContext: input.callbackContext,
    });
    return this.request(
      "control_plane.send_prompt",
      {
        method: "POST",
        url: this.url(`/sessions/${encodeURIComponent(sessionId)}/prompt`),
        body,
        actor,
        traceId,
      },
      (payload) => sendPromptResponseSchema.parse(payload)
    );
  }

  stopSession(
    actor: string,
    sessionId: string,
    traceId?: string
  ): Promise<ControlPlaneResult<unknown>> {
    return this.request(
      "control_plane.stop_session",
      {
        method: "POST",
        url: this.url(`/sessions/${encodeURIComponent(sessionId)}/stop`),
        body: "{}",
        actor,
        traceId,
      },
      (payload) => payload
    );
  }

  /** A page of the session's messages; `status` narrows to one message status. */
  listMessages(
    actor: string,
    sessionId: string,
    query: { status?: "pending" | "processing" | "completed" | "failed"; limit?: number },
    traceId?: string
  ): Promise<ControlPlaneResult<SessionMessage[]>> {
    return this.request(
      "control_plane.list_messages",
      {
        method: "GET",
        url: this.url(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
          status: query.status,
          limit: query.limit === undefined ? undefined : String(query.limit),
        }),
        actor,
        traceId,
      },
      (payload) => sessionMessagesPageSchema.parse(payload).messages
    );
  }

  /** Every persisted event of one message, oldest page first, following the cursor. */
  async listEvents(
    actor: string,
    sessionId: string,
    messageId: string,
    traceId?: string
  ): Promise<ControlPlaneResult<EventResponse[]>> {
    const events: EventResponse[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < EVENTS_MAX_PAGES; page++) {
      const result = await this.request(
        "control_plane.list_events",
        {
          method: "GET",
          url: this.url(`/sessions/${encodeURIComponent(sessionId)}/events`, {
            message_id: messageId,
            limit: String(EVENTS_PAGE_LIMIT),
            cursor,
          }),
          actor,
          traceId,
        },
        (payload) => listEventsResponseSchema.parse(payload)
      );
      if (!result.ok) return result;
      events.push(...result.data.events);
      cursor = result.data.hasMore ? result.data.cursor : undefined;
      if (!cursor) break;
    }
    return { ok: true, data: events };
  }

  /** The session's artifacts (pull requests, branches, media). */
  listArtifacts(
    actor: string,
    sessionId: string,
    traceId?: string
  ): Promise<ControlPlaneResult<ArtifactResponse[]>> {
    return this.request(
      "control_plane.list_artifacts",
      {
        method: "GET",
        url: this.url(`/sessions/${encodeURIComponent(sessionId)}/artifacts`),
        actor,
        traceId,
      },
      (payload) => listArtifactsResponseSchema.parse(payload).artifacts
    );
  }
}
