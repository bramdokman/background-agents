/**
 * Authenticating a control-plane callback. The control plane signs the body
 * it sends, not the request: `signature` is the lowercase hex HMAC-SHA256 of
 * `JSON.stringify` of the other fields, keyed with this bot's own service
 * secret (SERVICE_AUTH_SECRET_TEAMS_BOT). No signature header, no nonce.
 *
 * Verification therefore re-serialises the parsed body without `signature`.
 * `JSON.parse` keeps the control plane's key order, so the bytes match; the
 * body must be parsed once, here, and verified before any schema reshapes it.
 * A fresh `timestamp` bounds how long a captured body can be replayed.
 */

import { isSignedCallbackPayload, verifyCallbackSignature } from "@open-inspect/shared/auth";

type CallbackRejectReason =
  | "payload_too_large"
  | "invalid_json"
  | "unsigned_payload"
  | "invalid_signature"
  | "stale_timestamp";

export type SignedCallbackPayload = Record<string, unknown> & { signature: string };

export type CallbackVerification =
  | { ok: true; payload: SignedCallbackPayload }
  | { ok: false; status: 400 | 401; reason: CallbackRejectReason };

export interface VerifyOptions {
  /** The bot's service secret; the control plane signs callbacks with the destination's key. */
  secret: string;
  now: number;
  /** How far the signed `timestamp` may sit from `now`, either way. */
  maxAgeMs: number;
  maxBodyBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function verifySignedCallback(
  rawBody: string,
  options: VerifyOptions
): Promise<CallbackVerification> {
  if (Buffer.byteLength(rawBody, "utf8") > options.maxBodyBytes) {
    return { ok: false, status: 400, reason: "payload_too_large" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, reason: "invalid_json" };
  }
  if (!isRecord(payload) || !isSignedCallbackPayload(payload)) {
    return { ok: false, status: 400, reason: "unsigned_payload" };
  }
  const signed: SignedCallbackPayload = payload;
  if (!(await verifyCallbackSignature(signed, options.secret))) {
    return { ok: false, status: 401, reason: "invalid_signature" };
  }
  const timestamp = signed.timestamp;
  if (typeof timestamp !== "number" || Math.abs(options.now - timestamp) > options.maxAgeMs) {
    return { ok: false, status: 401, reason: "stale_timestamp" };
  }
  return { ok: true, payload: signed };
}
