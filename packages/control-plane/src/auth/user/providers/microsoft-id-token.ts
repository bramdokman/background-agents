import { SIGN_IN_PROVIDER_ISSUERS } from "@open-inspect/shared/sign-in-provider";
import { z } from "zod";
import { createLogger, type Logger } from "../../../logger";
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } from "./constants";
import { OAuthProviderError } from "./types";

/**
 * Verifies Microsoft Entra ID tokens against the tenant's published signing
 * keys, with Web Crypto only (the control plane also runs on Cloudflare
 * Workers).
 *
 * This replaces Better Auth's `microsoft().verifyIdToken`, which imports each
 * JWK into jose without naming an algorithm. Microsoft's tenant JWKS carries
 * `kty`, `kid`, `use`, `n`, `e`, `x5c`, `x5t` and no `alg`, so that import
 * threw `"alg" argument is required when "jwk.alg" is not present` for every
 * real token. Entra signs ID tokens with RS256 only, so the algorithm is
 * pinned here rather than read from the key.
 * @see https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#validate-tokens
 */

const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
/** Tolerated clock difference between this deployment and Microsoft. */
const CLOCK_SKEW_SECONDS = 5 * 60;
/** Better Auth's maximum ID-token age, kept so the bound does not loosen. */
const MAX_TOKEN_AGE_SECONDS = SECONDS_PER_HOUR;
/** Microsoft rotates signing keys infrequently and publishes the next key ahead of use. */
export const DEFAULT_KEY_CACHE_TTL_MS = 24 * 60 * 60 * MS_PER_SECOND;
/** Least time between refreshes forced by tokens with an unknown `kid`. */
export const DEFAULT_UNKNOWN_KEY_REFRESH_COOLDOWN_MS = 5 * 60 * MS_PER_SECOND;

const JWT_SEGMENT_COUNT = 3;

const headerSchema = z.object({
  alg: z.literal("RS256"),
  kid: z.string().min(1),
});

const payloadSchema = z.looseObject({
  iss: z.string().min(1),
  aud: z.string().min(1),
  tid: z.string().min(1),
  exp: z.number().int(),
  iat: z.number().int(),
  nbf: z.number().int().optional(),
});

export type MicrosoftIdTokenPayload = z.infer<typeof payloadSchema>;

const openIdConfigurationSchema = z.looseObject({
  jwks_uri: z.url(),
});

const rsaSigningKeySchema = z.looseObject({
  kty: z.literal("RSA"),
  kid: z.string().min(1),
  n: z.string().min(1),
  e: z.string().min(1),
  use: z.string().optional(),
  alg: z.string().optional(),
});

const jwksSchema = z.looseObject({
  keys: z.array(z.unknown()),
});

type RsaSigningKey = z.infer<typeof rsaSigningKeySchema>;

export interface MicrosoftTenantKeyCacheEntry {
  readonly keys: ReadonlyMap<string, RsaSigningKey>;
  readonly fetchedAt: number;
}

/** Cached per tenant and shared across verifier instances in this isolate. */
const sharedKeyCache = new Map<string, MicrosoftTenantKeyCacheEntry>();

export interface MicrosoftIdTokenVerifierConfig {
  readonly clientId: string;
  readonly tenantId: string;
}

export interface MicrosoftIdTokenVerifierDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly keyCache?: Map<string, MicrosoftTenantKeyCacheEntry>;
  readonly keyCacheTtlMs?: number;
  readonly unknownKeyRefreshCooldownMs?: number;
  readonly requestTimeoutMs?: number;
  readonly logger?: Pick<Logger, "warn">;
}

