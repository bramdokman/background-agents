/**
 * Inbound authentication for `POST /api/messages`.
 *
 * The Bot Framework connector authenticates to the bot with a bearer JWT.
 * Accepted issuers are the connector (`https://api.botframework.com`) and the
 * bot's own tenant (`https://login.microsoftonline.com/<tenant>/v2.0`, which
 * the Emulator and the Entra token service use); the audience is the bot's
 * app id. Keys come from each issuer's OpenID metadata. Anything that does
 * not verify is a 401 and never reaches the control plane.
 */

import { createOpenIdKeyResolver, type KeyResolver } from "./jwks";
import { verifyBotFrameworkToken, type JwtClaims, type JwtRejectReason } from "./jwt";
import type { FetchFn } from "../types";

const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
export const BOT_FRAMEWORK_OPENID_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

export function tenantIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

function tenantOpenIdMetadataUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`;
}

/** Issuer -> metadata URL for the two issuers a single-tenant bot accepts. */
export function botFrameworkIssuers(tenantId: string): Record<string, string> {
  return {
    [BOT_FRAMEWORK_ISSUER]: BOT_FRAMEWORK_OPENID_METADATA_URL,
    [tenantIssuer(tenantId)]: tenantOpenIdMetadataUrl(tenantId),
  };
}

type InboundAuthRejectReason = "missing_token" | JwtRejectReason;

type InboundAuthResult =
  { ok: true; claims: JwtClaims } | { ok: false; reason: InboundAuthRejectReason };

export interface InboundAuthenticator {
  authenticate(
    authorizationHeader: string | undefined,
    activity: { serviceUrl?: unknown }
  ): Promise<InboundAuthResult>;
}

export interface InboundAuthenticatorOptions {
  appId: string;
  tenantId: string;
  /** Overrides discovery; tests inject a resolver holding their own keys. */
  keys?: KeyResolver;
  fetch?: FetchFn;
  now?: () => number;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

export function createInboundAuthenticator(
  options: InboundAuthenticatorOptions
): InboundAuthenticator {
  const issuers = botFrameworkIssuers(options.tenantId);
  const keys =
    options.keys ?? createOpenIdKeyResolver({ issuers, fetch: options.fetch, now: options.now });
  const issuerList = Object.keys(issuers);
  return {
    async authenticate(authorizationHeader, activity) {
      const token = bearerToken(authorizationHeader);
      if (!token) return { ok: false, reason: "missing_token" };
      return verifyBotFrameworkToken(token, {
        appId: options.appId,
        issuers: issuerList,
        keys,
        expectedServiceUrl:
          typeof activity.serviceUrl === "string" ? activity.serviceUrl : undefined,
        now: options.now,
      });
    },
  };
}
