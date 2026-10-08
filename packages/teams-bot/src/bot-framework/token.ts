/**
 * The bot's own credential for the Bot Framework connector: an Entra
 * client-credentials token for the bot app, from the single tenant's token
 * endpoint, scoped to `https://api.botframework.com/.default`. Cached until
 * shortly before it expires; one refresh in flight at a time.
 */

import type { FetchFn } from "../types";

const BOT_FRAMEWORK_TOKEN_SCOPE = "https://api.botframework.com/.default";

/** Refresh this long before `expires_in` runs out. */
const EXPIRY_MARGIN_MS = 60_000;
const TOKEN_FETCH_TIMEOUT_MS = 15_000;

export interface AccessTokenProvider {
  getToken(): Promise<string>;
}

export interface ClientCredentialsOptions {
  tenantId: string;
  appId: string;
  appSecret: string;
  scope?: string;
  fetch?: FetchFn;
  now?: () => number;
}

class BotFrameworkTokenError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "BotFrameworkTokenError";
  }
}

export function tokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

export function createClientCredentialsTokenProvider(
  options: ClientCredentialsOptions
): AccessTokenProvider {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const scope = options.scope ?? BOT_FRAMEWORK_TOKEN_SCOPE;
  let cached: { token: string; expiresAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  async function requestToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: options.appId,
      client_secret: options.appSecret,
      scope,
    });
    const response = await fetchFn(tokenEndpoint(options.tenantId), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      // The body may echo the request; only the status is logged.
      throw new BotFrameworkTokenError(
        `Bot Framework token request failed with ${response.status}`,
        response.status
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    const record =
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const token = record.access_token;
    const expiresIn = record.expires_in;
    if (typeof token !== "string" || token === "") {
      throw new BotFrameworkTokenError("Bot Framework token response carried no access_token");
    }
    const lifetimeMs =
      (typeof expiresIn === "number" ? expiresIn : Number(expiresIn) || 3600) * 1000;
    cached = { token, expiresAt: now() + lifetimeMs - EXPIRY_MARGIN_MS };
    return token;
  }

  return {
    async getToken() {
      if (cached && cached.expiresAt > now()) return cached.token;
      if (!inFlight) {
        inFlight = requestToken().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
  };
}
