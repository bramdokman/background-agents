/**
 * What happens when the control plane says a turn is over: the agent's
 * answer and artifacts are read back from the session, rendered as one
 * Teams message, and written over the "Working..." reply (or posted fresh
 * when that reply cannot be edited, or belongs to a later turn). The same
 * module posts the closure note when the control plane withdraws a thread.
 *
 * Exactly one final message per `(messageId)`: the delivery claim in SQLite
 * is taken before anything is posted and given back only when posting
 * failed, so the control plane's retry gets through and a duplicate does
 * nothing. Reads happen as the user who started the session; when they fail,
 * the final message still goes out with the session link, since a retry
 * would not change the answer.
 */

import {
  buildAgentResponseFromEvents,
  getArtifactLabelFromArtifact,
  summarizeToolCall,
} from "@open-inspect/shared/completion/extractor";
import type { AgentResponse, ArtifactInfo } from "@open-inspect/shared/types/artifacts";
import type { EventResponse } from "@open-inspect/shared/types/sandbox-events";
import {
  referenceAddress,
  type ActivityAddress,
  type BotFrameworkClient,
} from "../bot-framework/client";
import type { CallbackContext, ThreadCoordinates, ToolCallCallback } from "../callbacks/schemas";
import type { ControlPlaneClient } from "../control-plane/client";
import { asError, type Logger } from "../logger";
import type { TeamsStateStore, ThreadSessionRecord } from "../state/store";
import { updateOrPost } from "../teams/reply-sink";
import {
  AGENT_COMPLETED_MESSAGE,
  agentFailedMessage,
  CREATE_PR_LABEL,
  CREATED_HEADING,
  OPEN_SESSION_LABEL,
  sessionUrl,
  THREAD_CLOSED_MESSAGE,
  TRUNCATED_NOTE,
} from "./messages";
import type { ProgressRenderer } from "./progress";

/** Teams rejects messages around 28 KB; the answer is cut well before that and the session link remains. */
const MAX_ANSWER_CHARS = 20_000;
const MAX_ERROR_CHARS = 2_000;

const COMPLETE_KIND = "complete";
const THREAD_CLOSED_KIND = "thread_closed";

export interface CompletionDeps {
  store: TeamsStateStore;
  bot: BotFrameworkClient;
  controlPlane: ControlPlaneClient;
  progress: ProgressRenderer;
  webAppUrl: string;
  log: Logger;
}

export type DeliveryOutcome = "delivered" | "duplicate" | "skipped";

/** The thread a callback addresses, when the store maps it to the callback's session. */
function threadFor(
  store: TeamsStateStore,
  threadKey: string,
  sessionId: string
): ThreadSessionRecord | null {
  const thread = store.getThreadSession(threadKey);
  return thread && thread.sessionId === sessionId ? thread : null;
}

/**
 * Where to post: the stored conversation reference when there is one (it
 * carries the bot and user accounts the connector expects), else the
 * coordinates the control plane echoed back. The client re-checks the
 * serviceUrl against the allowlist either way.
 */
function resolveAddress(
  store: TeamsStateStore,
  threadKey: string,
  coordinates: ThreadCoordinates,
  thread: ThreadSessionRecord | null
): { address: ActivityAddress; replyToId: string | undefined } {
  const reference = store.getConversationReference(threadKey);
  const address: ActivityAddress = reference
    ? { ...referenceAddress(reference), conversationId: threadKey }
    : { serviceUrl: thread?.serviceUrl ?? coordinates.serviceUrl, conversationId: threadKey };
  if (!address.serviceUrl) address.serviceUrl = coordinates.serviceUrl;
  const replyToId = coordinates.replyToId ?? thread?.rootActivityId ?? reference?.activityId;
  return { address, replyToId };
}

function eventRange(events: readonly EventResponse[]): { start: number; end: number } | null {
  if (events.length === 0) return null;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    start = Math.min(start, event.createdAt);
    end = Math.max(end, event.createdAt);
  }
  return { start, end };
}

/**
 * The agent's response to one message, read as `actor`. Mirrors the shared
 * extractor's aggregation (events, then the session's artifacts in the
 * message's time range) through this bot's signed client; `null` when the
 * events could not be read.
 */
