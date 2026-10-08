// SPDX-License-Identifier: MIT
// Ported from Centaur (https://github.com/paradigmxyz/centaur, services/teamsbot);
// copyright and licence in ../LICENSE-centaur, adaptations listed in ../PORTED.md.
/**
 * Bot Framework activity shapes as Teams sends them, and the stored
 * conversation reference derived from them.
 *
 * Ported from Centaur `services/teamsbot/src/types.ts` (see PORTED.md): the
 * activity, JSON and conversation-reference types are kept; Centaur's session
 * transport and render-obligation types are not, since OI's control plane
 * owns the session.
 */

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type TeamsActivity = {
  attachments?: Array<{
    content?: unknown;
    contentType?: string;
    contentUrl?: string;
    name?: string;
  }>;
  channelData?: {
    channel?: { id?: string; name?: string };
    team?: { id?: string; name?: string };
    teamsChannelId?: string;
    teamsTeamId?: string;
    tenant?: { id?: string };
  } & Record<string, unknown>;
  channelId?: string;
  conversation?: { id?: string; conversationType?: string; tenantId?: string; name?: string };
  entities?: Array<{
    mentioned?: { id?: string; name?: string };
    quotedReply?: {
      isReplyDeleted?: boolean;
      messageId?: string;
      preview?: string | null;
      senderId?: string | null;
      senderName?: string | null;
      time?: string | null;
    };
    text?: string;
    type?: string;
  }>;
  from?: { aadObjectId?: string; id?: string; name?: string };
  id?: string;
  localTimestamp?: string;
  localTimezone?: string;
  recipient?: { id?: string; name?: string };
  replyToId?: string;
  serviceUrl?: string;
  text?: string;
  textFormat?: string;
  timestamp?: string | Date;
  type?: string;
} & Record<string, unknown>;

export type StoredConversationReference = {
  activityId?: string;
  bot?: JsonObject;
  channelId?: string;
  conversation?: JsonObject;
  conversationId: string;
  conversationType?: string;
  serviceUrl?: string;
  teamId?: string;
  tenantId?: string;
  user?: JsonObject;
};
