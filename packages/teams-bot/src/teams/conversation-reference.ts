// SPDX-License-Identifier: MIT
// Ported from Centaur (https://github.com/paradigmxyz/centaur, services/teamsbot);
// copyright and licence in ../../LICENSE-centaur, adaptations listed in ../../PORTED.md.
/**
 * Conversation references: what the bot stores on first contact so a
 * completion arriving after a restart can still be posted proactively.
 *
 * Ported from Centaur `services/teamsbot/src/conversation-reference.ts`
 * (see PORTED.md); `toBotFrameworkConversationReference` is dropped because the REST
 * client addresses conversations from the stored reference directly.
 */

import type { JsonObject, JsonValue, StoredConversationReference, TeamsActivity } from "../types";

export function toStoredConversationReference(
  activity: TeamsActivity
): StoredConversationReference {
  return {
    activityId: activity.id,
    bot: toJsonObject(activity.recipient),
    channelId: activity.channelId,
    conversation: toJsonObject(activity.conversation),
    conversationId: activity.conversation?.id ?? "unknown-conversation",
    conversationType: activity.conversation?.conversationType,
    serviceUrl: activity.serviceUrl,
    teamId: teamsGetTeamId(activity) ?? activity.channelData?.team?.id,
    tenantId: teamsGetTenantId(activity) ?? activity.conversation?.tenantId,
    user: toJsonObject(activity.from),
  };
}

function teamsGetTeamId(activity: TeamsActivity): string | undefined {
  return activity.channelData?.teamsTeamId ?? activity.channelData?.team?.id;
}

function teamsGetTenantId(activity: TeamsActivity): string | undefined {
  return activity.channelData?.tenant?.id;
}

function toJsonObject(value: unknown): JsonObject | undefined {
  const json = toJsonValue(value);
  return typeof json === "object" && json !== null && !Array.isArray(json) ? json : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined && typeof entry !== "function") {
        output[key] = toJsonValue(entry);
      }
    }
    return output;
  }
  return String(value);
}
