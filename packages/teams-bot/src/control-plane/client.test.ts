import {
  ACTOR_HEADER,
  buildCanonicalRequestString,
  canonicalizeQuery,
  parseServiceSignatureHeader,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  sha256Hex,
} from "@open-inspect/shared/service-auth";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { describe, expect, it } from "vitest";
import { ControlPlaneClient, microsoftActor } from "./client";
import { json, scriptedFetch, USER_OID, type RecordedRequest } from "../test-support";

const SECRET = "placeholder-service-secret";
const BASE_URL = "http://10.43.250.21:8787";
const actor = microsoftActor(USER_OID);

/** Recompute the sig1 signature the control plane would and compare it with the header sent. */
async function expectValidSig1(request: RecordedRequest): Promise<void> {
  expect(request.headers[SERVICE_HEADER.toLowerCase()]).toBe("teams-bot");
  const parsed = parseServiceSignatureHeader(
    request.headers[SERVICE_SIGNATURE_HEADER.toLowerCase()]
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const url = new URL(request.url);
  const canonical = buildCanonicalRequestString({
    service: "teams-bot",
    timestampMs: parsed.timestampMs,
    nonce: parsed.nonce,
    method: request.method,
    pathname: url.pathname,
    canonicalQuery: canonicalizeQuery(url.search),
    bodySha256Hex: await sha256Hex(request.rawBody),
    actor: request.headers[ACTOR_HEADER.toLowerCase()] ?? "",
  });
  expect(parsed.signature).toBe(await computeHmacHex(canonical, SECRET));
}

describe("ControlPlaneClient", () => {
  it("asserts the microsoft actor namespace", () => {
    expect(actor).toBe(`microsoft:${USER_OID}`);
  });

  it("looks bindings up without an actor and distinguishes unbound from unavailable", async () => {
    const remote = scriptedFetch({
      "GET /channel-bindings/msteams/19:bound@thread.tacv2": () =>
        json({ teamId: "team-platform", kind: "primary" }),
      "GET /channel-bindings/msteams/19:unbound@thread.tacv2": () =>
        json({ error: "Channel is not bound", code: "channel_unbound" }, 404),
      "GET /channel-bindings/msteams/19:down@thread.tacv2": () =>
        json({ error: "unavailable" }, 503),
    });
    const client = new ControlPlaneClient({
      baseUrl: `${BASE_URL}/`,
      secret: SECRET,
      fetch: remote.fetch,
    });
    await expect(client.lookupChannelBinding("19:bound@thread.tacv2")).resolves.toEqual({
      kind: "resolved",
      binding: { teamId: "team-platform", kind: "primary" },
    });
    await expect(client.lookupChannelBinding("19:unbound@thread.tacv2")).resolves.toEqual({
      kind: "rejected",
    });
    await expect(client.lookupChannelBinding("19:down@thread.tacv2")).resolves.toEqual({
      kind: "unavailable",
      status: 503,
    });
    expect(remote.requests[0].url).toBe(
      `${BASE_URL}/channel-bindings/msteams/19%3Abound%40thread.tacv2`
    );
    expect(remote.requests[0].headers[ACTOR_HEADER.toLowerCase()]).toBeUndefined();
    await expectValidSig1(remote.requests[0]);
  });

  it("creates a session with a signed body and the actor header", async () => {
    const remote = scriptedFetch({
      "POST /sessions": () => json({ sessionId: "session-1", status: "created" }),
    });
    const client = new ControlPlaneClient({
      baseUrl: BASE_URL,
      secret: SECRET,
      fetch: remote.fetch,
    });
    const result = await client.createSession(
      actor,
      {
        teamId: "team-platform",
        repoOwner: "ProvidenceIT",
        repoName: "playground",
        model: "anthropic/claude-sonnet-4.5",
        actorDisplayName: "Casey",
      },
      "trace-1"
    );
    expect(result).toEqual({ ok: true, data: { sessionId: "session-1", status: "created" } });
    const [request] = remote.requests;
    expect(request.body).toEqual({
      teamId: "team-platform",
      repoOwner: "ProvidenceIT",
      repoName: "playground",
      model: "anthropic/claude-sonnet-4.5",
      actorDisplayName: "Casey",
    });
    expect(request.headers[ACTOR_HEADER.toLowerCase()]).toBe(`microsoft:${USER_OID}`);
    expect(request.headers["x-trace-id"]).toBe("trace-1");
    expect(request.headers["content-type"]).toBe("application/json");
    await expectValidSig1(request);
  });

  it("sends a prompt with source msteams and the callback context", async () => {
    const remote = scriptedFetch({
      "POST /sessions/session-1/prompt": () => json({ messageId: "message-1", status: "queued" }),
    });
    const client = new ControlPlaneClient({
      baseUrl: BASE_URL,
      secret: SECRET,
      fetch: remote.fetch,
    });
    const callbackContext = {
      source: "msteams" as const,
      conversationId: "19:chan@thread.tacv2;messageid=100",
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      replyToId: "100",
      channelId: "19:chan@thread.tacv2",
      repoFullName: "ProvidenceIT/playground",
      model: "anthropic/claude-sonnet-4.5",
    };
    const result = await client.sendPrompt(actor, "session-1", {
      content: "add a README badge",
      callbackContext,
    });
    expect(result).toEqual({ ok: true, data: { messageId: "message-1", status: "queued" } });
    expect(remote.requests[0].body).toEqual({
      content: "add a README badge",
      source: "msteams",
      callbackContext,
    });
    await expectValidSig1(remote.requests[0]);
  });

  it("classifies the control plane's denials", async () => {
    const remote = scriptedFetch({
      "POST /sessions": () => json({ error: "Forbidden", code: "service_actor_not_enrolled" }, 403),
      "POST /sessions/quota/prompt": () =>
        json(
          {
            error: "Daily turn quota reached",
            code: "USAGE_QUOTA_EXCEEDED",
            scopeKind: "user",
            period: "day",
            exceeded: [],
          },
          429
        ),
      "POST /sessions/busy/prompt": () =>
        json(
          {
            error: "Prompt queue is full (5 pending). Wait for the current turn to finish.",
            code: "PROMPT_QUEUE_FULL",
          },
          429
        ),
      "POST /sessions/denied/prompt": () =>
        json({ error: "you are not a member of this channel's team", code: "not_member" }, 403),
      "POST /sessions/gone/prompt": () => json({ error: "Session not found" }, 404),
      "POST /sessions/bad/prompt": () => json({ error: "Prompt content must not be blank" }, 400),
      "POST /sessions/down/stop": () => new Response("nope", { status: 502 }),
    });
    const client = new ControlPlaneClient({
      baseUrl: BASE_URL,
      secret: SECRET,
      fetch: remote.fetch,
    });
    const context = {
      source: "msteams" as const,
      conversationId: "c",
      serviceUrl: "https://smba.trafficmanager.net/",
      model: "m",
    };
    await expect(
      client.createSession(actor, { teamId: "t", repoOwner: "o", repoName: "r", model: "m" })
    ).resolves.toEqual({
      ok: false,
      reason: "not_enrolled",
      status: 403,
      code: "service_actor_not_enrolled",
      message: "Forbidden",
    });
    await expect(
      client.sendPrompt(actor, "quota", { content: "x", callbackContext: context })
    ).resolves.toEqual({
      ok: false,
      reason: "quota",
      status: 429,
      code: "USAGE_QUOTA_EXCEEDED",
      message: "Daily turn quota reached",
    });
    await expect(
      client.sendPrompt(actor, "busy", { content: "x", callbackContext: context })
    ).resolves.toEqual({
      ok: false,
      reason: "rate_limited",
      status: 429,
      code: "PROMPT_QUEUE_FULL",
      message: "Prompt queue is full (5 pending). Wait for the current turn to finish.",
    });
    await expect(
      client.sendPrompt(actor, "denied", { content: "x", callbackContext: context })
    ).resolves.toEqual({
      ok: false,
      reason: "forbidden",
      status: 403,
      code: "not_member",
      message: "you are not a member of this channel's team",
    });
    await expect(
      client.sendPrompt(actor, "gone", { content: "x", callbackContext: context })
    ).resolves.toMatchObject({
      ok: false,
      reason: "not_found",
    });
    await expect(
      client.sendPrompt(actor, "bad", { content: "x", callbackContext: context })
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid",
      message: "Prompt content must not be blank",
    });
    await expect(client.stopSession(actor, "down")).resolves.toEqual({
      ok: false,
      reason: "transient",
      status: 502,
    });
  });

  it("treats a network failure or an unparseable body as transient", async () => {
    const failing = new ControlPlaneClient({
      baseUrl: BASE_URL,
      secret: SECRET,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(failing.stopSession(actor, "s")).resolves.toEqual({
      ok: false,
      reason: "transient",
      status: 0,
    });
    const remote = scriptedFetch({ "POST /sessions": () => json({ nope: true }) });
    const client = new ControlPlaneClient({
      baseUrl: BASE_URL,
      secret: SECRET,
      fetch: remote.fetch,
    });
    await expect(
      client.createSession(actor, { teamId: "t", repoOwner: "o", repoName: "r", model: "m" })
    ).resolves.toEqual({ ok: false, reason: "transient", status: 200 });
  });

  it("lists a channel's repositories and a session's messages with signed query strings", async () => {
    const remote = scriptedFetch({
      "GET /repos": () =>
        json({
          repos: [
            {
              id: 1,
              owner: "ProvidenceIT",
              name: "playground",
              fullName: "ProvidenceIT/playground",
              description: null,
              private: true,
              defaultBranch: "main",
              archived: false,
            },
          ],
          cached: false,
          cachedAt: "2026-10-08T00:00:00.000Z",
          teamHasRepositoryGrants: true,
        }),
      "GET /sessions/session-1/messages": () =>
        json({
          messages: [
            {
              id: "m-1",
              authorId: `microsoft:${USER_OID}`,
              content: "x",
              source: "msteams",
              attachments: null,
              status: "processing",
              createdAt: 1,
              startedAt: 2,
              completedAt: null,
            },
          ],
          hasMore: false,
        }),
    });
    const client = new ControlPlaneClient({
      baseUrl: BASE_URL,
      secret: SECRET,
      fetch: remote.fetch,
    });
    const repos = await client.listRepositories(actor, "19:chan@thread.tacv2");
    expect(repos).toMatchObject({ ok: true, data: [{ fullName: "ProvidenceIT/playground" }] });
    // Channel-scoped, never teamId: the control plane refuses a teamId from this bot.
    expect(remote.requests[0].url).toBe(
      `${BASE_URL}/repos?channel=msteams%3A19%3Achan%40thread.tacv2`
    );
    expect(new URL(remote.requests[0].url).searchParams.get("channel")).toBe(
      "msteams:19:chan@thread.tacv2"
    );
    expect(new URL(remote.requests[0].url).searchParams.has("teamId")).toBe(false);
    const messages = await client.listMessages(actor, "session-1", {
      status: "processing",
      limit: 1,
    });
    expect(messages).toMatchObject({ ok: true, data: [{ id: "m-1", status: "processing" }] });
    expect(remote.requests[1].url).toBe(
      `${BASE_URL}/sessions/session-1/messages?status=processing&limit=1`
    );
    await expectValidSig1(remote.requests[0]);
    await expectValidSig1(remote.requests[1]);
  });
});

describe("session reads for completions", () => {
  it("follows the events cursor page by page as the actor", async () => {
    const pages: Record<string, unknown> = {
      first: {
        events: [{ id: "e1", type: "token", data: { content: "a" }, messageId: "m", createdAt: 1 }],
        cursor: "c2",
        hasMore: true,
      },
      c2: {
        events: [
          {
            id: "e2",
            type: "execution_complete",
            data: { success: true },
            messageId: "m",
            createdAt: 2,
          },
        ],
        hasMore: false,
      },
    };
    const remote = scriptedFetch({
      "GET /sessions/session-1/events": (request) => {
        const cursor = new URL(request.url).searchParams.get("cursor") ?? "first";
        return json(pages[cursor]);
      },
    });
    const client = new ControlPlaneClient({
      baseUrl: BASE_URL,
      secret: SECRET,
      fetch: remote.fetch,
    });
    const result = await client.listEvents({ actor }, "session-1", "m", "trace-1");
    expect(result).toEqual({
      ok: true,
      data: [
        { id: "e1", type: "token", data: { content: "a" }, messageId: "m", createdAt: 1 },
        {
          id: "e2",
          type: "execution_complete",
          data: { success: true },
          messageId: "m",
          createdAt: 2,
        },
      ],
    });
    expect(remote.requests).toHaveLength(2);
    const [first, second] = remote.requests;
    expect(new URL(first.url).searchParams.get("message_id")).toBe("m");
    expect(new URL(first.url).searchParams.get("limit")).toBe("200");
    expect(new URL(second.url).searchParams.get("cursor")).toBe("c2");
    expect(first.headers[ACTOR_HEADER.toLowerCase()]).toBe(actor);
    await expectValidSig1(second);
  });

  it("classifies a refused events read and lists artifacts", async () => {
    const remote = scriptedFetch({
      "GET /sessions/session-1/events": () => json({ error: "Forbidden" }, 403),
      "GET /sessions/session-1/artifacts": () =>
        json({
          artifacts: [{ id: "a", type: "pr", url: "https://pr", metadata: null, createdAt: 5 }],
        }),
    });
    const client = new ControlPlaneClient({
      baseUrl: BASE_URL,
      secret: SECRET,
      fetch: remote.fetch,
    });
    expect(await client.listEvents({ actor }, "session-1", "m")).toMatchObject({
      ok: false,
      reason: "forbidden",
      status: 403,
    });
    expect(await client.listArtifacts({ actor }, "session-1")).toEqual({
      ok: true,
      data: [{ id: "a", type: "pr", url: "https://pr", metadata: null, createdAt: 5 }],
    });
  });
});
