/**
 * One inbound activity, end to end: the tenant gate, the serviceUrl
 * allowlist, redelivery dedupe, then the command it carries. Work on one
 * thread runs serially so a follow-up cannot overtake the launch it answers.
 */

import type { ActivityAddress, BotFrameworkClient } from "../bot-framework/client";
import { isAllowedServiceUrl } from "../bot-framework/service-url";
import type { ControlPlaneClient } from "../control-plane/client";
import { microsoftActor } from "../control-plane/client";
import { asError, type Logger } from "../logger";
import type { TeamsStateStore, ThreadSessionRecord } from "../state/store";
import {
  checkTeamsActivity,
  formatQuotedReplyContext,
  normalizeTeamsText,
  teamsGetSenderObjectId,
  teamsQuotedReplyContext,
  teamsThreadKey,
} from "../teams/message";
import { WORKING_TEXT } from "../teams/reply-sink";
import type { TeamsActivity } from "../types";
import { parseCommand, type Command } from "./commands";
import { launchSession, renderFailure, resolveModelSelection } from "./launcher";
import {
  FOLLOW_UP_FAILED_MESSAGE,
  HELP_TEXT,
  NO_IDENTITY_MESSAGE,
  NO_SESSION_IN_THREAD_MESSAGE,
  SESSION_NOT_ACCESSIBLE_MESSAGE,
  sessionUrl,
  STOP_FAILED_MESSAGE,
  STOP_REQUESTED_MESSAGE,
  THREAD_CLOSED_MESSAGE,
} from "./messages";

export interface ActivityHandlerDeps {
  tenantId: string;
  allowedServiceUrlHosts: readonly string[];
  webAppUrl: string;
  controlPlane: ControlPlaneClient;
  bot: BotFrameworkClient;
  store: TeamsStateStore;
  log: Logger;
  /** The per-thread queue, shared with the callback routes so both sides take turns on a thread. */
  enqueue?: KeyedQueue;
}

export type ActivityHandler = (activity: TeamsActivity, traceId: string) => Promise<void>;

export type KeyedQueue = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/** Runs tasks for the same key one after another; different keys run concurrently. */
export function createKeyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<unknown>>();
  return (key, task) => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    tails.set(key, settled);
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return run;
  };
}

interface ThreadContext {
  activity: TeamsActivity;
  threadKey: string;
  address: ActivityAddress;
  rootActivityId: string;
  actor: string;
  traceId: string;
}

function accountOf(value: { id?: string; name?: string } | undefined) {
  return value?.id ? { id: value.id, ...(value.name ? { name: value.name } : {}) } : undefined;
}

