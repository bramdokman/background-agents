import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_AUTH_CLIENT_IP_HEADER } from "@open-inspect/shared/browser-auth-routes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../../node/sqlite-database";
import { AuthorizationStore } from "../../db/authorization-store";
import { UserStore } from "../../db/user-store";
import type { Env } from "../../types";
import { createUserAuthRuntimeFromEnv, type UserAuthRuntime } from "./runtime";

/**
 * The Microsoft sign-in as the browser drives it: initiation, the OAuth
 * callback with a tenant-issued ID token, and the session that results —
 * through the real Better Auth instance over the canonical SQLite schema,
 * with only Microsoft's three HTTP endpoints (token exchange, OpenID
 * discovery, JWKS) mocked.
 */

const PUBLIC_WEB_ORIGIN = "https://web.test.local";
const CLIENT_ID = "microsoft-client-id";
const TENANT_ID = "2f0d9b3a-5c1e-4a7b-9d2c-8e6f1a3b5c7d";
const OTHER_TENANT_ID = "7a1c2e3d-4b5f-4a6c-8d9e-0f1a2b3c4d5e";
const OBJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const AUTHORITY = "https://login.microsoftonline.com";
const KEY_ID = "test-microsoft-key";
const MS_PER_SECOND = 1000;

const ENV = {
  WEB_APP_URL: PUBLIC_WEB_ORIGIN,
  BROWSER_AUTH_SECRET: "test-only-better-auth-secret-with-at-least-32-characters",
  MICROSOFT_CLIENT_ID: CLIENT_ID,
  MICROSOFT_CLIENT_SECRET: "microsoft-client-secret",
  MICROSOFT_TENANT_ID: TENANT_ID,
  MICROSOFT_ALLOWED_DOMAINS: "corp.example",
} as unknown as Env;

interface IdTokenClaims {
  readonly tid?: string;
  readonly oid?: string;
  readonly email: string;
  readonly name?: string;
  readonly xms_edov?: boolean;
}

let keyPair: CryptoKeyPair;
let publicJwk: Record<string, unknown>;
/** The ID token the mocked token endpoint returns for the next callback. */
let nextIdToken = "";
// Better Auth rate-limits sign-in initiation per client IP in memory that
// outlives each test's database; a distinct IP per flow keeps it out of the way.
let clientIpCounter = 0;

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Buffer.from(bytes).toString("base64url");
}

async function signIdToken(claims: IdTokenClaims): Promise<string> {
  const tid = claims.tid ?? TENANT_ID;
  const issuedAt = Math.floor(Date.now() / MS_PER_SECOND);
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: KEY_ID, typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: `${AUTHORITY}/${tid}/v2.0`,
      aud: CLIENT_ID,
      iat: issuedAt,
      nbf: issuedAt,
      exp: issuedAt + 300,
      sub: "app-pairwise-subject",
      oid: OBJECT_ID,
      preferred_username: claims.email,
      ...claims,
      tid,
    })
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

