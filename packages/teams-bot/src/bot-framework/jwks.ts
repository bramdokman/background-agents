/**
 * Signing keys for inbound Bot Framework tokens, resolved through OpenID
 * Connect discovery: issuer -> metadata document -> `jwks_uri` -> keys.
 *
 * Keys are cached per issuer. An unknown `kid` triggers one refresh, rate
 * limited so a flood of tokens with made-up key ids cannot turn into a flood
 * of metadata fetches. Failures resolve to "no key", never to a thrown error
 * the verifier might mistake for anything but a rejection.
 */

import type { JsonWebKey } from "node:crypto";
import type { FetchFn } from "../types";

export interface KeyResolver {
  /** The RSA public key `issuer` publishes under `kid`, or null when there is none. */
  getKey(issuer: string, kid: string): Promise<JsonWebKey | null>;
}

export interface OpenIdKeyResolverOptions {
  /** Issuer -> OpenID metadata URL. Only these issuers resolve. */
  issuers: Readonly<Record<string, string>>;
  fetch?: FetchFn;
  now?: () => number;
  /** How long a fetched key set is trusted before it is refreshed on use. */
  cacheTtlMs?: number;
  /** Minimum time between two refreshes forced by an unknown `kid`. */
  refreshCooldownMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_COOLDOWN_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

interface CachedKeySet {
  keys: Map<string, JsonWebKey>;
  fetchedAt: number;
}

function isRsaSigningKey(value: unknown): value is JsonWebKey & { kid: string } {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Record<string, unknown>;
  return (
    key.kty === "RSA" &&
    typeof key.kid === "string" &&
    key.kid !== "" &&
    typeof key.n === "string" &&
    typeof key.e === "string" &&
    (key.use === undefined || key.use === "sig")
  );
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:";
}

export function createOpenIdKeyResolver(options: OpenIdKeyResolverOptions): KeyResolver {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const refreshCooldownMs = options.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
  const cache = new Map<string, CachedKeySet>();
  const inFlight = new Map<string, Promise<CachedKeySet | null>>();
  const lastAttemptAt = new Map<string, number>();

  async function fetchJson(url: string): Promise<unknown> {
    const response = await fetchFn(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
    return response.json();
  }

  async function loadKeySet(issuer: string): Promise<CachedKeySet | null> {
    const metadataUrl = options.issuers[issuer];
    if (!metadataUrl) return null;
    const metadata = await fetchJson(metadataUrl);
    const jwksUri =
      typeof metadata === "object" && metadata !== null
        ? (metadata as Record<string, unknown>).jwks_uri
        : undefined;
    if (!isHttpsUrl(jwksUri))
      throw new Error(`OpenID metadata for ${issuer} has no https jwks_uri`);
    const document = await fetchJson(jwksUri);
    const list =
      typeof document === "object" && document !== null
        ? (document as Record<string, unknown>).keys
        : undefined;
    const keys = new Map<string, JsonWebKey>();
    for (const key of Array.isArray(list) ? list : []) {
      if (isRsaSigningKey(key)) keys.set(key.kid, key);
    }
    return { keys, fetchedAt: now() };
  }

  /** One refresh per issuer at a time; concurrent callers share it. */
  function refresh(issuer: string): Promise<CachedKeySet | null> {
    const pending = inFlight.get(issuer);
    if (pending) return pending;
    lastAttemptAt.set(issuer, now());
    const task = loadKeySet(issuer)
      .then((keySet) => {
        if (keySet) cache.set(issuer, keySet);
        return keySet;
      })
      .catch(() => null)
      .finally(() => inFlight.delete(issuer));
    inFlight.set(issuer, task);
    return task;
  }

  return {
    async getKey(issuer, kid) {
      if (!(issuer in options.issuers)) return null;
      let keySet = cache.get(issuer);
      if (!keySet || now() - keySet.fetchedAt > cacheTtlMs) {
        keySet = (await refresh(issuer)) ?? keySet;
      }
      const known = keySet?.keys.get(kid);
      if (known) return known;
      const attemptedAt = lastAttemptAt.get(issuer) ?? 0;
      if (now() - attemptedAt < refreshCooldownMs) return null;
      const refreshed = await refresh(issuer);
      return refreshed?.keys.get(kid) ?? null;
    },
  };
}