export function createActivityHandler(deps: ActivityHandlerDeps): ActivityHandler {
  const enqueue = deps.enqueue ?? createKeyedQueue();

  const reply = (ctx: ThreadContext, text: string) =>
    deps.bot.replyToActivity(ctx.address, ctx.rootActivityId, text);

  async function handleStatus(ctx: ThreadContext, thread: ThreadSessionRecord | null) {
    if (!thread) {
      await reply(ctx, NO_SESSION_IN_THREAD_MESSAGE);
      return;
    }
    let state = thread.closed ? "closed" : thread.turnState === "working" ? "working" : "idle";
    if (!thread.closed) {
      const processing = await deps.controlPlane.listMessages(
        ctx.actor,
        thread.sessionId,
        { status: "processing", limit: 1 },
        ctx.traceId
      );
      if (processing.ok) state = processing.data.length > 0 ? "working" : "idle";
      else if (processing.reason === "not_enrolled" || processing.reason === "forbidden") {
        await reply(ctx, renderFailure(processing, deps.webAppUrl, FOLLOW_UP_FAILED_MESSAGE));
        return;
      }
    }
    const lines = [
      `**Session** ${sessionUrl(deps.webAppUrl, thread.sessionId)}`,
      `- Repository: ${thread.repoFullName ?? "none"}`,
      `- Model: ${thread.model}${thread.reasoningEffort ? ` (${thread.reasoningEffort})` : ""}`,
      `- State: ${state}`,
      `- Started: ${new Date(thread.createdAt).toISOString()}`,
    ];
    await reply(ctx, lines.join("\n"));
  }

  async function handleStop(ctx: ThreadContext, thread: ThreadSessionRecord | null) {
    if (!thread || thread.closed) {
      await reply(ctx, thread ? THREAD_CLOSED_MESSAGE : NO_SESSION_IN_THREAD_MESSAGE);
      return;
    }
    const result = await deps.controlPlane.stopSession(ctx.actor, thread.sessionId, ctx.traceId);
    if (!result.ok) {
      await reply(ctx, renderFailure(result, deps.webAppUrl, STOP_FAILED_MESSAGE));
      return;
    }
    deps.store.updateThreadSession(ctx.threadKey, { turnState: "idle" });
    await reply(ctx, STOP_REQUESTED_MESSAGE);
  }

  async function handleFollowUp(
    ctx: ThreadContext,
    thread: ThreadSessionRecord,
    command: Extract<Command, { kind: "prompt" }>
  ) {
    if (thread.closed) {
      await reply(ctx, THREAD_CLOSED_MESSAGE);
      return;
    }
    const selection = resolveModelSelection(command.options, {
      model: thread.model,
      reasoningEffort: thread.reasoningEffort ?? undefined,
    });
    if (!selection.ok) {
      await reply(ctx, selection.error);
      return;
    }
    const overrides =
      command.options.model || command.options.reasoningEffort ? selection.selection : {};
    const content = formatQuotedReplyContext(teamsQuotedReplyContext(ctx.activity)) + command.text;
    const prompt = await deps.controlPlane.sendPrompt(
      ctx.actor,
      thread.sessionId,
      {
        content,
        ...overrides,
        callbackContext: {
          source: "msteams",
          conversationId: ctx.threadKey,
          serviceUrl: ctx.address.serviceUrl,
          replyToId: ctx.rootActivityId,
          ...(thread.channelId ? { channelId: thread.channelId } : {}),
          ...(thread.repoFullName ? { repoFullName: thread.repoFullName } : {}),
          model: selection.selection.model,
        },
      },
      ctx.traceId
    );
    if (!prompt.ok) {
      if (prompt.reason === "not_found") {
        // The control plane also answers 404 when THIS user may not read the
        // session (private, or team enforcement), so only the user who started
        // it can tell us the session is really gone; anyone else is told they
        // cannot reach it, and the thread stays open for its owner.
        if (thread.actor === ctx.actor) {
          deps.store.closeThreadSession(ctx.threadKey, thread.sessionId);
          await reply(ctx, THREAD_CLOSED_MESSAGE);
          return;
        }
        deps.log.info("follow_up.denied", {
          trace_id: ctx.traceId,
          thread_key: ctx.threadKey,
          session_id: thread.sessionId,
          http_status: prompt.status,
        });
        await reply(ctx, SESSION_NOT_ACCESSIBLE_MESSAGE);
        return;
      }
      await reply(ctx, renderFailure(prompt, deps.webAppUrl, FOLLOW_UP_FAILED_MESSAGE));
      return;
    }
    const working = await reply(ctx, WORKING_TEXT);
    deps.store.updateThreadSession(ctx.threadKey, {
      progressActivityId: working.id || null,
      lastMessageId: prompt.data.messageId,
      turnState: "working",
    });
    if (working.id) deps.store.putTurnPlaceholder(ctx.threadKey, prompt.data.messageId, working.id);
    deps.log.info("follow_up.sent", {
      trace_id: ctx.traceId,
      thread_key: ctx.threadKey,
      session_id: thread.sessionId,
      message_id: prompt.data.messageId,
    });
  }

  async function dispatch(ctx: ThreadContext): Promise<void> {
    const thread = deps.store.getThreadSession(ctx.threadKey);
    const text = normalizeTeamsText(ctx.activity);
    const command = parseCommand(text, { inThread: thread !== null });
    switch (command.kind) {
      case "help":
        await reply(ctx, HELP_TEXT);
        return;
      case "error":
        await reply(ctx, command.message);
        return;
      case "status":
        await handleStatus(ctx, thread);
        return;
      case "stop":
        await handleStop(ctx, thread);
        return;
      case "prompt":
        if (thread) {
          await handleFollowUp(ctx, thread, command);
          return;
        }
        await launchSession(
          {
            controlPlane: deps.controlPlane,
            bot: deps.bot,
            store: deps.store,
            log: deps.log,
            webAppUrl: deps.webAppUrl,
          },
          {
            activity: ctx.activity,
            threadKey: ctx.threadKey,
            address: ctx.address,
            rootActivityId: ctx.rootActivityId,
            actor: ctx.actor,
            repo: command.repo,
            prompt: formatQuotedReplyContext(teamsQuotedReplyContext(ctx.activity)) + command.text,
            options: command.options,
            traceId: ctx.traceId,
          }
        );
        return;
    }
  }

  return async (activity, traceId) => {
    const logBase = {
      trace_id: traceId,
      activity_id: activity.id,
      conversation_id: activity.conversation?.id,
    };
    const gate = checkTeamsActivity(activity, deps.tenantId);
    if (!gate.ok) {
      deps.log.warn("activity.dropped", { ...logBase, reject_reason: gate.reason });
      return;
    }
    if (!isAllowedServiceUrl(activity.serviceUrl, deps.allowedServiceUrlHosts)) {
      deps.log.warn("activity.dropped", {
        ...logBase,
        reject_reason: "service_url_not_allowed",
        service_url: typeof activity.serviceUrl === "string" ? activity.serviceUrl : undefined,
      });
      return;
    }
    const serviceUrl = activity.serviceUrl;
    if (
      activity.from?.id &&
      activity.recipient?.id &&
      activity.from.id.toLowerCase() === activity.recipient.id.toLowerCase()
    ) {
      deps.log.debug("activity.dropped", { ...logBase, reject_reason: "own_message" });
      return;
    }
    const threadKey = teamsThreadKey(activity);
    const rootActivityId = activity.replyToId ?? activity.id;
    if (!threadKey || !rootActivityId) {
      deps.log.warn("activity.dropped", { ...logBase, reject_reason: "no_conversation" });
      return;
    }
    if (activity.id && !deps.store.claimInboundActivity(activity.id)) {
      deps.log.info("activity.dropped", { ...logBase, reject_reason: "duplicate" });
      return;
    }
    const address: ActivityAddress = {
      serviceUrl,
      conversationId: threadKey,
      bot: accountOf(activity.recipient),
      user: accountOf(activity.from),
    };
    const oid = teamsGetSenderObjectId(activity);
    if (!oid) {
      deps.log.warn("activity.dropped", { ...logBase, reject_reason: "no_aad_object_id" });
      await deps.bot.replyToActivity(address, rootActivityId, NO_IDENTITY_MESSAGE);
      return;
    }
    const ctx: ThreadContext = {
      activity,
      threadKey,
      address,
      rootActivityId,
      actor: microsoftActor(oid),
      traceId,
    };
    await enqueue(threadKey, async () => {
      try {
        await dispatch(ctx);
      } catch (error) {
        deps.log.error("activity.failed", {
          ...logBase,
          thread_key: threadKey,
          error: asError(error),
        });
      }
    });
  };
}