export async function fetchAgentResponse(
  controlPlane: ControlPlaneClient,
  actor: string,
  sessionId: string,
  messageId: string,
  traceId?: string
): Promise<AgentResponse | null> {
  const events = await controlPlane.listEvents(actor, sessionId, messageId, traceId);
  if (!events.ok) return null;
  const artifacts = await controlPlane.listArtifacts(actor, sessionId, traceId);
  const range = eventRange(events.data);
  const infos: ArtifactInfo[] = artifacts.ok
    ? artifacts.data
        .filter((artifact) => artifact.type !== "screenshot" && artifact.type !== "video")
        .filter(
          (artifact) =>
            range !== null && artifact.createdAt >= range.start && artifact.createdAt <= range.end
        )
        .map((artifact) => ({
          type: artifact.type,
          url: artifact.url ?? "",
          label: getArtifactLabelFromArtifact(artifact.type, artifact.metadata),
          metadata: artifact.metadata ?? null,
        }))
    : [];
  return buildAgentResponseFromEvents(events.data, infos);
}

export function truncateError(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function manualCreatePrUrl(artifacts: readonly ArtifactInfo[]): string | null {
  for (const artifact of artifacts) {
    if (artifact.type !== "branch" || !artifact.metadata) continue;
    const { mode, createPrUrl } = artifact.metadata;
    if (mode === "manual_pr" && typeof createPrUrl === "string" && createPrUrl) return createPrUrl;
  }
  return null;
}

export interface CompletionTextInput {
  sessionId: string;
  /** The control plane's verdict on the message. */
  success: boolean;
  error?: string;
  /** What the session recorded, or `null` when it could not be read. */
  response: AgentResponse | null;
  context: Pick<CallbackContext, "model" | "repoFullName"> & { reasoningEffort?: string };
  webAppUrl: string;
}

/** The final message, in the Markdown Teams renders. */
export function formatCompletionText(input: CompletionTextInput): string {
  const response = input.response;
  const succeeded = input.success && (response?.success ?? true);
  const error = response?.error || input.error;
  const blocks: string[] = [];

  const answer = response?.textContent.trim() ?? "";
  if (answer) {
    blocks.push(
      answer.length > MAX_ANSWER_CHARS
        ? `${answer.slice(0, MAX_ANSWER_CHARS)}\n\n${TRUNCATED_NOTE}`
        : answer
    );
  } else if (!succeeded) {
    blocks.push(agentFailedMessage(truncateError(error || "Unknown error", MAX_ERROR_CHARS)));
  } else {
    blocks.push(AGENT_COMPLETED_MESSAGE);
  }

  const artifacts = response?.artifacts.filter((artifact) => artifact.url) ?? [];
  const createPr = artifacts.some((artifact) => artifact.type === "pr")
    ? null
    : manualCreatePrUrl(artifacts);
  if (artifacts.length > 0 || createPr) {
    const lines = artifacts.map((artifact) => `- [${artifact.label}](${artifact.url})`);
    if (createPr) lines.push(`- [${CREATE_PR_LABEL}](${createPr})`);
    blocks.push(`${CREATED_HEADING}\n${lines.join("\n")}`);
  }

  const status = succeeded
    ? "Done"
    : error
      ? `Failed: ${truncateError(error, 200)}`
      : "Completed with issues";
  const effort = input.context.reasoningEffort ? ` (${input.context.reasoningEffort})` : "";
  const footer = [status, `${input.context.model}${effort}`, input.context.repoFullName]
    .filter((part): part is string => Boolean(part))
    .join(" | ");
  blocks.push(
    `${footer}\n\n[${OPEN_SESSION_LABEL}](${sessionUrl(input.webAppUrl, input.sessionId)})`
  );

  return blocks.join("\n\n");
}

export interface CompletionInput {
  sessionId: string;
  messageId: string;
  success: boolean;
  error?: string;
  context: CallbackContext;
  traceId: string;
}

/**
 * Render a completed turn into its thread. Throws when the connector refused
 * the message, after releasing the delivery claim so the retry may try again.
 */
export async function deliverCompletion(
  deps: CompletionDeps,
  input: CompletionInput
): Promise<DeliveryOutcome> {
  const threadKey = input.context.conversationId;
  const logBase = {
    trace_id: input.traceId,
    thread_key: threadKey,
    session_id: input.sessionId,
    message_id: input.messageId,
  };
  const thread = threadFor(deps.store, threadKey, input.sessionId);
  if (thread?.closed) {
    deps.log.info("callback.complete", { ...logBase, outcome: "skipped", skip_reason: "closed" });
    return "skipped";
  }
  if (!deps.store.claimCallback(input.messageId, COMPLETE_KIND)) {
    deps.log.info("callback.complete", { ...logBase, outcome: "duplicate" });
    return "duplicate";
  }
  try {
    const response = thread?.actor
      ? await fetchAgentResponse(
          deps.controlPlane,
          thread.actor,
          input.sessionId,
          input.messageId,
          input.traceId
        )
      : null;
    if (!response) {
      deps.log.warn("callback.complete", {
        ...logBase,
        outcome: "degraded",
        reason: thread?.actor ? "session_read_failed" : "no_thread_record",
      });
    }
    const text = formatCompletionText({
      sessionId: input.sessionId,
      success: input.success,
      error: input.error,
      response,
      context: {
        model: input.context.model,
        repoFullName: input.context.repoFullName,
        reasoningEffort: thread?.reasoningEffort ?? undefined,
      },
      webAppUrl: deps.webAppUrl,
    });

    const { address, replyToId } = resolveAddress(deps.store, threadKey, input.context, thread);
    const port = deps.bot.replyPort(address, replyToId);
    // The "Working..." reply belongs to this turn only while it is the thread's latest message.
    const isCurrentTurn = thread !== null && thread.lastMessageId === input.messageId;
    const progressId = await deps.progress.finish(threadKey);
    const target =
      progressId ?? (isCurrentTurn ? (thread.progressActivityId ?? undefined) : undefined);
    const finalId = await updateOrPost(port, target, text);
    if (isCurrentTurn) {
      deps.store.updateThreadSession(threadKey, { turnState: "idle", progressActivityId: null });
    }
    deps.log.info("callback.complete", {
      ...logBase,
      outcome: "success",
      activity_id: finalId,
      edited: finalId !== undefined && finalId === target,
      has_text: Boolean(response?.textContent),
      artifact_count: response?.artifacts.length ?? 0,
    });
    return "delivered";
  } catch (error) {
    deps.store.releaseCallback(input.messageId, COMPLETE_KIND);
    deps.log.error("callback.complete", { ...logBase, outcome: "error", error: asError(error) });
    throw error;
  }
}

/** A tool call in flight: one more progress line, if the thread is still on this turn. */
export function noteToolCall(deps: CompletionDeps, payload: ToolCallCallback, traceId: string) {
  const threadKey = payload.context.conversationId;
  const thread = threadFor(deps.store, threadKey, payload.sessionId);
  if (!thread || thread.closed || thread.turnState !== "working") {
    deps.log.debug("callback.tool_call", {
      trace_id: traceId,
      thread_key: threadKey,
      session_id: payload.sessionId,
      outcome: "skipped",
      skip_reason: !thread ? "no_thread_record" : thread.closed ? "closed" : "not_working",
    });
    return;
  }
  const { address, replyToId } = resolveAddress(deps.store, threadKey, payload.context, thread);
  const { summary } = summarizeToolCall({ tool: payload.tool, args: payload.args ?? {} });
  deps.progress.note(
    threadKey,
    { port: deps.bot.replyPort(address, replyToId), progressActivityId: thread.progressActivityId },
    summary
  );
}

export interface ThreadClosedInput {
  sessionId: string;
  context: ThreadCoordinates;
  traceId: string;
}

/**
 * The control plane withdrew the thread from this session: remember that,
 * stop rendering progress, and say so once in the thread.
 */
export async function deliverThreadClosed(
  deps: CompletionDeps,
  input: ThreadClosedInput
): Promise<DeliveryOutcome> {
  const threadKey = input.context.conversationId;
  const logBase = { trace_id: input.traceId, thread_key: threadKey, session_id: input.sessionId };
  const mapped = deps.store.getThreadSession(threadKey);
  if (mapped && mapped.sessionId !== input.sessionId) {
    deps.log.info("callback.thread_closed", {
      ...logBase,
      outcome: "skipped",
      skip_reason: "thread_remapped",
    });
    return "skipped";
  }
  deps.store.closeThreadSession(threadKey, input.sessionId);
  await deps.progress.finish(threadKey);
  if (!deps.store.claimCallback(input.sessionId, THREAD_CLOSED_KIND)) {
    deps.log.info("callback.thread_closed", { ...logBase, outcome: "duplicate" });
    return "duplicate";
  }
  try {
    const { address, replyToId } = resolveAddress(deps.store, threadKey, input.context, mapped);
    const port = deps.bot.replyPort(address, replyToId);
    await port.post(THREAD_CLOSED_MESSAGE);
    deps.log.info("callback.thread_closed", { ...logBase, outcome: "success" });
    return "delivered";
  } catch (error) {
    deps.store.releaseCallback(input.sessionId, THREAD_CLOSED_KIND);
    deps.log.error("callback.thread_closed", {
      ...logBase,
      outcome: "error",
      error: asError(error),
    });
    throw error;
  }
}
