/**
 * End-to-end through the HTTP route: a Bot Framework activity arrives at
 * POST /api/messages, and the control plane and the connector are mocked at
 * the fetch seam. Every assertion is on the exact requests made and the
 * exact replies posted.
 */

import { ACTOR_HEADER } from "@open-inspect/shared/service-auth";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createInboundAuthenticator } from "../bot-framework/auth";
import { createBotFrameworkClient } from "../bot-framework/client";
import { parseAllowedServiceUrlHosts } from "../bot-framework/service-url";
import { ControlPlaneClient } from "../control-plane/client";
import { createLogger } from "../logger";
import { TeamsStateStore } from "../state/store";
import { WORKING_TEXT } from "../teams/reply-sink";
import {
  activityFixture,
  APP_ID,
  CHANNEL_ID,
  json,
  makeSigningKey,
  mintToken,
  OTHER_TENANT_ID,
  resolverFor,
  scriptedFetch,
  SERVICE_URL,
  TENANT_ID,
  USER_OID,
  type RouteHandler,
} from "../test-support";
import type { TeamsActivity } from "../types";
import { createActivityHandler, createKeyedQueue } from "./handler";
import {
  HELP_TEXT,
  NO_SESSION_IN_THREAD_MESSAGE,
  STOP_REQUESTED_MESSAGE,
  THREAD_CLOSED_MESSAGE,
  UNBOUND_CHANNEL_MESSAGE,
  BINDING_UNAVAILABLE_MESSAGE,
  NOT_A_CHANNEL_MESSAGE,
  signInMessage,
} from "./messages";

const WEB_APP_URL = "https://agent-dokman.tailbd0db8.ts.net:10443";
const CONTROL_PLANE_URL = "http://10.43.250.21:8787";
const key = makeSigningKey();
const silent = createLogger("test", {}, "error");
const ROOT_ID = "1759900000001";
const THREAD_KEY = `${CHANNEL_ID};messageid=${ROOT_ID}`;

const boundChannel: RouteHandler = () => json({ teamId: "team-platform", kind: "primary" });
const sessionCreated: RouteHandler = () => json({ sessionId: "session-1", status: "created" });
const promptQueued: RouteHandler = () => json({ messageId: "message-1", status: "queued" });

function harness(
  controlPlaneRoutes: Record<string, RouteHandler>,
  options: { store?: TeamsStateStore } = {}
) {
  const controlPlaneRemote = scriptedFetch(controlPlaneRoutes);
  let replyCounter = 0;
  const connectorRemote = scriptedFetch({
    "POST *": () => json({ id: `reply-${++replyCounter}` }),
    "PUT *": () => json({ id: "updated" }),
  });
  const store = options.store ?? TeamsStateStore.inMemory();
  const controlPlane = new ControlPlaneClient({
    baseUrl: CONTROL_PLANE_URL,
    secret: "placeholder-service-secret",
    fetch: controlPlaneRemote.fetch,
  });
  const bot = createBotFrameworkClient({
    tokens: { getToken: async () => "placeholder-token" },
    allowedServiceUrlHosts: parseAllowedServiceUrlHosts(
      "*.botframework.com,smba.trafficmanager.net"
    ),
    fetch: connectorRemote.fetch,
  });
  const handleActivity = createActivityHandler({
    tenantId: TENANT_ID,
    allowedServiceUrlHosts: parseAllowedServiceUrlHosts(
      "*.botframework.com,smba.trafficmanager.net"
    ),
    webAppUrl: WEB_APP_URL,
    controlPlane,
    bot,
    store,
    log: silent,
  });
  const background: Promise<void>[] = [];
  const app = createApp({
    auth: createInboundAuthenticator({
      appId: APP_ID,
      tenantId: TENANT_ID,
      keys: resolverFor(key),
    }),
    handleActivity,
    log: silent,
    schedule: (task) => background.push(task),
  });

  async function post(activity: TeamsActivity, token: string | null = mintToken(key, {})) {
    const response = await app.request("/api/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(activity),
    });
    await Promise.all(background.splice(0));
    return response;
  }

  const controlPlaneCalls = () =>
    controlPlaneRemote.requests.map(
      (request) =>
        `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`
    );
  const replies = () =>
    connectorRemote.requests.map((request) => ({
      method: request.method,
      path: new URL(request.url).pathname,
      text: (request.body as { text?: string }).text,
      replyToId: (request.body as { replyToId?: string }).replyToId,
    }));

  return { app, post, store, controlPlaneRemote, connectorRemote, controlPlaneCalls, replies };
}

