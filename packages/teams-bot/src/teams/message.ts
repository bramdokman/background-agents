/**
 * Inbound activity normalisation: mention stripping, quoted-reply context,
 * the tenant gate and the Teams ids an activity carries.
 *
 * Ported from Centaur `services/teamsbot/src/teams-message.ts` (see
 * PORTED.md). Kept: mention detection and stripping, quoted-reply context,
 * the id getters, and the tenant/channel gate (Centaur's `isAllowedTeamsActivity`
 * reduced to the single-tenant rule, since OI's channel bindings decide the
 * rest). Dropped: `serializeTeamsMessage`'s `raw` payload and the attachment
 * redaction, as the bot forwards no attachments in milestone 2.
 */

import type { TeamsActivity } from "../types";

export function messageMentionsBot(activity: TeamsActivity): boolean {
  const recipientId = activity.recipient?.id;
  if (!recipientId) {
    return false;
  }
  return getMentions(activity).some((mention) => {
    return mention.mentioned?.id?.toLowerCase() === recipientId.toLowerCase();
  });
}

/** The message text with every mention of the bot removed, trimmed. */
export function normalizeTeamsText(activity: TeamsActivity): string {
  return removeRecipientMention(activity).replace(/\s+/g, " ").trim();
}

export interface QuotedReplyContext {
  messageId: string;
  senderName?: string;
  text: string;
  /** ISO timestamp; the epoch when Teams sends none. */
  timestamp: string;
}

/** The messages the user quoted, oldest first as Teams lists them, deleted ones skipped. */
export function teamsQuotedReplyContext(activity: TeamsActivity): QuotedReplyContext[] {
  return getQuotedReplies(activity)
    .filter((entity) => entity.quotedReply && !entity.quotedReply.isReplyDeleted)
    .map((entity, index) => {
      const quoted = entity.quotedReply!;
      return {
        messageId: quoted.messageId || `quoted-${index + 1}`,
        senderName: quoted.senderName ?? undefined,
        text: quoted.preview ?? "",
        timestamp: quoted.time ? quotedTimestamp(quoted.time) : new Date(0).toISOString(),
      };
    });
}

/** Quoted messages rendered as a prompt preamble, or the empty string when there are none. */
export function formatQuotedReplyContext(quotes: readonly QuotedReplyContext[]): string {
  const lines = quotes.filter((quote) => quote.text.trim() !== "");
  if (lines.length === 0) return "";
  const rendered = lines
    .map((quote) => `- ${quote.senderName ?? "Unknown"}: ${quote.text.trim()}`)
    .join("\n");
  return `## Teams Thread Context\n\nThe user quoted these earlier messages:\n\n${rendered}\n\n`;
}

export type TeamsActivityRejectReason = "not_teams" | "not_message" | "tenant";

/**
 * The single-tenant gate: only `msteams` message activities from the
 * configured tenant pass. Runs before any control-plane call.
 */
export function checkTeamsActivity(
  activity: TeamsActivity,
  tenantId: string
): { ok: true } | { ok: false; reason: TeamsActivityRejectReason } {
  if (activity.channelId !== "msteams") return { ok: false, reason: "not_teams" };
  if (activity.type !== "message") return { ok: false, reason: "not_message" };
  const activityTenant = teamsGetTenantId(activity) ?? activity.conversation?.tenantId;
  if (!activityTenant || activityTenant.toLowerCase() !== tenantId.toLowerCase()) {
    return { ok: false, reason: "tenant" };
  }
  return { ok: true };
}

function getMentions(activity: TeamsActivity): NonNullable<TeamsActivity["entities"]> {
  return (activity.entities ?? []).filter((entity) => entity.type?.toLowerCase() === "mention");
}

function getQuotedReplies(activity: TeamsActivity): NonNullable<TeamsActivity["entities"]> {
  return (activity.entities ?? []).filter((entity) => entity.type?.toLowerCase() === "quotedreply");
}

function removeRecipientMention(activity: TeamsActivity): string {
  let text = String(activity.text ?? "");
  const recipientId = activity.recipient?.id?.toLowerCase();
  for (const mention of getMentions(activity)) {
    if (!mention.text) {
      continue;
    }
    if (!recipientId || mention.mentioned?.id?.toLowerCase() === recipientId) {
      text = text.replaceAll(mention.text, "");
    }
  }
  return text;
}

export function teamsGetChannelId(activity: TeamsActivity): string | undefined {
  return activity.channelData?.teamsChannelId ?? activity.channelData?.channel?.id;
}

function teamsGetTenantId(activity: TeamsActivity): string | undefined {
  return activity.channelData?.tenant?.id;
}

/** The AAD object id of the sender, the bot's actor identity, when the activity carries one. */
export function teamsGetSenderObjectId(activity: TeamsActivity): string | undefined {
  const oid = activity.from?.aadObjectId;
  return typeof oid === "string" && oid.trim() !== "" ? oid : undefined;
}

/**
 * The thread an activity belongs to. Teams channel conversations carry the
 * root post in the conversation id (`19:...@thread.tacv2;messageid=<root>`);
 * a root post itself lacks the suffix, so it is derived from the activity so
 * that replies and their root share one key. Chats have no threads: the
 * conversation id is the key.
 */
export function teamsThreadKey(activity: TeamsActivity): string | undefined {
  const conversationId = activity.conversation?.id;
  if (!conversationId) return undefined;
  if (conversationId.includes(";messageid=")) return conversationId;
  const isChannel =
    activity.conversation?.conversationType?.toLowerCase() === "channel" ||
    teamsGetChannelId(activity) !== undefined;
  if (!isChannel) return conversationId;
  const rootId = activity.replyToId ?? activity.id;
  return rootId ? `${conversationId};messageid=${rootId}` : conversationId;
}

function quotedTimestamp(value: string): string {
  const epochMs = Number(value);
  if (Number.isFinite(epochMs) && epochMs > 0) {
    return new Date(epochMs).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}
