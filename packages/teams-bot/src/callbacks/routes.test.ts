/**
 * The callback routes end to end: a session is started through
 * POST /api/messages exactly as in production, then the control plane's
 * callbacks arrive signed, and every assertion is on the connector requests
 * the bot made (or did not make).
 */

import { computeHmacHex } from "@open-inspect/shared/auth";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import { ACTOR_HEADER } from "@open-inspect/shared/service-auth";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createInboundAuthenticator } from "../bot-framework/auth";
import { createBotFrameworkClient } from "../bot-framework/client";
import { parseAllowedServiceUrlHosts } from "../bot-framework/service-url";
import { ControlPlaneClient } from "../control-plane/client";
import { createLogger } from "../logger";
import { createActivityHandler, createKeyedQueue } from "../sessions/handler";
import { AGENT_COMPLETED_MESSAGE, THREAD_CLOSED_MESSAGE } from "../sessions/messages";
import { createProgressRenderer } from "../sessions/progress";
import { TeamsStateStore } from "../state/store";
import { WORKING_TEXT } from "../teams/reply-sink";
import {
  activityFixture,
  APP_ID,
  CHANNEL_ID,
  json,
  makeSigningKey,
  mintToken,
  resolverFor,
  scriptedFetch,
  SERVICE_URL,
  TENANT_ID,
  USER_OID,
  type RecordedRequest,
  type RouteHandler,
} from "../test-support";
import { MSTEAMS_THREAD_CLOSED_KIND } from "./schemas";
import { createCallbacksRouter } from "./routes";

const WEB_APP_URL = "https://agent-dokman.tailbd0db8.ts.net:10443";
const CONTROL_PLANE_URL = "http://10.43.250.21:8787";
const SECRET = "placeholder-service-secret";
const key = makeSigningKey();
const silent = createLogger("test", {}, "error");
const ROOT_ID = "1759900000001";
const THREAD_KEY = `${CHANNEL_ID};messageid=${ROOT_ID}`;
const THREAD_ACTIVITIES = `/emea/v3/conversations/${encodeURIComponent(THREAD_KEY)}/activities`;
const SESSION_LINK = `[Open the session](${WEB_APP_URL}/session/session-1)`;
const PR_URL = "https://github.com/ProvidenceIT/playground/pull/12";

const context = {
  source: "msteams",
  conversationId: THREAD_KEY,
  serviceUrl: SERVICE_URL,
  replyToId: ROOT_ID,
  channelId: CHANNEL_ID,
  repoFullName: "ProvidenceIT/playground",
  model: DEFAULT_MODEL,
};

const events = [
  {
    id: "e1",
    type: "tool_call",
    data: { tool: "Bash", args: { command: "npm test" }, callId: "c1" },
    messageId: "message-1",
    createdAt: 1_000,
  },
  {
    id: "e2",
    type: "token",
    data: { content: "I added the badge." },
    messageId: "message-1",
    createdAt: 2_000,
  },
  {
    id: "e3",
    type: "execution_complete",
    data: { success: true },
    messageId: "message-1",
    createdAt: 3_000,
  },
];

const FINAL_TEXT = [
  "I added the badge.",
  `**Created:**\n- [PR #12](${PR_URL})`,
  `Done | ${DEFAULT_MODEL} | ProvidenceIT/playground\n\n${SESSION_LINK}`,
].join("\n\n");

