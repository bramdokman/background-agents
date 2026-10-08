/**
 * Outbound replies through the Bot Framework REST connector on the activity's
 * serviceUrl: reply in a thread, post to a conversation, edit an activity,
 * and post proactively from a stored conversation reference.
 *
 * Every call re-checks the serviceUrl against the allowlist before a request
 * is built, so no code path can be talked into posting elsewhere even if a
 * stored reference were tampered with.
 */

import type { ReplySinkPort } from "../teams/reply-sink";
import type { FetchFn, StoredConversationReference } from "../types";
import { isAllowedServiceUrl, normalizeServiceUrl } from "./service-url";
import type { AccessTokenProvider } from "./token";

const REQUEST_TIMEOUT_MS = 15_000;

interface ChannelAccount {
  id: string;
  name?: string;
}

/** Where an outbound activity goes. `bot` and `user` fill the activity's from/recipient when known. */
export interface ActivityAddress {
  serviceUrl: string;
  conversationId: string;
  bot?: ChannelAccount;
  user?: ChannelAccount;
}

interface SentActivity {
  id: string;
}

export class ServiceUrlNotAllowedError extends Error {
  constructor(readonly serviceUrl: unknown) {
    super("serviceUrl is not on the allowlist");
    this.name = "ServiceUrlNotAllowedError";
  }
}

class BotFrameworkRequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number
  ) {
    super(`Bot Framework ${operation} failed with ${status}`);
    this.name = "BotFrameworkRequestError";
  }

  /**
   * A 4xx is the connector's definitive answer about this request (an
   * activity that cannot be edited, a malformed one): retrying it the same
   * way cannot succeed, so a caller may fall back to another action. A 5xx or
   * a timeout says nothing about whether the request was applied.
   */
  get refused(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export interface BotFrameworkClient {
  /** Post `text` as a reply to `replyToId`; in a channel this lands in (or starts) that post's thread. */
  replyToActivity(address: ActivityAddress, replyToId: string, text: string): Promise<SentActivity>;
  /** Post `text` to the conversation without a reply target. */
  sendToConversation(address: ActivityAddress, text: string): Promise<SentActivity>;
  /** Replace the text of an activity the bot posted earlier. */
  updateActivity(address: ActivityAddress, activityId: string, text: string): Promise<void>;
  /** Post from a stored reference, for completions that arrive after a restart. */
  sendProactive(reference: StoredConversationReference, text: string): Promise<SentActivity>;
  /** The post/update pair the reply sink drives, bound to one thread. */
  replyPort(address: ActivityAddress, replyToId: string | undefined): ReplySinkPort;
}

export interface BotFrameworkClientOptions {
  tokens: AccessTokenProvider;
  allowedServiceUrlHosts: readonly string[];
  fetch?: FetchFn;
}

function messageActivity(
  address: ActivityAddress,
  text: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "message",
    text,
    textFormat: "markdown",
    conversation: { id: address.conversationId },
    ...(address.bot ? { from: address.bot } : {}),
    ...(address.user ? { recipient: address.user } : {}),
    ...extra,
  };
}

/** The address a stored conversation reference names, accounts included when they were recorded. */
export function referenceAddress(reference: StoredConversationReference): ActivityAddress {
  const account = (value: unknown): ChannelAccount | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    return typeof record.id === "string"
      ? { id: record.id, ...(typeof record.name === "string" ? { name: record.name } : {}) }
      : undefined;
  };
  return {
    serviceUrl: reference.serviceUrl ?? "",
    conversationId: reference.conversationId,
    bot: account(reference.bot),
    user: account(reference.user),
  };
}

export function createBotFrameworkClient(options: BotFrameworkClientOptions): BotFrameworkClient {
  const fetchFn = options.fetch ?? fetch;

  function conversationUrl(address: ActivityAddress, suffix: string): string {
    if (!isAllowedServiceUrl(address.serviceUrl, options.allowedServiceUrlHosts)) {
      throw new ServiceUrlNotAllowedError(address.serviceUrl);
    }
    const base = normalizeServiceUrl(address.serviceUrl);
    return `${base}v3/conversations/${encodeURIComponent(address.conversationId)}/activities${suffix}`;
  }

  async function send(
    operation: string,
    method: "POST" | "PUT",
    url: string,
    activity: Record<string, unknown>
  ): Promise<SentActivity> {
    const token = await options.tokens.getToken();
    const response = await fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(activity),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new BotFrameworkRequestError(operation, response.status);
    const payload: unknown = await response.json().catch(() => null);
    const id =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).id
        : undefined;
    return { id: typeof id === "string" ? id : "" };
  }

  const client: BotFrameworkClient = {
    async replyToActivity(address, replyToId, text) {
      const url = conversationUrl(address, `/${encodeURIComponent(replyToId)}`);
      return send("replyToActivity", "POST", url, messageActivity(address, text, { replyToId }));
    },
    async sendToConversation(address, text) {
      const url = conversationUrl(address, "");
      return send("sendToConversation", "POST", url, messageActivity(address, text));
    },
    async updateActivity(address, activityId, text) {
      const url = conversationUrl(address, `/${encodeURIComponent(activityId)}`);
      await send("updateActivity", "PUT", url, messageActivity(address, text, { id: activityId }));
    },
    sendProactive(reference, text) {
      const address = referenceAddress(reference);
      if (reference.activityId) {
        return client.replyToActivity(address, reference.activityId, text);
      }
      return client.sendToConversation(address, text);
    },
    replyPort(address, replyToId) {
      return {
        post: (text) =>
          replyToId
            ? client.replyToActivity(address, replyToId, text)
            : client.sendToConversation(address, text),
        update: (messageId, text) => client.updateActivity(address, messageId, text),
      };
    },
  };
  return client;
}