function cookiePair(response: Response, name: string): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookie = (headers.getSetCookie?.call(headers) ?? []).find(
    (value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`)
  );
  return cookie ? cookie.split(";", 1)[0] : null;
}

/** Initiation plus callback, as the web proxy relays them from the browser. */
async function signInWithMicrosoft(
  runtime: UserAuthRuntime,
  claims: IdTokenClaims
): Promise<{ callback: Response; sessionCookie: string | null }> {
  nextIdToken = await signIdToken(claims);
  const clientIp = `10.0.0.${++clientIpCounter}`;
  const initiation = await runtime.auth.handler(
    new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: PUBLIC_WEB_ORIGIN,
        [BROWSER_AUTH_CLIENT_IP_HEADER]: clientIp,
      },
      body: JSON.stringify({ provider: "microsoft", callbackURL: "/after", disableRedirect: true }),
    })
  );
  expect(initiation.status).toBe(200);
  const providerUrl = new URL(((await initiation.json()) as { url: string }).url);
  expect(providerUrl.origin + providerUrl.pathname).toBe(
    `${AUTHORITY}/${TENANT_ID}/oauth2/v2.0/authorize`
  );
  expect(providerUrl.searchParams.get("scope")).toBe("openid profile email User.Read");
  expect(providerUrl.searchParams.get("redirect_uri")).toBe(
    `${PUBLIC_WEB_ORIGIN}/api/auth/callback/microsoft`
  );
  const state = providerUrl.searchParams.get("state");
  const stateCookie = cookiePair(initiation, "__Secure-openinspect.state");
  if (!state || !stateCookie) throw new Error("Sign-in initiation did not produce state");

  const callback = await runtime.auth.handler(
    new Request(
      `${PUBLIC_WEB_ORIGIN}/api/auth/callback/microsoft?code=authorization-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: stateCookie, [BROWSER_AUTH_CLIENT_IP_HEADER]: clientIp } }
    )
  );
  return { callback, sessionCookie: cookiePair(callback, "__Secure-openinspect.session_token") };
}

