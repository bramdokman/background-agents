/**
 * The callback bodies the control plane posts to this bot, as its
 * CallbackNotificationService builds them for a message whose source is
 * `msteams`. The HMAC travels in the body (`signature`); the shapes here are
 * loose so a field the control plane adds later does not break delivery.
 *
 * The control plane has no Teams-specific schema for these (its Linear ones
 * are the only typed payloads), so this file is the bot's side of the contract.
 */

import {
  msteamsCallbackContextSchema,
  SLACK_ACTIVITY_REFRESH_KIND,
} from "@open-inspect/shared/types/session-api";
import { z } from "zod";

/**
 * `kind` values for the two callbacks that carry one. The control plane
 * sends `msteams.thread_closed` when its Teams publication gate withdraws a
 * thread; activity refreshes exist for Slack only. The `slack.*` kinds are
 * accepted as well so a shared emitter cannot be refused on the name alone.
 */
const MSTEAMS_ACTIVITY_REFRESH_KIND = "msteams.activity_refresh";
export const MSTEAMS_THREAD_CLOSED_KIND = "msteams.thread_closed";

/** The context the bot attached to the prompt, back from the control plane. */
const callbackContextSchema = msteamsCallbackContextSchema.loose();
export type CallbackContext = z.infer<typeof callbackContextSchema>;

/** Where a thread lives: enough to post a closure note without the full context. */
const threadCoordinatesSchema = z.looseObject({
  conversationId: z.string().min(1),
  serviceUrl: z.string().min(1),
  replyToId: z.string().min(1).optional(),
});
export type ThreadCoordinates = z.infer<typeof threadCoordinatesSchema>;

const signed = {
  sessionId: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
};

/** `POST /callbacks/complete`: a turn finished (no `kind`; the control plane sends none). */
export const completeCallbackSchema = z.looseObject({
  ...signed,
  messageId: z.string().min(1),
  success: z.boolean(),
  error: z.string().optional(),
  context: callbackContextSchema,
});

/**
 * `POST /callbacks/tool_call`: throttled progress, one per tool call id at
 * most. `messageId` names the turn the call belongs to; the control plane
 * sends it to this bot so a late call cannot be drawn under a later turn's
 * placeholder.
 */
export const toolCallCallbackSchema = z.looseObject({
  ...signed,
  messageId: z.string().min(1).optional(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  callId: z.string(),
  status: z.string().optional(),
  context: callbackContextSchema,
});
export type ToolCallCallback = z.infer<typeof toolCallCallbackSchema>;

/**
 * `POST /callbacks/activity`: the turn is still running. `kind` separates it
 * from a completion body, which would otherwise satisfy this shape too.
 */
export const activityCallbackSchema = z.looseObject({
  ...signed,
  kind: z.enum([SLACK_ACTIVITY_REFRESH_KIND, MSTEAMS_ACTIVITY_REFRESH_KIND]),
  messageId: z.string().min(1),
  context: callbackContextSchema,
});

/** `POST /callbacks/thread_closed`: the thread may no longer receive this session's output. */
export const threadClosedCallbackSchema = z.looseObject({
  ...signed,
  kind: z.enum(["slack.thread_closed", MSTEAMS_THREAD_CLOSED_KIND]),
  timestamp: z.number().int().nonnegative(),
  context: threadCoordinatesSchema,
});