const controlPlaneDefaults: Record<string, RouteHandler> = {
  [`GET /channel-bindings/msteams/${CHANNEL_ID}`]: () =>
    json({ teamId: "team-platform", kind: "primary" }),
  "POST /sessions": () => json({ sessionId: "session-1", status: "created" }),
  "POST /sessions/session-1/prompt": () => json({ messageId: "message-1", status: "queued" }),
  "GET /sessions/session-1/events": () => json({ events, hasMore: false }),
  "GET /sessions/session-1/artifacts": () =>
    json({
      artifacts: [
        { id: "a1", type: "pr", url: PR_URL, metadata: { number: 12 }, createdAt: 2_500 },
      ],
    }),
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface ConnectorCall {
  method: string;
  path: string;
  text: string | undefined;
  replyToId: string | undefined;
  from: unknown;
}

function harness(options: {
  store?: TeamsStateStore;
  controlPlane?: Record<string, RouteHandler>;
  connector?: Record<string, RouteHandler>;
  now?: () => number;
}) {
  const controlPlaneRemote = scriptedFetch({ ...controlPlaneDefaults, ...options.controlPlane });
  let replyCounter = 0;
  const connectorRemote = scriptedFetch({
    "POST *": () => json({ id: `reply-${++replyCounter}` }),
    "PUT *": () => json({ id: "updated" }),
    ...options.connector,
  });
  const store = options.store ?? TeamsStateStore.inMemory();
  const hosts = parseAllowedServiceUrlHosts("*.botframework.com,smba.trafficmanager.net");
  const controlPlane = new ControlPlaneClient({
    baseUrl: CONTROL_PLANE_URL,
    secret: SECRET,
    fetch: controlPlaneRemote.fetch,
  });
  const bot = createBotFrameworkClient({
    tokens: { getToken: async () => "placeholder-token" },
    allowedServiceUrlHosts: hosts,
    fetch: connectorRemote.fetch,
  });
  const enqueue = createKeyedQueue();
  const handleActivity = createActivityHandler({
    tenantId: TENANT_ID,
    allowedServiceUrlHosts: hosts,
    webAppUrl: WEB_APP_URL,
    controlPlane,
    bot,
    store,
    log: silent,
    enqueue,
  });
  const callbacks = createCallbacksRouter({
    secret: SECRET,
    store,
    bot,
    controlPlane,
    progress: createProgressRenderer(silent),
    webAppUrl: WEB_APP_URL,
    enqueue,
    log: silent,
    now: options.now,
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
    callbacks,
  });

  /** Deliver one activity as the connector would and wait for the handler. */
  async function post(activity = activityFixture()): Promise<void> {
    const response = await app.request("/api/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mintToken(key, {})}`,
      },
      body: JSON.stringify(activity),
    });
    expect(response.status).toBe(200);
    await Promise.all(background.splice(0));
  }

  /** Mention the bot in the channel so a session starts and "Working..." is posted. */
  const start = () => post();

  /** Post a callback signed as the control plane signs it, unless `signature` overrides it. */
  async function callback(
    path: string,
    unsigned: Record<string, unknown>,
    signature?: string
  ): Promise<Response> {
    const body = JSON.stringify({
      ...unsigned,
      signature: signature ?? (await computeHmacHex(JSON.stringify(unsigned), SECRET)),
    });
    return app.request(`/callbacks/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace-id": "trace-test" },
      body,
    });
  }

  const connectorCalls = (): ConnectorCall[] =>
    connectorRemote.requests.map((request: RecordedRequest) => {
      const body = request.body as Record<string, unknown>;
      return {
        method: request.method,
        path: new URL(request.url).pathname,
        text: body.text as string | undefined,
        replyToId: body.replyToId as string | undefined,
        from: body.from,
      };
    });
  const controlPlaneCalls = () =>
    controlPlaneRemote.requests.map(
      (request) => `${request.method} ${new URL(request.url).pathname}`
    );

  return {
    app,
    store,
    start,
    post,
    callback,
    connectorCalls,
    controlPlaneCalls,
    controlPlaneRemote,
    connectorRemote,
  };
}

function completePayload(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    messageId: "message-1",
    success: true,
    timestamp: Date.now(),
    context,
    ...overrides,
  };
}

function toolCallPayload(callId: string, command: string) {
  return {
    sessionId: "session-1",
    tool: "Bash",
    args: { command },
    callId,
    status: "running",
    timestamp: Date.now(),
    context,
  };
}

const WORKING_REPLY: ConnectorCall = {
  method: "POST",
  path: `${THREAD_ACTIVITIES}/${ROOT_ID}`,
  text: WORKING_TEXT,
  replyToId: ROOT_ID,
  from: { id: `28:${APP_ID}`, name: "Open-Inspect" },
};

describe("POST /callbacks/complete", () => {
  it("answers 401 for a bad signature and posts nothing", async () => {
    const h = harness({});
    await h.start();
    const controlPlaneBefore = h.controlPlaneCalls().length;
    const response = await h.callback("complete", completePayload(), "0".repeat(64));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(h.connectorCalls()).toEqual([WORKING_REPLY]);
    expect(h.controlPlaneCalls()).toHaveLength(controlPlaneBefore);
    expect(h.store.getThreadSession(THREAD_KEY)?.turnState).toBe("working");
  });

  it("answers 401 for a stale timestamp and 400 for a signed body of the wrong shape", async () => {
    const h = harness({});
    await h.start();
    const stale = await h.callback(
      "complete",
      completePayload({ timestamp: Date.now() - 6 * 60 * 1000 })
    );
    expect(stale.status).toBe(401);
    const { messageId: _messageId, ...withoutMessage } = completePayload();
    const malformed = await h.callback("complete", withoutMessage);
    expect(malformed.status).toBe(400);
    const unsigned = await h.app.request("/callbacks/complete", {
      method: "POST",
      body: JSON.stringify(completePayload()),
    });
    expect(unsigned.status).toBe(400);
    expect(h.connectorCalls()).toEqual([WORKING_REPLY]);
  });

  it("replaces Working... with exactly one final message, and a retried duplicate posts nothing", async () => {
    const h = harness({});
    await h.start();
    const response = await h.callback("complete", completePayload());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: "delivered" });

    expect(h.connectorCalls()).toEqual([
      WORKING_REPLY,
      {
        method: "PUT",
        path: `${THREAD_ACTIVITIES}/reply-1`,
        text: FINAL_TEXT,
        replyToId: undefined,
        from: { id: `28:${APP_ID}`, name: "Open-Inspect" },
      },
    ]);
    const reads = h.controlPlaneRemote.requests.filter((request) => request.method === "GET");
    expect(reads.map((request) => new URL(request.url).pathname)).toEqual([
      `/channel-bindings/msteams/${encodeURIComponent(CHANNEL_ID)}`,
      "/sessions/session-1/events",
      "/sessions/session-1/artifacts",
    ]);
    expect(reads[1].headers[ACTOR_HEADER.toLowerCase()]).toBe(`microsoft:${USER_OID}`);
    expect(new URL(reads[1].url).searchParams.get("message_id")).toBe("message-1");
    expect(h.store.getThreadSession(THREAD_KEY)).toMatchObject({
      turnState: "idle",
      progressActivityId: null,
      closed: false,
    });

    const retry = await h.callback("complete", completePayload());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(h.connectorCalls()).toHaveLength(2);
  });

  it("gives the claim back when the connector refuses, so the retry delivers once", async () => {
    let refuse = false;
    const h = harness({
      connector: {
        "PUT *": () => (refuse ? json({ error: "down" }, 502) : json({ id: "updated" })),
        "POST *": () => (refuse ? json({ error: "down" }, 502) : json({ id: "reply-1" })),
      },
    });
    await h.start();
    refuse = true;
    const failed = await h.callback("complete", completePayload());
    expect(failed.status).toBe(503);
    refuse = false;
    const retried = await h.callback("complete", completePayload());
    expect(await retried.json()).toEqual({ ok: true, outcome: "delivered" });
    const finals = h.connectorCalls().filter((call) => call.text === FINAL_TEXT);
    expect(finals.map((call) => call.method)).toEqual(["PUT", "POST", "PUT"]);
    expect(h.connectorCalls().filter((call) => call.method === "PUT")).toHaveLength(2);
  });

  it("delivers a retry whose earlier claim was left unfinished by a crashed delivery", async () => {
    const h = harness({});
    await h.start();
    // What a process that died between claiming and posting leaves behind.
    expect(h.store.claimCallback("message-1", "complete")).toBe(true);
    const blocked = await h.callback("complete", completePayload());
    expect(await blocked.json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(h.connectorCalls()).toEqual([WORKING_REPLY]);

    // A restart releases unfinished claims; the control plane's redelivery then posts once.
    expect(h.store.releaseUnpostedCallbacks()).toBe(1);
    const retried = await h.callback("complete", completePayload());
    expect(await retried.json()).toEqual({ ok: true, outcome: "delivered" });
    expect(h.connectorCalls().filter((call) => call.text === FINAL_TEXT)).toHaveLength(1);
    const again = await h.callback("complete", completePayload());
    expect(await again.json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(h.store.releaseUnpostedCallbacks()).toBe(0);
    expect(h.connectorCalls().filter((call) => call.text === FINAL_TEXT)).toHaveLength(1);
  });

  it("still posts into the thread when the control plane's reads fail", async () => {
    const h = harness({
      controlPlane: {
        "GET /sessions/session-1/events": () =>
          json({ error: "Forbidden", code: "principal_type_required" }, 403),
      },
    });
    await h.start();
    const response = await h.callback("complete", completePayload({ success: true }));
    expect(await response.json()).toEqual({ ok: true, outcome: "delivered" });
    expect(h.connectorCalls().at(-1)).toMatchObject({
      method: "PUT",
      path: `${THREAD_ACTIVITIES}/reply-1`,
      text: `${AGENT_COMPLETED_MESSAGE}\n\nDone | ${DEFAULT_MODEL} | ProvidenceIT/playground\n\n${SESSION_LINK}`,
    });
  });

  it("posts a fresh reply from the callback's coordinates when the thread is unknown", async () => {
    const h = harness({});
    const other = { ...context, conversationId: `${CHANNEL_ID};messageid=42`, replyToId: "42" };
    const response = await h.callback(
      "complete",
      completePayload({ sessionId: "session-9", messageId: "message-9", context: other })
    );
    expect(await response.json()).toEqual({ ok: true, outcome: "delivered" });
    expect(h.controlPlaneCalls()).toEqual([]);
    expect(h.connectorCalls()).toEqual([
      {
        method: "POST",
        path: `/emea/v3/conversations/${encodeURIComponent(other.conversationId)}/activities/42`,
        text: `${AGENT_COMPLETED_MESSAGE}\n\nDone | ${DEFAULT_MODEL} | ProvidenceIT/playground\n\n[Open the session](${WEB_APP_URL}/session/session-9)`,
        replyToId: "42",
        from: undefined,
      },
    ]);
  });

  it("posts the final answer after a restart from the stored conversation reference", async () => {
    const dir = mkdtempSync(join(tmpdir(), "teams-bot-callbacks-"));
    try {
      const before = TeamsStateStore.open(dir);
      const first = harness({ store: before });
      await first.start();
      expect(first.connectorCalls()).toEqual([WORKING_REPLY]);
      before.close();

      const after = TeamsStateStore.open(dir);
      const second = harness({ store: after });
      const response = await second.callback("complete", completePayload());
      expect(await response.json()).toEqual({ ok: true, outcome: "delivered" });
      expect(second.connectorCalls()).toEqual([
        {
          method: "PUT",
          path: `${THREAD_ACTIVITIES}/reply-1`,
          text: FINAL_TEXT,
          replyToId: undefined,
          from: { id: `28:${APP_ID}`, name: "Open-Inspect" },
        },
      ]);
      expect(second.connectorRemote.requests[0].body).toMatchObject({
        recipient: { id: "29:1user", name: "Casey" },
      });
      const duplicate = await second.callback("complete", completePayload());
      expect(await duplicate.json()).toEqual({ ok: true, outcome: "duplicate" });
      expect(second.connectorCalls()).toHaveLength(1);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /callbacks/tool_call", () => {
  it("conflates a burst of tool calls into updates of the Working... reply, then the final replaces it", async () => {
    const gate = deferred();
    let held = false;
    const h = harness({
      connector: {
        "PUT *": async () => {
          if (!held) {
            held = true;
            await gate.promise;
          }
          return json({ id: "updated" });
        },
      },
    });
    await h.start();

    const first = await h.callback("tool_call", toolCallPayload("c1", "npm test"));
    expect(await first.json()).toEqual({ ok: true, outcome: "accepted" });
    await waitFor(() => h.connectorCalls().length === 2, "first progress edit");
    for (const [callId, command] of [
      ["c2", "npm run lint"],
      ["c3", "npm run typecheck"],
      ["c4", "git status"],
    ]) {
      expect((await h.callback("tool_call", toolCallPayload(callId, command))).status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.connectorCalls()).toHaveLength(2);
    gate.resolve();
    await waitFor(() => h.connectorCalls().length === 3, "conflated progress edit");

    const complete = await h.callback("complete", completePayload());
    expect(await complete.json()).toEqual({ ok: true, outcome: "delivered" });
    expect(h.connectorCalls().map((call) => [call.method, call.text])).toEqual([
      ["POST", WORKING_TEXT],
      ["PUT", `${WORKING_TEXT}\n\n- Ran: npm test`],
      [
        "PUT",
        `${WORKING_TEXT}\n\n- Ran: npm test\n- Ran: npm run lint\n- Ran: npm run typecheck\n- Ran: git status`,
      ],
      ["PUT", FINAL_TEXT],
    ]);
    expect(
      h
        .connectorCalls()
        .slice(1)
        .every((call) => call.path.endsWith("/reply-1"))
    ).toBe(true);

    const late = await h.callback("tool_call", toolCallPayload("c5", "echo late"));
    expect(late.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.connectorCalls()).toHaveLength(4);
  });

  it("keeps a superseded turn's progress and answer off the follow-up's placeholder", async () => {
    let prompts = 0;
    const turnEvents = (messageId: string, answer: string) => [
      { id: `${messageId}-t`, type: "token", data: { content: answer }, messageId, createdAt: 1 },
      {
        id: `${messageId}-c`,
        type: "execution_complete",
        data: { success: true },
        messageId,
        createdAt: 2,
      },
    ];
    const h = harness({
      controlPlane: {
        "POST /sessions/session-1/prompt": () =>
          json({ messageId: `message-${++prompts}`, status: "queued" }),
        "GET /sessions/session-1/events": (request) => {
          const messageId = new URL(request.url).searchParams.get("message_id") ?? "";
          const answer = messageId === "message-1" ? "First answer." : "Second answer.";
          return json({ events: turnEvents(messageId, answer), hasMore: false });
        },
        "GET /sessions/session-1/artifacts": () => json({ artifacts: [] }),
      },
    });
    await h.start();
    const first = await h.callback("tool_call", {
      ...toolCallPayload("c1", "npm test"),
      messageId: "message-1",
    });
    expect(first.status).toBe(200);
    await waitFor(() => h.connectorCalls().length === 2, "turn 1 progress edit");

    // A follow-up while turn 1 is still running: message-2 owns reply-2.
    await h.post(
      activityFixture({
        id: "1759900000002",
        replyToId: ROOT_ID,
        conversation: { id: THREAD_KEY, conversationType: "channel", tenantId: TENANT_ID },
        text: "<at>Open-Inspect</at> also add tests",
      })
    );
    expect(h.store.getThreadSession(THREAD_KEY)).toMatchObject({
      lastMessageId: "message-2",
      progressActivityId: "reply-2",
      turnState: "working",
    });
    expect(h.connectorCalls()).toHaveLength(3);

    // A late tool call for turn 1 is not drawn under reply-2.
    await h.callback("tool_call", {
      ...toolCallPayload("c2", "git status"),
      messageId: "message-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.connectorCalls()).toHaveLength(3);

    // Turn 1 completes: its answer lands in its own reply-1; reply-2 stays "Working...".
    const complete1 = await h.callback("complete", completePayload({ messageId: "message-1" }));
    expect(await complete1.json()).toEqual({ ok: true, outcome: "delivered" });
    expect(h.connectorCalls().at(-1)).toMatchObject({
      method: "PUT",
      path: `${THREAD_ACTIVITIES}/reply-1`,
    });
    expect(h.connectorCalls().at(-1)?.text).toContain("First answer.");
    expect(h.store.getThreadSession(THREAD_KEY)).toMatchObject({
      lastMessageId: "message-2",
      progressActivityId: "reply-2",
      turnState: "working",
    });

    // Turn 2's progress and answer go to reply-2.
    await h.callback("tool_call", {
      ...toolCallPayload("c3", "npm run lint"),
      messageId: "message-2",
    });
    await waitFor(() => h.connectorCalls().length === 5, "turn 2 progress edit");
    expect(h.connectorCalls().at(-1)).toMatchObject({
      method: "PUT",
      path: `${THREAD_ACTIVITIES}/reply-2`,
      text: `${WORKING_TEXT}\n\n- Ran: npm run lint`,
    });
    const complete2 = await h.callback("complete", completePayload({ messageId: "message-2" }));
    expect(await complete2.json()).toEqual({ ok: true, outcome: "delivered" });
    expect(h.connectorCalls().at(-1)).toMatchObject({
      method: "PUT",
      path: `${THREAD_ACTIVITIES}/reply-2`,
    });
    expect(h.connectorCalls().at(-1)?.text).toContain("Second answer.");
    expect(h.connectorCalls().map((call) => [call.method, call.path.split("/").at(-1)])).toEqual([
      ["POST", ROOT_ID],
      ["PUT", "reply-1"],
      ["POST", ROOT_ID],
      ["PUT", "reply-1"],
      ["PUT", "reply-2"],
      ["PUT", "reply-2"],
    ]);
    expect(h.store.getThreadSession(THREAD_KEY)).toMatchObject({
      turnState: "idle",
      progressActivityId: null,
    });
  });

  it("rejects an unsigned or foreign tool call before touching the thread", async () => {
    const h = harness({});
    await h.start();
    const bad = await h.callback("tool_call", toolCallPayload("c1", "rm -rf /"), "f".repeat(64));
    expect(bad.status).toBe(401);
    const unknown = await h.callback("tool_call", {
      ...toolCallPayload("c1", "ls"),
      context: { ...context, conversationId: "19:other@thread.tacv2;messageid=1" },
    });
    expect(unknown.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.connectorCalls()).toEqual([WORKING_REPLY]);
  });
});

describe("POST /callbacks/activity", () => {
  it("acknowledges a fresh refresh without rendering, and refuses one older than two minutes", async () => {
    const h = harness({});
    await h.start();
    const payload = {
      kind: "slack.activity_refresh",
      sessionId: "session-1",
      messageId: "message-1",
      timestamp: Date.now(),
      context,
    };
    const fresh = await h.callback("activity", payload);
    expect(await fresh.json()).toEqual({ ok: true, outcome: "accepted" });
    const stale = await h.callback("activity", { ...payload, timestamp: Date.now() - 3 * 60_000 });
    expect(stale.status).toBe(401);
    const unknownKind = await h.callback("activity", { ...payload, kind: "other" });
    expect(unknownKind.status).toBe(400);
    expect(h.connectorCalls()).toEqual([WORKING_REPLY]);
  });
});

describe("POST /callbacks/thread_closed", () => {
  it("closes the thread, posts the note once, and then drops the session's completion", async () => {
    const h = harness({});
    await h.start();
    const payload = {
      kind: MSTEAMS_THREAD_CLOSED_KIND,
      sessionId: "session-1",
      timestamp: Date.now(),
      context: { conversationId: THREAD_KEY, serviceUrl: SERVICE_URL, replyToId: ROOT_ID },
    };
    const closed = await h.callback("thread_closed", payload);
    expect(await closed.json()).toEqual({ ok: true, outcome: "delivered" });
    expect(h.store.getThreadSession(THREAD_KEY)).toMatchObject({ closed: true, turnState: "idle" });
    expect(h.connectorCalls().at(-1)).toMatchObject({
      method: "POST",
      path: `${THREAD_ACTIVITIES}/${ROOT_ID}`,
      text: THREAD_CLOSED_MESSAGE,
      replyToId: ROOT_ID,
    });

    const again = await h.callback("thread_closed", payload);
    expect(await again.json()).toEqual({ ok: true, outcome: "duplicate" });
    const complete = await h.callback("complete", completePayload());
    expect(await complete.json()).toEqual({ ok: true, outcome: "skipped" });
    expect(h.connectorCalls()).toHaveLength(2);
  });

  it("leaves a thread alone when another session owns it now", async () => {
    const h = harness({});
    await h.start();
    const response = await h.callback("thread_closed", {
      kind: "slack.thread_closed",
      sessionId: "session-old",
      timestamp: Date.now(),
      context: { conversationId: THREAD_KEY, serviceUrl: SERVICE_URL },
    });
    expect(await response.json()).toEqual({ ok: true, outcome: "skipped" });
    expect(h.store.getThreadSession(THREAD_KEY)?.closed).toBe(false);
    expect(h.connectorCalls()).toEqual([WORKING_REPLY]);
  });
});

describe("the mounted app", () => {
  it("serves the health probe next to the callback routes", async () => {
    const h = harness({});
    const response = await h.app.request("/healthz");
    expect(await response.json()).toEqual({ status: "ok", service: "open-inspect-teams-bot" });
    expect((await h.app.request("/callbacks/nope", { method: "POST" })).status).toBe(404);
  });
});

afterEach(() => {
  // Nothing shared between tests; each harness owns its store.
});
