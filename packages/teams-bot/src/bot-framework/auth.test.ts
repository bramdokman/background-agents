import { describe, expect, it } from "vitest";
import {
  BOT_FRAMEWORK_OPENID_METADATA_URL,
  botFrameworkIssuers,
  createInboundAuthenticator,
  tenantIssuer,
} from "./auth";
import { createOpenIdKeyResolver } from "./jwks";
import { decodeJwt, verifyBotFrameworkToken } from "./jwt";
import {
  APP_ID,
  BOT_FRAMEWORK_ISSUER,
  makeSigningKey,
  mintToken,
  resolverFor,
  scriptedFetch,
  SERVICE_URL,
  TENANT_ID,
} from "../test-support";

const key = makeSigningKey();
const otherKey = makeSigningKey("other-key");
const activity = { serviceUrl: SERVICE_URL };

function authenticator() {
  return createInboundAuthenticator({ appId: APP_ID, tenantId: TENANT_ID, keys: resolverFor(key) });
}

/** Both phases as the route runs them: the token first, the activity binding once it is parsed. */
async function authenticate(header: string | undefined, activity: { serviceUrl?: unknown }) {
  const auth = authenticator();
  const result = await auth.authenticate(header);
  return result.ok ? auth.bindActivity(result.claims, activity) : result;
}

