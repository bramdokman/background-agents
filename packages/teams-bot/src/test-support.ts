/**
 * Shared fixtures for the Teams bot's tests: a signing key pair with a key
 * resolver that knows it, token minting, activity fixtures, and a recording
 * fetch that answers scripted routes.
 */

import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import type { KeyResolver } from "./bot-framework/jwks";
import type { TeamsActivity } from "./types";

export const APP_ID = "0b4f1c2d-8e3a-4f5b-9c6d-7e8f9a0b1c2d";
export const TENANT_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
export const OTHER_TENANT_ID = "11111111-2222-3333-4444-555555555555";
export const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
export const CHANNEL_ID = "19:0123456789abcdef0123456789abcdef@thread.tacv2";
export const USER_OID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: JsonWebKey;
}

export function makeSigningKey(kid = "test-key-1"): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig" } };
}

export function resolverFor(...keys: SigningKey[]): KeyResolver {
  return {
    async getKey(_issuer, kid) {
      return keys.find((key) => key.kid === kid)?.jwk ?? null;
    },
  };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function mintToken(
  key: SigningKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {}
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const fullHeader = { alg: "RS256", typ: "JWT", kid: key.kid, ...header };
  const payload = {
    iss: BOT_FRAMEWORK_ISSUER,
    aud: APP_ID,
    iat: nowSeconds,
    nbf: nowSeconds - 60,
    exp: nowSeconds + 600,
    serviceurl: SERVICE_URL,
    ...claims,
  };
  const signingInput = `${base64url(JSON.stringify(fullHeader))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

export function activityFixture(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    id: "1759900000001",
    channelId: "msteams",
    serviceUrl: SERVICE_URL,
    from: { id: "29:1user", name: "Casey", aadObjectId: USER_OID },
    recipient: { id: `28:${APP_ID}`, name: "Open-Inspect" },
    conversation: {
      id: `${CHANNEL_ID};messageid=1759900000001`,
      conversationType: "channel",
      tenantId: TENANT_ID,
    },
    channelData: {
      channel: { id: CHANNEL_ID },
      team: { id: "19:team@thread.tacv2" },
      tenant: { id: TENANT_ID },
    },
    entities: [
      {
        type: "mention",
        text: "<at>Open-Inspect</at>",
        mentioned: { id: `28:${APP_ID}`, name: "Open-Inspect" },
      },
    ],
    text: "<at>Open-Inspect</at> ProvidenceIT/playground add a README badge",
    timestamp: "2026-10-08T09:00:00.000Z",
    ...overrides,
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
}

export type RouteHandler = (request: RecordedRequest) => Response | Promise<Response>;

/** A fetch whose answers are scripted per `METHOD pathname`; every call is recorded. */
export function scriptedFetch(routes: Record<string, RouteHandler>) {
  const requests: RecordedRequest[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const rawBody = typeof init?.body === "string" ? init.body : "";
    let body: unknown = rawBody;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    const recorded = { method, url, headers, body, rawBody };
    requests.push(recorded);
    const key = `${method} ${decodeURIComponent(new URL(url).pathname)}`;
    const handler = routes[key] ?? routes[`${method} *`];
    if (!handler) return Response.json({ error: `unscripted ${key}` }, { status: 599 });
    return handler(recorded);
  };
  return { fetch: fetchFn, requests };
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
