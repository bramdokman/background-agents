import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UNKNOWN_KEY_REFRESH_COOLDOWN_MS,
  MicrosoftIdTokenVerifier,
  type MicrosoftTenantKeyCacheEntry,
} from "./microsoft-id-token";

const CLIENT_ID = "microsoft-client-id";
const TENANT_ID = "2f0d9b3a-5c1e-4a7b-9d2c-8e6f1a3b5c7d";
const OTHER_TENANT_ID = "7a1c2e3d-4b5f-4a6c-8d9e-0f1a2b3c4d5e";
const AUTHORITY = "https://login.microsoftonline.com";
const ISSUER = `${AUTHORITY}/${TENANT_ID}/v2.0`;
const METADATA_URL = `${AUTHORITY}/${TENANT_ID}/v2.0/.well-known/openid-configuration`;
const JWKS_URL = `${AUTHORITY}/${TENANT_ID}/discovery/v2.0/keys`;
const KEY_ID = "tenant-signing-key";
const MS_PER_SECOND = 1000;

let tenantKey: CryptoKeyPair;
let otherKey: CryptoKeyPair;
/** The tenant's JWKS as Microsoft publishes it: no `alg` on any key. */
let tenantJwks: { keys: Record<string, unknown>[] };

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

async function generateKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
}

async function publishedKey(pair: CryptoKeyPair, kid: string): Promise<Record<string, unknown>> {
  const { n, e } = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kty: "RSA",
    use: "sig",
    kid,
    x5t: kid,
    n,
    e,
    x5c: ["MIIC8TCCAdmgAwIBAgIQ"],
    issuer: ISSUER,
    cloud_instance_name: "microsoftonline.com",
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / MS_PER_SECOND);
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = nowSeconds();
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    iat,
    nbf: iat,
    exp: iat + 300,
    tid: TENANT_ID,
    oid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    sub: "pairwise-subject",
    email: "person@corp.example",
    ...overrides,
  };
}

interface SignOptions {
  readonly key?: CryptoKey;
  readonly header?: Record<string, unknown>;
}

async function signToken(
  payload: Record<string, unknown>,
  {
    key = tenantKey.privateKey,
    header = { alg: "RS256", kid: KEY_ID, typ: "JWT" },
  }: SignOptions = {}
): Promise<string> {
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** An HS256-style token: the header lies about the algorithm, the signature is junk. */
function hmacToken(payload: Record<string, unknown>): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", kid: KEY_ID, typ: "JWT" }));
  return `${header}.${base64Url(JSON.stringify(payload))}.${base64Url("not-a-signature")}`;
}

function unsignedToken(payload: Record<string, unknown>): string {
  const header = base64Url(JSON.stringify({ alg: "none", kid: KEY_ID, typ: "JWT" }));
  return `${header}.${base64Url(JSON.stringify(payload))}.`;
}

interface Harness {
  readonly verifier: MicrosoftIdTokenVerifier;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly jwksFetches: () => number;
  readonly clock: { now: number };
}

function harness(jwks: () => unknown = () => tenantJwks): Harness {
  const clock = { now: Date.now() };
  let jwksFetches = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === METADATA_URL) {
      return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URL });
    }
    if (url === JWKS_URL) {
      jwksFetches += 1;
      return Response.json(jwks());
    }
    throw new Error(`Unexpected external request: ${url}`);
  });
  const verifier = new MicrosoftIdTokenVerifier(
    { clientId: CLIENT_ID, tenantId: TENANT_ID },
    {
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => clock.now,
      keyCache: new Map<string, MicrosoftTenantKeyCacheEntry>(),
      logger: { warn: vi.fn() },
    }
  );
  return { verifier, fetch, jwksFetches: () => jwksFetches, clock };
}