describe("inbound Bot Framework authentication", () => {
  it("rejects a request without a bearer token", async () => {
    await expect(authenticate(undefined, activity)).resolves.toEqual({
      ok: false,
      reason: "missing_token",
    });
    await expect(authenticate("Basic abc", activity)).resolves.toEqual({
      ok: false,
      reason: "missing_token",
    });
  });

  it("rejects a token for another audience", async () => {
    const token = mintToken(key, { aud: "11111111-1111-1111-1111-111111111111" });
    await expect(authenticate(`Bearer ${token}`, activity)).resolves.toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("rejects an audience list with more than the bot", async () => {
    const token = mintToken(key, { aud: [APP_ID, "someone-else"] });
    await expect(authenticate(`Bearer ${token}`, activity)).resolves.toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("accepts a connector token for the bot and returns its claims", async () => {
    const token = mintToken(key, {});
    const result = await authenticate(`Bearer ${token}`, activity);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.iss).toBe(BOT_FRAMEWORK_ISSUER);
      expect(result.claims.aud).toBe(APP_ID);
    }
  });

  it("accepts a token from the bot's own tenant issuer only when the bot is its authorized party", async () => {
    const v2 = mintToken(key, { iss: tenantIssuer(TENANT_ID), azp: APP_ID, tid: TENANT_ID });
    await expect(authenticate(`Bearer ${v2}`, activity)).resolves.toMatchObject({
      ok: true,
    });
    const v1 = mintToken(key, { iss: tenantIssuer(TENANT_ID), appid: APP_ID });
    await expect(authenticate(`Bearer ${v1}`, activity)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects a tenant-issuer token another client in the tenant obtained for the bot's audience", async () => {
    const otherClient = "22222222-3333-4444-5555-666666666666";
    const forAnotherClient = mintToken(key, { iss: tenantIssuer(TENANT_ID), azp: otherClient });
    await expect(authenticate(`Bearer ${forAnotherClient}`, activity)).resolves.toEqual({
      ok: false,
      reason: "app_id",
    });
    const withoutParty = mintToken(key, { iss: tenantIssuer(TENANT_ID) });
    await expect(authenticate(`Bearer ${withoutParty}`, activity)).resolves.toEqual({
      ok: false,
      reason: "app_id",
    });
    const v1ForAnotherClient = mintToken(key, {
      iss: tenantIssuer(TENANT_ID),
      appid: otherClient,
    });
    await expect(authenticate(`Bearer ${v1ForAnotherClient}`, activity)).resolves.toEqual({
      ok: false,
      reason: "app_id",
    });
  });

  it("rejects a tenant-issuer token whose tid names another tenant", async () => {
    const token = mintToken(key, { iss: tenantIssuer(TENANT_ID), azp: APP_ID, tid: "other" });
    await expect(authenticate(`Bearer ${token}`, activity)).resolves.toEqual({
      ok: false,
      reason: "tenant",
    });
  });

  it("does not require an authorized party on connector tokens", async () => {
    const token = mintToken(key, { azp: "22222222-3333-4444-5555-666666666666" });
    await expect(authenticate(`Bearer ${token}`, activity)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects every other issuer", async () => {
    const token = mintToken(key, { iss: "https://login.microsoftonline.com/other-tenant/v2.0" });
    await expect(authenticate(`Bearer ${token}`, activity)).resolves.toEqual({
      ok: false,
      reason: "issuer",
    });
  });

  it("rejects a token signed by a key the issuer does not publish", async () => {
    const token = mintToken(otherKey, {});
    await expect(authenticate(`Bearer ${token}`, activity)).resolves.toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });

  it("rejects a token whose signature was made with another key under a known kid", async () => {
    const forged = mintToken({ ...otherKey, kid: key.kid }, {});
    await expect(authenticate(`Bearer ${forged}`, activity)).resolves.toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a tampered payload", async () => {
    const token = mintToken(key, {});
    const [header, , signature] = token.split(".");
    const payload = Buffer.from(
      JSON.stringify({ iss: BOT_FRAMEWORK_ISSUER, aud: APP_ID, exp: 9e9 })
    ).toString("base64url");
    await expect(
      authenticate(`Bearer ${header}.${payload}.${signature}`, activity)
    ).resolves.toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects algorithms other than RS256, including none", async () => {
    const none = mintToken(key, {}, { alg: "none" });
    const hmac = mintToken(key, {}, { alg: "HS256" });
    await expect(authenticate(`Bearer ${none}`, activity)).resolves.toEqual({
      ok: false,
      reason: "unsupported_alg",
    });
    await expect(authenticate(`Bearer ${hmac}`, activity)).resolves.toEqual({
      ok: false,
      reason: "unsupported_alg",
    });
  });

  it("rejects expired and not-yet-valid tokens beyond the five-minute skew", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expired = mintToken(key, { exp: nowSeconds - 6 * 60 });
    const future = mintToken(key, { nbf: nowSeconds + 6 * 60, exp: nowSeconds + 60 * 60 });
    const skewed = mintToken(key, { exp: nowSeconds - 4 * 60 });
    await expect(authenticate(`Bearer ${expired}`, activity)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
    await expect(authenticate(`Bearer ${future}`, activity)).resolves.toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
    await expect(authenticate(`Bearer ${skewed}`, activity)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects a token whose serviceurl claim does not match the activity", async () => {
    const token = mintToken(key, { serviceurl: "https://attacker.example/" });
    await expect(authenticate(`Bearer ${token}`, activity)).resolves.toEqual({
      ok: false,
      reason: "service_url",
    });
    const trailing = mintToken(key, { serviceurl: "https://SMBA.trafficmanager.net/emea" });
    await expect(authenticate(`Bearer ${trailing}`, activity)).resolves.toMatchObject({
      ok: true,
    });
    await expect(authenticate(`Bearer ${trailing}`, {})).resolves.toEqual({
      ok: false,
      reason: "service_url",
    });
  });

  it("rejects malformed tokens", async () => {
    await expect(authenticate("Bearer not.a.jwt", activity)).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
    await expect(authenticate("Bearer abc", activity)).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(decodeJwt("a.b")).toBeNull();
  });

  it("knows the two issuers and their metadata documents", () => {
    expect(botFrameworkIssuers(TENANT_ID)).toEqual({
      [BOT_FRAMEWORK_ISSUER]: BOT_FRAMEWORK_OPENID_METADATA_URL,
      [`https://login.microsoftonline.com/${TENANT_ID}/v2.0`]: `https://login.microsoftonline.com/${TENANT_ID}/v2.0/.well-known/openid-configuration`,
    });
  });
});

describe("OpenID key resolver", () => {
  const metadataUrl = "https://login.botframework.com/v1/.well-known/openidconfiguration";
  const jwksUrl = "https://login.botframework.com/v1/.well-known/keys";

  function discovery(keys: () => unknown[]) {
    return scriptedFetch({
      [`GET /v1/.well-known/openidconfiguration`]: () =>
        Response.json({ issuer: BOT_FRAMEWORK_ISSUER, jwks_uri: jwksUrl }),
      [`GET /v1/.well-known/keys`]: () => Response.json({ keys: keys() }),
    });
  }

  it("discovers the JWKS through the metadata document and caches it", async () => {
    const remote = discovery(() => [key.jwk, { kty: "EC", kid: "ec", crv: "P-256" }]);
    const resolver = createOpenIdKeyResolver({
      issuers: { [BOT_FRAMEWORK_ISSUER]: metadataUrl },
      fetch: remote.fetch,
    });
    await expect(resolver.getKey(BOT_FRAMEWORK_ISSUER, key.kid)).resolves.toEqual(key.jwk);
    await expect(resolver.getKey(BOT_FRAMEWORK_ISSUER, key.kid)).resolves.toEqual(key.jwk);
    expect(remote.requests.map((request) => request.url)).toEqual([metadataUrl, jwksUrl]);
    await expect(resolver.getKey(BOT_FRAMEWORK_ISSUER, "ec")).resolves.toBeNull();
  });

  it("refreshes once for an unknown kid and then waits out the cooldown", async () => {
    let published: unknown[] = [key.jwk];
    const remote = discovery(() => published);
    let now = 1_000_000;
    const resolver = createOpenIdKeyResolver({
      issuers: { [BOT_FRAMEWORK_ISSUER]: metadataUrl },
      fetch: remote.fetch,
      now: () => now,
      refreshCooldownMs: 60_000,
    });
    await expect(resolver.getKey(BOT_FRAMEWORK_ISSUER, key.kid)).resolves.toEqual(key.jwk);
    await expect(resolver.getKey(BOT_FRAMEWORK_ISSUER, otherKey.kid)).resolves.toBeNull();
    expect(remote.requests).toHaveLength(2);
    now += 61_000;
    published = [key.jwk, otherKey.jwk];
    await expect(resolver.getKey(BOT_FRAMEWORK_ISSUER, otherKey.kid)).resolves.toEqual(
      otherKey.jwk
    );
    expect(remote.requests).toHaveLength(4);
  });

  it("resolves nothing for an unknown issuer or a failing discovery", async () => {
    const failing = scriptedFetch({ "GET *": () => new Response("down", { status: 503 }) });
    const resolver = createOpenIdKeyResolver({
      issuers: { [BOT_FRAMEWORK_ISSUER]: metadataUrl },
      fetch: failing.fetch,
    });
    await expect(resolver.getKey("https://elsewhere.example", key.kid)).resolves.toBeNull();
    await expect(resolver.getKey(BOT_FRAMEWORK_ISSUER, key.kid)).resolves.toBeNull();
    const verified = await verifyBotFrameworkToken(mintToken(key, {}), {
      appId: APP_ID,
      issuers: [BOT_FRAMEWORK_ISSUER],
      keys: resolver,
    });
    expect(verified).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("ignores a metadata document whose jwks_uri is not https", async () => {
    const remote = scriptedFetch({
      "GET /v1/.well-known/openidconfiguration": () =>
        Response.json({ jwks_uri: "http://login.botframework.com/keys" }),
    });
    const resolver = createOpenIdKeyResolver({
      issuers: { [BOT_FRAMEWORK_ISSUER]: metadataUrl },
      fetch: remote.fetch,
    });
    await expect(resolver.getKey(BOT_FRAMEWORK_ISSUER, key.kid)).resolves.toBeNull();
    expect(remote.requests).toHaveLength(1);
  });
});
