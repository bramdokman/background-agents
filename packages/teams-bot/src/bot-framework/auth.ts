/**
 * Inbound authentication for `POST /api/messages`.
 *
 * The Bot Framework connector authenticates to the bot with a bearer JWT.
 * Accepted issuers are the connector (`https://api.botframework.com`) and the
 * bot's own tenant (`https://login.microsoftonline.com/<tenant>/v2.0`, which
 * the Emulator and the Entra token service use); the audience is the bot's
 * app id. A tenant-issued token is accepted only when the bot itself is its
 * authorized party (`azp`/`appid`): Entra issues tokens for the bot's audience
 * to any client in the tenant, and the activity's `from.aadObjectId` is taken
 * on the token's word alone. Keys come from each issuer's OpenID metadata.
 * Anything that does not verify is a 401 and never reaches the control plane.
 */

import { createOpenIdKeyResolver, type KeyResolver } from "./jwks";
import {
  verifyBotFrameworkToken,
  verifyServiceUrlClaim,
  type JwtClaims,
  type JwtRejectReason,
} from "./jwt";
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

/**
 * Two phases, because the token is checked before the body is read: the
 * public route must not buffer or parse anything for an unauthenticated
 * caller. `authenticate` settles everything the token alone can answer;
 * `bindActivity` then holds the token's `serviceurl` claim against the parsed
 * activity, so a connector token captured from one conversation cannot
 * authenticate activities for another.
 */
export interface InboundAuthenticator {
  authenticate(authorizationHeader: string | undefined): Promise<InboundAuthResult>;
  bindActivity(claims: JwtClaims, activity: { serviceUrl?: unknown }): InboundAuthResult;
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
    async authenticate(authorizationHeader) {
      const token = bearerToken(authorizationHeader);
      if (!token) return { ok: false, reason: "missing_token" };
      return verifyBotFrameworkToken(token, {
        appId: options.appId,
        issuers: issuerList,
        keys,
        tenantIssuer: tenantIssuer(options.tenantId),
        tenantId: options.tenantId,
        now: options.now,
      });
    },
    bindActivity(claims, activity) {
      return verifyServiceUrlClaim(claims, activity.serviceUrl)
        ? { ok: true, claims }
        : { ok: false, reason: "service_url" };
    },
  };
}
