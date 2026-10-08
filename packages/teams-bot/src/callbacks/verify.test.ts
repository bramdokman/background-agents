import { computeHmacHex } from "@open-inspect/shared/auth";
import { describe, expect, it } from "vitest";
import { verifySignedCallback } from "./verify";

const SECRET = "placeholder-service-secret";
const NOW = 1_760_000_000_000;

/** Sign exactly as the control plane does: the body without `signature`, in its key order. */
async function signedBody(unsigned: Record<string, unknown>, secret = SECRET): Promise<string> {
  const signature = await computeHmacHex(JSON.stringify(unsigned), secret);
  return JSON.stringify({ ...unsigned, signature });
}

const options = { secret: SECRET, now: NOW, maxAgeMs: 5 * 60 * 1000, maxBodyBytes: 1024 };

describe("verifySignedCallback", () => {
  const unsigned = {
    sessionId: "session-1",
    messageId: "message-1",
    success: true,
    timestamp: NOW - 1_000,
    context: { source: "msteams", conversationId: "19:c;messageid=1", args: { "2": "b", a: 1 } },
  };

  it("accepts a body the control plane signed and returns it parsed", async () => {
    const result = await verifySignedCallback(await signedBody(unsigned), options);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toMatchObject({ sessionId: "session-1" });
  });

  it("rejects a signature made with another secret, and a body altered after signing", async () => {
    const wrongKey = await verifySignedCallback(await signedBody(unsigned, "other"), options);
    expect(wrongKey).toEqual({ ok: false, status: 401, reason: "invalid_signature" });

    const altered = JSON.parse(await signedBody(unsigned)) as Record<string, unknown>;
    altered.success = false;
    const tampered = await verifySignedCallback(JSON.stringify(altered), options);
    expect(tampered).toEqual({ ok: false, status: 401, reason: "invalid_signature" });
  });

  it("rejects a stale or missing timestamp after the signature checked out", async () => {
    const old = await verifySignedCallback(
      await signedBody({ ...unsigned, timestamp: NOW - 6 * 60 * 1000 }),
      options
    );
    expect(old).toEqual({ ok: false, status: 401, reason: "stale_timestamp" });
    const future = await verifySignedCallback(
      await signedBody({ ...unsigned, timestamp: NOW + 6 * 60 * 1000 }),
      options
    );
    expect(future).toEqual({ ok: false, status: 401, reason: "stale_timestamp" });
    const { timestamp: _timestamp, ...withoutTimestamp } = unsigned;
    const missing = await verifySignedCallback(await signedBody(withoutTimestamp), options);
    expect(missing).toEqual({ ok: false, status: 401, reason: "stale_timestamp" });
  });

  it("answers 400 for bodies that cannot be verified at all", async () => {
    expect(await verifySignedCallback("not json", options)).toEqual({
      ok: false,
      status: 400,
      reason: "invalid_json",
    });
    expect(await verifySignedCallback(JSON.stringify(unsigned), options)).toEqual({
      ok: false,
      status: 400,
      reason: "unsigned_payload",
    });
    expect(await verifySignedCallback("[1]", options)).toEqual({
      ok: false,
      status: 400,
      reason: "unsigned_payload",
    });
    const big = await signedBody({ ...unsigned, padding: "x".repeat(2048) });
    expect(await verifySignedCallback(big, options)).toEqual({
      ok: false,
      status: 400,
      reason: "payload_too_large",
    });
  });
});