describe("POST /api/messages", () => {
  it("answers 401 without a token and makes no control-plane call", async () => {
    const h = harness({ "GET *": boundChannel });
    const response = await h.post(activityFixture(), null);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(h.controlPlaneCalls()).toEqual([]);
    expect(h.replies()).toEqual([]);
  });

  it("answers 401 for a token with the wrong audience and makes no control-plane call", async () => {
    const h = harness({ "GET *": boundChannel });
    const response = await h.post(
      activityFixture(),
      mintToken(key, { aud: "11111111-1111-1111-1111-111111111111" })
    );
    expect(response.status).toBe(401);
    expect(h.controlPlaneCalls()).toEqual([]);
    expect(h.replies()).toEqual([]);
  });

  it("rejects a token whose serviceurl claim differs from the activity's", async () => {
    const h = harness({});
    const response = await h.post(
      activityFixture({ serviceUrl: "https://europe.botframework.com/" }),
      mintToken(key, { serviceurl: SERVICE_URL })
    );
    expect(response.status).toBe(401);
    expect(h.replies()).toEqual([]);
  });

  it("answers 400 for a body that is not an activity and 413 for an oversized one", async () => {
    const h = harness({});
    const bad = await h.app.request("/api/messages", { method: "POST", body: "[]" });
    expect(bad.status).toBe(400);
    const big = await h.app.request("/api/messages", {
      method: "POST",
      headers: { "content-length": String(300 * 1024) },
      body: "{}",
    });
    expect(big.status).toBe(413);
    const oversized = await h.app.request("/api/messages", {
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(260 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("serves the health probe", async () => {
    const h = harness({});
    const response = await h.app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "open-inspect-teams-bot" });
  });

  it("drops an activity from another tenant after acknowledging it", async () => {
    const h = harness({ "GET *": boundChannel });
    const response = await h.post(
      activityFixture({
        channelData: { channel: { id: CHANNEL_ID }, tenant: { id: OTHER_TENANT_ID } },
        conversation: { id: THREAD_KEY, conversationType: "channel", tenantId: OTHER_TENANT_ID },
      })
    );
    expect(response.status).toBe(200);
    expect(h.controlPlaneCalls()).toEqual([]);
    expect(h.replies()).toEqual([]);
  });

  it("rejects a forged serviceUrl before any outbound call", async () => {
    const h = harness({ "GET *": boundChannel });
    const forged = activityFixture({ serviceUrl: "https://attacker.example/" });
    const response = await h.post(
      forged,
      mintToken(key, { serviceurl: "https://attacker.example/" })
    );
    expect(response.status).toBe(200);
    expect(h.controlPlaneCalls()).toEqual([]);
    expect(h.connectorRemote.requests).toEqual([]);
  });

  it("replies that an unbound channel is not bound, with no further control-plane call", async () => {
    const h = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: () =>
        json({ error: "Channel is not bound", code: "channel_unbound" }, 404),
    });
    await h.post(activityFixture());
    expect(h.controlPlaneCalls()).toEqual([
      `GET /channel-bindings/msteams/${encodeURIComponent(CHANNEL_ID)}`,
    ]);
    expect(h.replies()).toEqual([
      {
        method: "POST",
        path: `/emea/v3/conversations/${encodeURIComponent(THREAD_KEY)}/activities/${ROOT_ID}`,
        text: UNBOUND_CHANNEL_MESSAGE,
        replyToId: ROOT_ID,
      },
    ]);
    expect(h.store.getThreadSession(THREAD_KEY)).toBeNull();
  });

  it("says so when the binding lookup is unavailable", async () => {
    const h = harness({ "GET *": () => json({ error: "down" }, 503) });
    await h.post(activityFixture());
    expect(h.replies().map((reply) => reply.text)).toEqual([BINDING_UNAVAILABLE_MESSAGE]);
  });

  it("asks an unenrolled user to sign in and creates no session", async () => {
    const h = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "POST /sessions": () => json({ error: "Forbidden", code: "service_actor_not_enrolled" }, 403),
    });
    await h.post(activityFixture());
    expect(h.controlPlaneCalls()).toEqual([
      `GET /channel-bindings/msteams/${encodeURIComponent(CHANNEL_ID)}`,
      "POST /sessions",
    ]);
    expect(h.replies().map((reply) => reply.text)).toEqual([signInMessage(WEB_APP_URL)]);
    expect(h.store.getThreadSession(THREAD_KEY)).toBeNull();
  });

  it("creates a session and sends the prompt with the right body and actor header", async () => {
    const h = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "POST /sessions": sessionCreated,
      "POST /sessions/session-1/prompt": promptQueued,
    });
    const response = await h.post(activityFixture());
    expect(response.status).toBe(200);
    expect(h.controlPlaneCalls()).toEqual([
      `GET /channel-bindings/msteams/${encodeURIComponent(CHANNEL_ID)}`,
      "POST /sessions",
      "POST /sessions/session-1/prompt",
    ]);
    const [binding, create, prompt] = h.controlPlaneRemote.requests;
    expect(binding.headers[ACTOR_HEADER.toLowerCase()]).toBeUndefined();
    expect(create.headers[ACTOR_HEADER.toLowerCase()]).toBe(`microsoft:${USER_OID}`);
    expect(create.body).toEqual({
      teamId: "team-platform",
      repoOwner: "ProvidenceIT",
      repoName: "playground",
      model: DEFAULT_MODEL,
      actorDisplayName: "Casey",
    });
    expect(prompt.headers[ACTOR_HEADER.toLowerCase()]).toBe(`microsoft:${USER_OID}`);
    expect(prompt.body).toEqual({
      content: "add a README badge",
      source: "msteams",
      callbackContext: {
        source: "msteams",
        conversationId: THREAD_KEY,
        serviceUrl: SERVICE_URL,
        replyToId: ROOT_ID,
        channelId: CHANNEL_ID,
        repoFullName: "ProvidenceIT/playground",
        model: DEFAULT_MODEL,
      },
    });
    expect(h.replies()).toEqual([
      {
        method: "POST",
        path: `/emea/v3/conversations/${encodeURIComponent(THREAD_KEY)}/activities/${ROOT_ID}`,
        text: WORKING_TEXT,
        replyToId: ROOT_ID,
      },
    ]);
    expect(h.store.getThreadSession(THREAD_KEY)).toMatchObject({
      sessionId: "session-1",
      teamId: "team-platform",
      repoFullName: "ProvidenceIT/playground",
      model: DEFAULT_MODEL,
      channelId: CHANNEL_ID,
      rootActivityId: ROOT_ID,
      progressActivityId: "reply-1",
      lastMessageId: "message-1",
      turnState: "working",
      closed: false,
    });
    expect(h.store.getConversationReference(THREAD_KEY)).toMatchObject({
      conversationId: THREAD_KEY,
      serviceUrl: SERVICE_URL,
      activityId: ROOT_ID,
    });
  });

  it("uses the team's single repository for a bare prompt and asks when there are several", async () => {
    const one = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "GET /repos": () =>
        json({
          repos: [
            {
              id: 7,
              owner: "ProvidenceIT",
              name: "only",
              fullName: "ProvidenceIT/only",
              description: null,
              private: true,
              defaultBranch: "main",
              archived: false,
            },
          ],
          cached: false,
          cachedAt: "2026-10-08T00:00:00.000Z",
        }),
      "POST /sessions": sessionCreated,
      "POST /sessions/session-1/prompt": promptQueued,
    });
    await one.post(activityFixture({ text: "<at>Open-Inspect</at> add a README badge" }));
    expect(one.controlPlaneCalls()).toEqual([
      `GET /channel-bindings/msteams/${encodeURIComponent(CHANNEL_ID)}`,
      `GET /repos?channel=${encodeURIComponent(`msteams:${CHANNEL_ID}`)}`,
      "POST /sessions",
      "POST /sessions/session-1/prompt",
    ]);
    expect(one.controlPlaneRemote.requests[1].headers[ACTOR_HEADER.toLowerCase()]).toBe(
      `microsoft:${USER_OID}`
    );
    expect(one.controlPlaneRemote.requests[2].body).toMatchObject({
      repoOwner: "ProvidenceIT",
      repoName: "only",
    });

    const many = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "GET /repos": () =>
        json({
          repos: [
            {
              id: 1,
              owner: "ProvidenceIT",
              name: "a",
              fullName: "ProvidenceIT/a",
              description: null,
              private: true,
              defaultBranch: "main",
              archived: false,
            },
            {
              id: 2,
              owner: "ProvidenceIT",
              name: "b",
              fullName: "ProvidenceIT/b",
              description: null,
              private: true,
              defaultBranch: "main",
              archived: false,
            },
          ],
          cached: false,
          cachedAt: "2026-10-08T00:00:00.000Z",
        }),
    });
    await many.post(activityFixture({ text: "<at>Open-Inspect</at> add a README badge" }));
    expect(many.controlPlaneCalls()).toEqual([
      `GET /channel-bindings/msteams/${encodeURIComponent(CHANNEL_ID)}`,
      `GET /repos?channel=${encodeURIComponent(`msteams:${CHANNEL_ID}`)}`,
    ]);
    expect(many.replies()[0].text).toBe(
      "Name a repository: `@bot owner/repo <prompt>`. This team can use:\n- `ProvidenceIT/a`\n- `ProvidenceIT/b`"
    );
  });

  it("renders quota and team denials from the control plane's message", async () => {
    const quota = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "POST /sessions": sessionCreated,
      "POST /sessions/session-1/prompt": () =>
        json(
          {
            error: "Daily turn quota reached (1/1).",
            code: "USAGE_QUOTA_EXCEEDED",
            scopeKind: "user",
            period: "day",
            exceeded: [],
          },
          429
        ),
    });
    await quota.post(activityFixture());
    expect(quota.replies().map((reply) => reply.text)).toEqual(["Daily turn quota reached (1/1)."]);
    expect(quota.store.getThreadSession(THREAD_KEY)).toBeNull();

    const denied = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "POST /sessions": () =>
        json({ error: "you are not a member of this channel's team", code: "not_member" }, 403),
    });
    await denied.post(activityFixture());
    expect(denied.replies().map((reply) => reply.text)).toEqual([
      "you are not a member of this channel's team",
    ]);
  });

  it("applies inline model flags and rejects unknown ones", async () => {
    const h = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "POST /sessions": sessionCreated,
      "POST /sessions/session-1/prompt": promptQueued,
    });
    await h.post(
      activityFixture({
        text: "<at>Open-Inspect</at> !model not-a-model ProvidenceIT/playground do it",
      })
    );
    expect(h.replies().map((reply) => reply.text)).toEqual(['Unknown model "not-a-model".']);
    expect(h.controlPlaneCalls()).toEqual([
      `GET /channel-bindings/msteams/${encodeURIComponent(CHANNEL_ID)}`,
    ]);
  });

  it("turns a reply inside a session's thread into a follow-up prompt", async () => {
    const h = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "POST /sessions": sessionCreated,
      "POST /sessions/session-1/prompt": promptQueued,
    });
    await h.post(activityFixture());
    h.controlPlaneRemote.requests.length = 0;
    h.connectorRemote.requests.length = 0;

    const reply = activityFixture({
      id: "1759900000002",
      replyToId: ROOT_ID,
      conversation: { id: THREAD_KEY, conversationType: "channel", tenantId: TENANT_ID },
      text: "<at>Open-Inspect</at> also update the docs",
      entities: [
        { type: "mention", text: "<at>Open-Inspect</at>", mentioned: { id: `28:${APP_ID}` } },
        {
          type: "quotedreply",
          quotedReply: {
            messageId: ROOT_ID,
            preview: "add a README badge",
            senderName: "Casey",
            time: "1759900000000",
          },
        },
      ],
    });
    await h.post(reply);
    expect(h.controlPlaneCalls()).toEqual(["POST /sessions/session-1/prompt"]);
    expect(h.controlPlaneRemote.requests[0].body).toEqual({
      content:
        "## Teams Thread Context\n\nThe user quoted these earlier messages:\n\n- Casey: add a README badge\n\nalso update the docs",
      source: "msteams",
      callbackContext: {
        source: "msteams",
        conversationId: THREAD_KEY,
        serviceUrl: SERVICE_URL,
        replyToId: ROOT_ID,
        channelId: CHANNEL_ID,
        repoFullName: "ProvidenceIT/playground",
        model: DEFAULT_MODEL,
      },
    });
    expect(h.replies()).toEqual([
      {
        method: "POST",
        path: `/emea/v3/conversations/${encodeURIComponent(THREAD_KEY)}/activities/${ROOT_ID}`,
        text: WORKING_TEXT,
        replyToId: ROOT_ID,
      },
    ]);
    expect(h.store.getThreadSession(THREAD_KEY)).toMatchObject({
      sessionId: "session-1",
      lastMessageId: "message-1",
      progressActivityId: "reply-2",
    });
  });

  it("closes the thread when the session is gone and refuses later follow-ups", async () => {
    const h = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "POST /sessions": sessionCreated,
      "POST /sessions/session-1/prompt": () => json({ error: "Session not found" }, 404),
    });
    h.store.putThreadSession({
      threadKey: THREAD_KEY,
      sessionId: "session-1",
      actor: `microsoft:${USER_OID}`,
      teamId: "team-platform",
      repoFullName: "ProvidenceIT/playground",
      model: DEFAULT_MODEL,
      reasoningEffort: null,
      serviceUrl: SERVICE_URL,
      channelId: CHANNEL_ID,
      rootActivityId: ROOT_ID,
    });
    const followUp = activityFixture({
      id: "2",
      replyToId: ROOT_ID,
      text: "<at>Open-Inspect</at> more",
    });
    await h.post(followUp);
    expect(h.replies().map((reply) => reply.text)).toEqual([THREAD_CLOSED_MESSAGE]);
    expect(h.store.getThreadSession(THREAD_KEY)?.closed).toBe(true);
    await h.post(
      activityFixture({ id: "3", replyToId: ROOT_ID, text: "<at>Open-Inspect</at> again" })
    );
    expect(h.controlPlaneCalls()).toEqual(["POST /sessions/session-1/prompt"]);
    expect(h.replies().map((reply) => reply.text)).toEqual([
      THREAD_CLOSED_MESSAGE,
      THREAD_CLOSED_MESSAGE,
    ]);
  });

  it("stops the running turn from the thread and confirms", async () => {
    const h = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "POST /sessions": sessionCreated,
      "POST /sessions/session-1/prompt": promptQueued,
      "POST /sessions/session-1/stop": () => json({ ok: true }),
    });
    await h.post(activityFixture());
    await h.post(
      activityFixture({ id: "2", replyToId: ROOT_ID, text: "<at>Open-Inspect</at> stop" })
    );
    expect(h.controlPlaneCalls().at(-1)).toBe("POST /sessions/session-1/stop");
    expect(h.controlPlaneRemote.requests.at(-1)?.headers[ACTOR_HEADER.toLowerCase()]).toBe(
      `microsoft:${USER_OID}`
    );
    expect(h.replies().map((reply) => reply.text)).toEqual([WORKING_TEXT, STOP_REQUESTED_MESSAGE]);
    expect(h.store.getThreadSession(THREAD_KEY)?.turnState).toBe("idle");
  });

  it("reports status with the web link and the live turn state", async () => {
    const h = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "POST /sessions": sessionCreated,
      "POST /sessions/session-1/prompt": promptQueued,
      "GET /sessions/session-1/messages": () => json({ messages: [], hasMore: false }),
    });
    await h.post(activityFixture());
    await h.post(
      activityFixture({ id: "2", replyToId: ROOT_ID, text: "<at>Open-Inspect</at> status" })
    );
    expect(h.controlPlaneCalls().at(-1)).toBe(
      "GET /sessions/session-1/messages?status=processing&limit=1"
    );
    const status = h.replies().at(-1)?.text ?? "";
    expect(status).toContain(`**Session** ${WEB_APP_URL}/session/session-1`);
    expect(status).toContain("- Repository: ProvidenceIT/playground");
    expect(status).toContain(`- Model: ${DEFAULT_MODEL}`);
    expect(status).toContain("- State: idle");
  });

  it("answers status and stop outside a session thread without calling the control plane", async () => {
    const h = harness({});
    await h.post(activityFixture({ text: "<at>Open-Inspect</at> status" }));
    await h.post(activityFixture({ id: "2", text: "<at>Open-Inspect</at> stop" }));
    await h.post(activityFixture({ id: "3", text: "<at>Open-Inspect</at> help" }));
    expect(h.controlPlaneCalls()).toEqual([]);
    expect(h.replies().map((reply) => reply.text)).toEqual([
      NO_SESSION_IN_THREAD_MESSAGE,
      NO_SESSION_IN_THREAD_MESSAGE,
      HELP_TEXT,
    ]);
  });

  it("refuses to start a session from a chat without a channel", async () => {
    const h = harness({ "GET *": boundChannel });
    await h.post(
      activityFixture({
        channelData: { tenant: { id: TENANT_ID } },
        conversation: { id: "a:1chat", conversationType: "personal", tenantId: TENANT_ID },
      })
    );
    expect(h.controlPlaneCalls()).toEqual([]);
    expect(h.replies().map((reply) => reply.text)).toEqual([NOT_A_CHANNEL_MESSAGE]);
  });

  it("ignores a redelivered activity and the bot's own messages", async () => {
    const h = harness({
      [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: boundChannel,
      "POST /sessions": sessionCreated,
      "POST /sessions/session-1/prompt": promptQueued,
    });
    await h.post(activityFixture());
    await h.post(activityFixture());
    await h.post(
      activityFixture({
        id: "9",
        from: { id: `28:${APP_ID}`, name: "Open-Inspect", aadObjectId: USER_OID },
      })
    );
    expect(h.controlPlaneCalls()).toHaveLength(3);
    expect(h.replies()).toHaveLength(1);
  });

  it("tells a sender without a directory id that it cannot act for them", async () => {
    const h = harness({ "GET *": boundChannel });
    await h.post(activityFixture({ from: { id: "29:anon", name: "Anon" } }));
    expect(h.controlPlaneCalls()).toEqual([]);
    expect(h.replies()).toHaveLength(1);
    expect(h.replies()[0].text).toContain("I can't tell who you are");
  });
});

describe("createKeyedQueue", () => {
  it("serialises tasks per key and runs different keys concurrently", async () => {
    const enqueue = createKeyedQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = enqueue("a", async () => {
      await gate;
      order.push("a1");
    });
    const second = enqueue("a", async () => {
      order.push("a2");
    });
    const other = enqueue("b", async () => {
      order.push("b1");
    });
    await other;
    expect(order).toEqual(["b1"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["b1", "a1", "a2"]);
    await expect(
      enqueue("a", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(enqueue("a", async () => "after failure")).resolves.toBe("after failure");
  });
});