describe("MicrosoftIdTokenVerifier", () => {
  beforeAll(async () => {
    [tenantKey, otherKey] = await Promise.all([generateKey(), generateKey()]);
    tenantJwks = { keys: [await publishedKey(tenantKey, KEY_ID)] };
    for (const key of tenantJwks.keys) expect(key).not.toHaveProperty("alg");
  });

  it("verifies a tenant-signed token against a JWKS whose keys carry no alg", async () => {
    const { verifier, fetch } = harness();
    const payload = claims();

    await expect(verifier.verify(await signToken(payload))).resolves.toEqual(payload);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([METADATA_URL, JWKS_URL]);
  });

  it("serves later tokens from the cached keys without refetching", async () => {
    const { verifier, jwksFetches } = harness();

    await expect(verifier.verify(await signToken(claims()))).resolves.not.toBe(false);
    await expect(verifier.verify(await signToken(claims()))).resolves.not.toBe(false);

    expect(jwksFetches()).toBe(1);
  });

  it("rejects a token signed by a key the tenant does not publish", async () => {
    const { verifier } = harness();

    await expect(
      verifier.verify(await signToken(claims(), { key: otherKey.privateKey }))
    ).resolves.toBe(false);
  });

  it("rejects a token for another audience", async () => {
    const { verifier } = harness();

    await expect(verifier.verify(await signToken(claims({ aud: "other-client" })))).resolves.toBe(
      false
    );
  });

  it.each([
    ["issuer", { iss: `${AUTHORITY}/${OTHER_TENANT_ID}/v2.0` }],
    ["tid", { tid: OTHER_TENANT_ID }],
    ["v1 issuer", { iss: `https://sts.windows.net/${TENANT_ID}/` }],
  ])("rejects a token whose %s names another tenant", async (_case, overrides) => {
    const { verifier } = harness();

    await expect(verifier.verify(await signToken(claims(overrides)))).resolves.toBe(false);
  });

  it("rejects an expired token", async () => {
    const { verifier } = harness();
    const past = nowSeconds() - 3600;

    await expect(
      verifier.verify(await signToken(claims({ iat: past, nbf: past, exp: past + 300 })))
    ).resolves.toBe(false);
  });

  it("rejects a token issued more than an hour ago even if it has not expired", async () => {
    const { verifier } = harness();
    const twoHoursAgo = nowSeconds() - 2 * 3600;

    await expect(
      verifier.verify(
        await signToken(claims({ iat: twoHoursAgo, nbf: twoHoursAgo, exp: nowSeconds() + 300 }))
      )
    ).resolves.toBe(false);
  });

  it("tolerates five minutes of clock skew on exp and nbf", async () => {
    const { verifier } = harness();
    const now = nowSeconds();

    await expect(
      verifier.verify(await signToken(claims({ exp: now - 200, nbf: now + 200, iat: now + 200 })))
    ).resolves.not.toBe(false);
  });

  it("rejects a token that is not yet valid beyond the skew", async () => {
    const { verifier } = harness();
    const now = nowSeconds();

    await expect(
      verifier.verify(await signToken(claims({ nbf: now + 600, exp: now + 900 })))
    ).resolves.toBe(false);
  });

  it.each([
    ["alg none", (payload: Record<string, unknown>) => Promise.resolve(unsignedToken(payload))],
    ["HS256", (payload: Record<string, unknown>) => Promise.resolve(hmacToken(payload))],
    [
      "RS256 without a kid",
      (payload: Record<string, unknown>) =>
        signToken(payload, { header: { alg: "RS256", typ: "JWT" } }),
    ],
  ])("rejects a token with header %s without fetching keys", async (_case, token) => {
    const { verifier, fetch } = harness();

    await expect(verifier.verify(await token(claims()))).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["not a JWT", "not-a-jwt"],
    ["two segments", "a.b"],
    ["an unsigned payload", `${base64Url(JSON.stringify({ alg: "RS256", kid: KEY_ID }))}.e30.`],
    ["a garbage header", `!!.${base64Url("{}")}.sig`],
  ])("rejects %s", async (_case, token) => {
    const { verifier } = harness();

    await expect(verifier.verify(token)).resolves.toBe(false);
  });

  it("refreshes the JWKS exactly once for an unknown kid and fails if it stays unknown", async () => {
    const { verifier, jwksFetches, clock } = harness();
    await verifier.verify(await signToken(claims()));
    expect(jwksFetches()).toBe(1);
    clock.now += DEFAULT_UNKNOWN_KEY_REFRESH_COOLDOWN_MS;

    const unknown = await signToken(claims(), {
      key: otherKey.privateKey,
      header: { alg: "RS256", kid: "rotated-key", typ: "JWT" },
    });
    await expect(verifier.verify(unknown)).resolves.toBe(false);
    expect(jwksFetches()).toBe(2);

    // Within the cooldown, another unknown kid does not force a third fetch.
    await expect(verifier.verify(unknown)).resolves.toBe(false);
    expect(jwksFetches()).toBe(2);
  });

  it("picks up a rotated key on the refresh an unknown kid triggers", async () => {
    let published = tenantJwks;
    const { verifier, jwksFetches, clock } = harness(() => published);
    await verifier.verify(await signToken(claims()));
    published = { keys: [...tenantJwks.keys, await publishedKey(otherKey, "rotated-key")] };
    clock.now += DEFAULT_UNKNOWN_KEY_REFRESH_COOLDOWN_MS;

    const payload = claims();
    const rotated = await signToken(payload, {
      key: otherKey.privateKey,
      header: { alg: "RS256", kid: "rotated-key", typ: "JWT" },
    });

    await expect(verifier.verify(rotated)).resolves.toEqual(payload);
    expect(jwksFetches()).toBe(2);
  });

  it("does not refetch for an unknown kid right after loading the keys", async () => {
    const { verifier, jwksFetches } = harness();
    const unknown = await signToken(claims(), {
      header: { alg: "RS256", kid: "rotated-key", typ: "JWT" },
    });

    await expect(verifier.verify(unknown)).resolves.toBe(false);
    expect(jwksFetches()).toBe(1);
  });

  it("ignores published keys that are not RSA signing keys", async () => {
    const { verifier } = harness(() => ({
      keys: [
        { ...tenantJwks.keys[0], use: "enc" },
        { kty: "EC", kid: KEY_ID, crv: "P-256", x: "x", y: "y" },
      ],
    }));

    await expect(verifier.verify(await signToken(claims()))).resolves.toBe(false);
  });

  it("reports Microsoft as unavailable when the JWKS cannot be fetched", async () => {
    const { verifier } = harness(() => {
      throw new Error("connection reset");
    });

    await expect(verifier.verify(await signToken(claims()))).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "provider_unavailable",
    });
  });

  it("rejects an OpenID configuration that points at a non-HTTPS JWKS", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ issuer: ISSUER, jwks_uri: "http://login.microsoftonline.com/keys" })
    );
    const verifier = new MicrosoftIdTokenVerifier(
      { clientId: CLIENT_ID, tenantId: TENANT_ID },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        keyCache: new Map(),
        logger: { warn: vi.fn() },
      }
    );

    await expect(verifier.verify(await signToken(claims()))).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "provider_unavailable",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