describe("Microsoft Entra ID sign-in", () => {
  let db: NodeSqlDatabase;
  let runtime: UserAuthRuntime;

  beforeAll(async () => {
    keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    // Microsoft's shape: the tenant JWKS publishes kty, use, kid, x5t, n, e
    // (and x5c) with NO `alg`; a verifier that reads the algorithm from the
    // key rejects every real token. Web Crypto's export adds alg/key_ops/ext.
    const { n, e } = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
    publicJwk = { kty: "RSA", use: "sig", kid: KEY_ID, x5t: KEY_ID, n, e };
    expect(publicJwk).not.toHaveProperty("alg");
  });

  beforeEach(() => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    runtime = createUserAuthRuntimeFromEnv(ENV, db);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === `${AUTHORITY}/${TENANT_ID}/oauth2/v2.0/token`) {
          const body = new URLSearchParams(
            input instanceof Request ? await input.text() : String(init?.body ?? "")
          );
          expect(body.get("grant_type")).toBe("authorization_code");
          expect(body.get("code")).toBe("authorization-code");
          expect(body.get("client_id")).toBe(CLIENT_ID);
          expect(body.get("client_secret")).toBe("microsoft-client-secret");
          expect(body.get("redirect_uri")).toBe(`${PUBLIC_WEB_ORIGIN}/api/auth/callback/microsoft`);
          expect(body.get("code_verifier")).toBeTruthy();
          return Response.json({
            token_type: "Bearer",
            scope: "openid profile email User.Read",
            expires_in: 3600,
            access_token: "microsoft-access-token",
            id_token: nextIdToken,
          });
        }
        if (url === `${AUTHORITY}/${TENANT_ID}/v2.0/.well-known/openid-configuration`) {
          return Response.json({
            issuer: `${AUTHORITY}/${TENANT_ID}/v2.0`,
            jwks_uri: `${AUTHORITY}/${TENANT_ID}/discovery/v2.0/keys`,
          });
        }
        if (url === `${AUTHORITY}/${TENANT_ID}/discovery/v2.0/keys`) {
          return Response.json({ keys: [publicJwk] });
        }
        throw new Error(`Unexpected external request: ${url}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  async function auditDenials(): Promise<{ reason_code: string; metadata_json: string }[]> {
    const result = await db
      .prepare(
        `SELECT reason_code, metadata_json FROM authorization_audit_events
         WHERE action = 'auth.sign_in_denied' AND resource_id = 'microsoft'`
      )
      .all<{ reason_code: string; metadata_json: string }>();
    return result.results ?? [];
  }

  it("signs an attested, allowlisted tenant user in as an active member keyed by the object id", async () => {
    const { callback, sessionCookie } = await signInWithMicrosoft(runtime, {
      email: "Person@Corp.Example",
      name: "Person Example",
      xms_edov: true,
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/after");
    expect(sessionCookie).not.toBeNull();

    const session = await runtime.auth.api.getSession({
      headers: new Headers({ Cookie: sessionCookie ?? "" }),
    });
    expect(session?.user).toMatchObject({
      name: "Person Example",
      email: "person@corp.example",
      emailVerified: true,
    });
    const userId = session?.user.id ?? "";

    await expect(
      db
        .prepare(
          `SELECT u.email, u.email_verified, u.suspended_at, r.key AS role
           FROM users u
           JOIN user_role_assignments ura ON ura.user_id = u.id
           JOIN roles r ON r.id = ura.role_id
           WHERE u.id = ?`
        )
        .bind(userId)
        .first()
    ).resolves.toEqual({
      email: "person@corp.example",
      email_verified: 1,
      suspended_at: null,
      role: "member",
    });
    // The workspace member record: an active (not suspended) default Member.
    expect(await new AuthorizationStore(db).listMembers()).toEqual([
      expect.objectContaining({
        userId,
        email: "person@corp.example",
        suspendedAt: null,
        role: expect.objectContaining({ key: "member" }),
      }),
    ]);
    await expect(
      db
        .prepare(
          `SELECT provider, provider_user_id, provider_issuer, user_id
           FROM user_identities WHERE provider = 'microsoft'`
        )
        .first()
    ).resolves.toEqual({
      provider: "microsoft",
      provider_user_id: OBJECT_ID,
      provider_issuer: AUTHORITY,
      user_id: userId,
    });
    expect(await auditDenials()).toEqual([]);
  });

  it("lands a bot-first Microsoft identity on its canonical row and verifies its email", async () => {
    const store = new UserStore(db);
    const botFirst = await store.resolveOrCreateUser({
      provider: "microsoft",
      providerUserId: OBJECT_ID,
      providerEmail: "person@corp.example",
      displayName: "Person (Teams)",
    });
    expect((await store.getUserById(botFirst.id))?.emailVerified).toBe(false);

    const { sessionCookie } = await signInWithMicrosoft(runtime, {
      email: "person@corp.example",
      xms_edov: true,
    });
    const session = await runtime.auth.api.getSession({
      headers: new Headers({ Cookie: sessionCookie ?? "" }),
    });

    expect(session?.user.id).toBe(botFirst.id);
    expect((await store.getUserById(botFirst.id))?.emailVerified).toBe(true);
    await expect(
      db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>()
    ).resolves.toEqual({ count: 1 });
  });

  it.each([
    [
      "a non-allowlisted domain from the tenant",
      { email: "person@other.example", xms_edov: true },
      "microsoft_domain_not_allowed",
    ],
    [
      "an email the tenant does not attest",
      { email: "person@corp.example", xms_edov: false },
      "microsoft_email_unverified",
    ],
  ] as const)("denies %s with an audit row and no session", async (_case, claims, reason) => {
    const { callback, sessionCookie } = await signInWithMicrosoft(runtime, claims);

    expect(callback.status).toBe(500);
    expect(sessionCookie).toBeNull();
    await expect(
      db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>()
    ).resolves.toEqual({ count: 0 });

    const denials = await auditDenials();
    expect(denials).toHaveLength(1);
    expect(denials[0].reason_code).toBe(reason);
    expect(JSON.parse(denials[0].metadata_json).requested).toMatchObject({
      provider: "microsoft",
      subject: OBJECT_ID,
      tenantId: TENANT_ID,
    });
  });

  it("rejects a token from another tenant before admission", async () => {
    const { callback, sessionCookie } = await signInWithMicrosoft(runtime, {
      tid: OTHER_TENANT_ID,
      email: "person@corp.example",
      xms_edov: true,
    });

    expect(callback.status).toBe(500);
    expect(sessionCookie).toBeNull();
    await expect(
      db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>()
    ).resolves.toEqual({ count: 0 });
  });
});