function decodeBase64Url(segment: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null;
  const b64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJsonSegment(segment: string): unknown {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export class MicrosoftIdTokenVerifier {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly keyCache: Map<string, MicrosoftTenantKeyCacheEntry>;
  private readonly keyCacheTtlMs: number;
  private readonly unknownKeyRefreshCooldownMs: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: Pick<Logger, "warn">;
  private readonly expectedIssuer: string;
  private readonly metadataUrl: string;

  constructor(
    private readonly config: MicrosoftIdTokenVerifierConfig,
    dependencies: MicrosoftIdTokenVerifierDependencies = {}
  ) {
    // Resolved per call: the runtime is built once, while the global may be
    // replaced later (tests stub it; Workers bind it per request).
    this.fetchImpl = dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = dependencies.now ?? Date.now;
    this.keyCache = dependencies.keyCache ?? sharedKeyCache;
    this.keyCacheTtlMs = dependencies.keyCacheTtlMs ?? DEFAULT_KEY_CACHE_TTL_MS;
    this.unknownKeyRefreshCooldownMs =
      dependencies.unknownKeyRefreshCooldownMs ?? DEFAULT_UNKNOWN_KEY_REFRESH_COOLDOWN_MS;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
    this.logger = dependencies.logger ?? createLogger("microsoft-id-token");
    const tenantAuthority = `${SIGN_IN_PROVIDER_ISSUERS.microsoft}/${encodeURIComponent(config.tenantId)}`;
    this.expectedIssuer = `${tenantAuthority}/v2.0`;
    this.metadataUrl = `${tenantAuthority}/v2.0/.well-known/openid-configuration`;
  }

  /**
   * The token's claims when its signature, issuer, audience and times check
   * out; `false` otherwise. Throws `provider_unavailable` only when Microsoft's
   * key material cannot be fetched, which is not a verdict on the token.
   */
  async verify(token: string): Promise<MicrosoftIdTokenPayload | false> {
    const segments = token.split(".");
    if (segments.length !== JWT_SEGMENT_COUNT) return this.reject("malformed");
    const [headerSegment, payloadSegment, signatureSegment] = segments;

    const header = headerSchema.safeParse(decodeJsonSegment(headerSegment));
    if (!header.success) return this.reject("unsupported_header");
    const payload = payloadSchema.safeParse(decodeJsonSegment(payloadSegment));
    if (!payload.success) return this.reject("malformed_claims");
    const claimsRejection = this.checkClaims(payload.data);
    if (claimsRejection) return this.reject(claimsRejection);

    const signature = decodeBase64Url(signatureSegment);
    if (!signature || signature.length === 0) return this.reject("malformed");
    const key = await this.resolveSigningKey(header.data.kid);
    if (!key) return this.reject("unknown_key", { kid: header.data.kid });

    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signature,
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
    );
    return verified ? payload.data : this.reject("bad_signature", { kid: header.data.kid });
  }

  private reject(reason: string, context: Record<string, unknown> = {}): false {
    this.logger.warn("Rejected Microsoft ID token", { reason, ...context });
    return false;
  }

  private checkClaims(claims: MicrosoftIdTokenPayload): string | null {
    if (claims.iss !== this.expectedIssuer) return "issuer_mismatch";
    if (claims.tid !== this.config.tenantId) return "tenant_mismatch";
    if (claims.aud !== this.config.clientId) return "audience_mismatch";
    const nowSeconds = Math.floor(this.now() / MS_PER_SECOND);
    if (nowSeconds >= claims.exp + CLOCK_SKEW_SECONDS) return "expired";
    if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) return "issued_in_future";
    if (claims.iat < nowSeconds - MAX_TOKEN_AGE_SECONDS - CLOCK_SKEW_SECONDS) return "too_old";
    if (claims.nbf !== undefined && claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) {
      return "not_yet_valid";
    }
    return null;
  }

  /**
   * The tenant's key for `kid`, from cache or Microsoft. An unknown `kid`
   * forces one refresh (keys rotate), rate-limited so forged tokens cannot
   * turn every sign-in into two fetches.
   */
  private async resolveSigningKey(kid: string): Promise<CryptoKey | null> {
    const now = this.now();
    let entry = this.keyCache.get(this.metadataUrl);
    if (!entry || now - entry.fetchedAt >= this.keyCacheTtlMs) {
      entry = await this.refreshKeys();
    } else if (!entry.keys.has(kid) && now - entry.fetchedAt >= this.unknownKeyRefreshCooldownMs) {
      entry = await this.refreshKeys();
    }
    const jwk = entry.keys.get(kid);
    if (!jwk) return null;
    return crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
  }

  private async refreshKeys(): Promise<MicrosoftTenantKeyCacheEntry> {
    const metadata = openIdConfigurationSchema.safeParse(
      await this.fetchJson(this.metadataUrl, "OpenID configuration")
    );
    if (!metadata.success || !metadata.data.jwks_uri.startsWith("https://")) {
      throw new OAuthProviderError(
        "provider_unavailable",
        "Microsoft returned an invalid OpenID configuration"
      );
    }
    const jwks = jwksSchema.safeParse(await this.fetchJson(metadata.data.jwks_uri, "JWKS"));
    if (!jwks.success) {
      throw new OAuthProviderError("provider_unavailable", "Microsoft returned an invalid JWKS");
    }
    const keys = new Map<string, RsaSigningKey>();
    for (const candidate of jwks.data.keys) {
      const key = rsaSigningKeySchema.safeParse(candidate);
      if (!key.success) continue;
      if (key.data.use !== undefined && key.data.use !== "sig") continue;
      if (key.data.alg !== undefined && key.data.alg !== "RS256") continue;
      keys.set(key.data.kid, key.data);
    }
    const entry: MicrosoftTenantKeyCacheEntry = { keys, fetchedAt: this.now() };
    this.keyCache.set(this.metadataUrl, entry);
    return entry;
  }

  private async fetchJson(url: string, what: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new OAuthProviderError("provider_unavailable", `Microsoft ${what} is unreachable`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new OAuthProviderError(
        "provider_unavailable",
        `Microsoft ${what} request was not successful`
      );
    }
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}
