/**
 * RS256 JWT verification for inbound Bot Framework tokens, on node:crypto.
 *
 * Deliberately narrow: one algorithm, keys from a {@link KeyResolver}, and
 * the claim checks the Bot Framework scheme requires (issuer, audience,
 * lifetime, the authorized party for tenant-issued tokens, and the
 * `serviceurl` claim against the activity). Every failure is a rejection with
 * a reason for the log; nothing here throws on input.
 */

import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { KeyResolver } from "./jwks";

export type JwtRejectReason =
  | "malformed"
  | "unsupported_alg"
  | "issuer"
  | "unknown_key"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "audience"
  | "app_id"
  | "tenant"
  | "service_url";

export type JwtClaims = Record<string, unknown>;

export type VerifyJwtResult =
  { ok: true; claims: JwtClaims } | { ok: false; reason: JwtRejectReason };

export interface VerifyBotFrameworkTokenOptions {
  /** The bot's app id: the only accepted audience. */
  appId: string;
  /** Issuers whose tokens are accepted; each must be known to `keys`. */
  issuers: readonly string[];
  keys: KeyResolver;
  /**
   * The tenant's own issuer, when it is among `issuers`. Entra mints a token
   * for the bot's audience to any client in the tenant that asks, so a token
   * from this issuer is the bot's only when its `azp` (v2) or `appid` (v1)
   * names the bot's own app id; `tenantId` must match its `tid` when present.
   * Connector tokens (`https://api.botframework.com`) carry neither claim and
   * are bound to the activity by `serviceurl` instead.
   */
  tenantIssuer?: string;
  tenantId?: string;
  /**
   * The activity's serviceUrl; a token carrying a `serviceurl` claim must
   * match it. Omit to defer that check to {@link verifyServiceUrlClaim}, for
   * callers that verify the token before they read the activity.
   */
  expectedServiceUrl?: string;
  now?: () => number;
  clockSkewMs?: number;
}

/** Bot Framework allows five minutes of skew on `exp` and `nbf`. */
const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface DecodedJwt {
  header: Record<string, unknown>;
  payload: JwtClaims;
  signingInput: string;
  signature: Buffer;
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeSegment(headerPart);
  const payload = decodeSegment(payloadPart);
  if (!header || !payload || !/^[A-Za-z0-9_-]+$/.test(signaturePart)) return null;
  return {
    header: header as Record<string, unknown>,
    payload: payload as JwtClaims,
    signingInput: `${headerPart}.${payloadPart}`,
    signature: Buffer.from(signaturePart, "base64url"),
  };
}

function audienceMatches(aud: unknown, appId: string): boolean {
  if (typeof aud === "string") return aud === appId;
  if (Array.isArray(aud)) return aud.length === 1 && aud[0] === appId;
  return false;
}

function normalizeServiceUrlForComparison(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function numericClaim(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The client the token was issued to: `azp` in v2 tokens, `appid` in v1 tokens. */
function authorizedParty(payload: JwtClaims): string | undefined {
  const azp = payload.azp ?? payload.appid;
  return typeof azp === "string" && azp !== "" ? azp : undefined;
}

/**
 * Whether a token's `serviceurl` claim allows the activity's serviceUrl. A
 * token without the claim binds to nothing and passes; a token with it must
 * name the activity's host, so a connector token captured from one
 * conversation cannot authenticate activities for another.
 */
export function verifyServiceUrlClaim(claims: JwtClaims, expectedServiceUrl: unknown): boolean {
  const serviceUrlClaim = claims.serviceurl;
  if (serviceUrlClaim === undefined) return true;
  return (
    typeof serviceUrlClaim === "string" &&
    typeof expectedServiceUrl === "string" &&
    normalizeServiceUrlForComparison(serviceUrlClaim) ===
      normalizeServiceUrlForComparison(expectedServiceUrl)
  );
}

export async function verifyBotFrameworkToken(
  token: string,
  options: VerifyBotFrameworkTokenOptions
): Promise<VerifyJwtResult> {
  const decoded = decodeJwt(token);
  if (!decoded) return { ok: false, reason: "malformed" };
  const { header, payload } = decoded;
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };
  if (typeof payload.iss !== "string" || !options.issuers.includes(payload.iss)) {
    return { ok: false, reason: "issuer" };
  }
  if (typeof header.kid !== "string" || header.kid === "") {
    return { ok: false, reason: "unknown_key" };
  }
  const jwk = await options.keys.getKey(payload.iss, header.kid);
  if (!jwk) return { ok: false, reason: "unknown_key" };

  let signatureValid = false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    signatureValid = verifySignature(
      "RSA-SHA256",
      Buffer.from(decoded.signingInput, "utf8"),
      key,
      decoded.signature
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, reason: "bad_signature" };

  const nowSeconds = (options.now ?? Date.now)() / 1000;
  const skewSeconds = (options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS) / 1000;
  const exp = numericClaim(payload.exp);
  if (exp === undefined || nowSeconds > exp + skewSeconds) return { ok: false, reason: "expired" };
  const nbf = numericClaim(payload.nbf);
  if (nbf !== undefined && nowSeconds < nbf - skewSeconds) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (!audienceMatches(payload.aud, options.appId)) return { ok: false, reason: "audience" };

  if (options.tenantIssuer !== undefined && payload.iss === options.tenantIssuer) {
    if (authorizedParty(payload) !== options.appId) return { ok: false, reason: "app_id" };
    if (
      options.tenantId !== undefined &&
      payload.tid !== undefined &&
      payload.tid !== options.tenantId
    ) {
      return { ok: false, reason: "tenant" };
    }
  }

  if (
    options.expectedServiceUrl !== undefined &&
    !verifyServiceUrlClaim(payload, options.expectedServiceUrl)
  ) {
    return { ok: false, reason: "service_url" };
  }
  return { ok: true, claims: payload };
}
