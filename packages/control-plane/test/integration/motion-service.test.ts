import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { buildServiceAuthHeaders, type ServiceName } from "@open-inspect/shared/service-auth";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO } from "./helpers";

/** Entra object ids: the subject a Microsoft web sign-in stores and Providence asserts. */
const SIGNED_IN_OBJECT_ID = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const OTHER_OBJECT_ID = "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e";
const UNKNOWN_OBJECT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BASE = "https://test.local";
const MODEL = "anthropic/claude-haiku-4-5";

async function identityTableCounts() {
  return env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM sessions) AS sessions,
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM user_identities) AS identities,
       (SELECT COUNT(*) FROM user_role_assignments) AS assignments`
  ).first<{ sessions: number; users: number; identities: number; assignments: number }>();
}

async function signedFetch(p: {
  service?: ServiceName;
  method: string;
  path: string;
  body?: unknown;
  objectId?: string | null;
}): Promise<Response> {
  const service = p.service ?? "motion";
  const url = `${BASE}${p.path}`;
  const body = p.body === undefined ? undefined : JSON.stringify(p.body);
  const objectId = p.objectId === undefined ? SIGNED_IN_OBJECT_ID : p.objectId;
  const headers = await buildServiceAuthHeaders({
    service,
    secret: `test-service-secret-${service}`,
    method: p.method,
    url,
    body,
    actor: objectId ? `microsoft:${objectId}` : undefined,
  });
  return SELF.fetch(url, {
    method: p.method,
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

/** A Member whose Microsoft sign-in enrolled `objectId`. */
async function enrollMember(objectId: string, displayName: string): Promise<string> {
  const users = new UserStore(env.DB);
  const member = await users.createUser({
    displayName,
    email: `${objectId}@corp.test`,
    emailVerified: true,
  });
  await env.DB.prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
    .bind("role_builtin_member", member.id)
    .run();
  await users.createIdentity({
    userId: member.id,
    provider: "microsoft",
    providerUserId: objectId,
  });
  return member.id;
}

function createBody(extra: Record<string, unknown> = {}) {
  return { title: "Work item 123", model: MODEL, ...extra };
}

describe("motion service identity", () => {
  let memberId: string;

  beforeEach(async () => {
    await cleanD1Tables();
    memberId = await enrollMember(SIGNED_IN_OBJECT_ID, "Signed-in Member");
  });

  it("creates a session owned by the enrolled actor and attributed to motion", async () => {
    const response = await signedFetch({ method: "POST", path: "/sessions", body: createBody() });

    expect(response.status).toBe(201);
    const { sessionId } = await response.json<{ sessionId: string }>();
    await expect(
      env.DB.prepare(
        "SELECT user_id AS userId, spawn_source AS spawnSource FROM sessions WHERE id = ?"
      )
        .bind(sessionId)
        .first()
    ).resolves.toEqual({ userId: memberId, spawnSource: "motion" });
  });

  it("refuses an unknown object id and writes no identity rows", async () => {
    const before = await identityTableCounts();
    const response = await signedFetch({
      method: "POST",
      path: "/sessions",
      body: createBody(),
      objectId: UNKNOWN_OBJECT_ID,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Forbidden",
      code: "service_actor_not_enrolled",
    });
    await expect(identityTableCounts()).resolves.toEqual(before);
    const audit = await env.DB.prepare(
      `SELECT actor_service_snapshot FROM authorization_audit_events
       WHERE reason_code = 'service_actor_not_enrolled'`
    ).first<{ actor_service_snapshot: string }>();
    expect(audit).toEqual({ actor_service_snapshot: "motion" });
  });

  it.each([
    ["GET", "/sessions/SESSION/participants"],
    ["GET", "/sessions/SESSION/diff"],
    ["GET", "/sessions/SESSION/sandbox-access"],
    ["POST", "/sessions/SESSION/archive"],
    ["POST", "/sessions/SESSION/ws-token"],
    ["DELETE", "/sessions/SESSION"],
    ["GET", "/repos"],
    ["GET", "/environments"],
    ["GET", "/automations"],
  ])("refuses %s %s before enrolling or reading anything", async (method, pathTemplate) => {
    const { sessionName } = await initSession({ userId: memberId });
    const before = await identityTableCounts();
    const response = await signedFetch({
      method,
      path: pathTemplate.replace("SESSION", sessionName),
      ...(method === "GET" ? {} : { body: {} }),
      objectId: UNKNOWN_OBJECT_ID,
    });

    expect(response.status).toBe(403);
    // Human-user routes refuse every service at authentication; the rest at the opt-in gate.
    expect([
      { error: "Forbidden", code: "service_capability_required" },
      { error: "Human user authentication required" },
    ]).toContainEqual(await response.json());
    await expect(identityTableCounts()).resolves.toEqual(before);
  });

  it("reads model preferences for its actor", async () => {
    const response = await signedFetch({ method: "GET", path: "/model-preferences?strict=true" });

    expect(response.status).toBe(200);
    const body = await response.json<{ enabledModels: unknown; revision: unknown }>();
    expect(Array.isArray(body.enabledModels)).toBe(true);
    expect(typeof body.revision).toBe("number");
  });

  it("refuses model preferences without an actor", async () => {
    const response = await signedFetch({
      method: "GET",
      path: "/model-preferences?strict=true",
      objectId: null,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Forbidden",
      code: "service_actor_required",
    });
  });

  it("still answers 403 on PATCH /model-preferences", async () => {
    const response = await signedFetch({
      method: "PATCH",
      path: "/model-preferences",
      body: { changes: [{ modelId: MODEL, enabled: false }] },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Forbidden",
      code: "service_capability_required",
    });
  });

  it("lists and reads the inbox for its actor only", async () => {
    const otherId = await enrollMember(OTHER_OBJECT_ID, "Other Member");
    const created = await signedFetch({ method: "POST", path: "/sessions", body: createBody() });
    const { sessionId } = await created.json<{ sessionId: string }>();
    await initSession({ userId: otherId });

    const list = await signedFetch({ method: "GET", path: "/sessions?createdBy=me" });
    expect(list.status).toBe(200);
    const { sessions } = await list.json<{ sessions: Array<{ id: string }> }>();
    expect(sessions.map((session) => session.id)).toEqual([sessionId]);

    const inbox = await signedFetch({ method: "GET", path: "/sessions/inbox?mine=true" });
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(await inbox.json())).toContain(sessionId);

    const slackInbox = await signedFetch({
      service: "teams-bot",
      method: "GET",
      path: "/sessions/inbox",
    });
    expect(slackInbox.status).toBe(403);
  });

  it("finds its own session by externalRef and nobody else's", async () => {
    await enrollMember(OTHER_OBJECT_ID, "Other Member");
    const created = await signedFetch({
      method: "POST",
      path: "/sessions",
      body: createBody({ externalRef: "wi-123:1" }),
    });
    const { sessionId } = await created.json<{ sessionId: string }>();

    const own = await signedFetch({ method: "GET", path: "/sessions?externalRef=wi-123%3A1" });
    expect(own.status).toBe(200);
    expect((await own.json<{ sessions: Array<{ id: string }> }>()).sessions).toEqual([
      expect.objectContaining({ id: sessionId }),
    ]);

    const otherActor = await signedFetch({
      method: "GET",
      path: "/sessions?externalRef=wi-123%3A1",
      objectId: OTHER_OBJECT_ID,
    });
    expect((await otherActor.json<{ sessions: unknown[] }>()).sessions).toEqual([]);

    const teamsBot = await signedFetch({
      service: "teams-bot",
      method: "GET",
      path: "/sessions?externalRef=wi-123%3A1",
    });
    expect(teamsBot.status).toBe(200);
    expect((await teamsBot.json<{ sessions: unknown[] }>()).sessions).toEqual([]);
  });

  it("replays a retried create and lets only one of two racing creates through", async () => {
    const body = createBody({ externalRef: "wi-200:1" });
    const first = await signedFetch({ method: "POST", path: "/sessions", body });
    expect(first.status).toBe(201);
    const { sessionId } = await first.json<{ sessionId: string }>();

    const retry = await signedFetch({ method: "POST", path: "/sessions", body });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ sessionId, status: "created", replayed: true });

    const mismatch = await signedFetch({
      method: "POST",
      path: "/sessions",
      body: { ...body, title: "Different" },
    });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({ code: "external_ref_payload_mismatch" });

    const raced = createBody({ externalRef: "wi-201:1" });
    const results = await Promise.all([
      signedFetch({ method: "POST", path: "/sessions", body: raced }),
      signedFetch({ method: "POST", path: "/sessions", body: raced }),
    ]);
    const statuses = results.map((response) => response.status).sort();
    expect([
      [200, 201],
      [201, 409],
    ]).toContainEqual(statuses);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE external_ref = 'wi-201:1'"
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe("motion session operations", () => {
  let memberId: string;
  let ownSessionId: string;

  beforeEach(async () => {
    await cleanD1Tables();
    memberId = await enrollMember(SIGNED_IN_OBJECT_ID, "Signed-in Member");
    const created = await signedFetch({ method: "POST", path: "/sessions", body: createBody() });
    expect(created.status).toBe(201);
    ownSessionId = (await created.json<{ sessionId: string }>()).sessionId;
  });

  it("stops and prompts a session it created for its actor", async () => {
    const stop = await signedFetch({ method: "POST", path: `/sessions/${ownSessionId}/stop` });
    expect(stop.status).toBe(200);
    await expect(stop.json()).resolves.toEqual({ status: "stopping" });

    const prompt = await signedFetch({
      method: "POST",
      path: `/sessions/${ownSessionId}/prompt`,
      body: { content: "Implement work item 123", clientRequestId: "wi-123:p1" },
    });
    expect(prompt.status).toBe(200);
    const queued = await prompt.json<{ messageId: string; replayed: boolean }>();
    expect(queued.replayed).toBe(false);

    const retry = await signedFetch({
      method: "POST",
      path: `/sessions/${ownSessionId}/prompt`,
      body: { content: "Implement work item 123", clientRequestId: "wi-123:p1" },
    });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      messageId: queued.messageId,
      replayed: true,
    });

    const conflict = await signedFetch({
      method: "POST",
      path: `/sessions/${ownSessionId}/prompt`,
      body: { content: "Something else", clientRequestId: "wi-123:p1" },
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "PROMPT_REQUEST_CONFLICT" });

    const stub = env.SESSION.get(env.SESSION.idFromName(ownSessionId));
    const rows = await queryDO<{ client_request_id: string }>(
      stub,
      "SELECT client_request_id FROM messages WHERE client_request_id IS NOT NULL"
    );
    expect(rows).toEqual([{ client_request_id: "svc:motion:wi-123:p1" }]);
  });

  it("answers 404 for sessions it did not create for its actor", async () => {
    const otherId = await enrollMember(OTHER_OBJECT_ID, "Other Member");
    const { sessionName: usersOwn } = await initSession({ userId: memberId });
    const { sessionName: someoneElses } = await initSession({ userId: otherId });
    const otherActor = await signedFetch({
      method: "POST",
      path: "/sessions",
      body: createBody(),
      objectId: OTHER_OBJECT_ID,
    });
    const { sessionId: otherActorsMotionSession } = await otherActor.json<{ sessionId: string }>();

    for (const sessionId of [usersOwn, someoneElses, otherActorsMotionSession, "missing"]) {
      for (const [path, body] of [
        [`/sessions/${sessionId}/stop`, undefined],
        [`/sessions/${sessionId}/prompt`, { content: "Hello" }],
      ] as const) {
        const response = await signedFetch({ method: "POST", path, body });
        expect(response.status, `${path}`).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: "Session not found" });
      }
    }
  });

  it("reads any session its actor may read, with no sandbox locations", async () => {
    const otherId = await enrollMember(OTHER_OBJECT_ID, "Other Member");
    // Created in the web for the person, then a workspace session of someone else.
    const { sessionName: usersOwn } = await initSession({ userId: memberId });
    const { sessionName: someoneElses } = await initSession({ userId: otherId });

    for (const sessionId of [ownSessionId, usersOwn, someoneElses]) {
      const snapshot = await signedFetch({ method: "GET", path: `/sessions/${sessionId}` });
      expect(snapshot.status, sessionId).toBe(200);
      const body = await snapshot.json<{
        session: Record<string, unknown>;
        artifacts: unknown[];
      }>();
      expect(body.session).toMatchObject({ id: sessionId });
      expect(body.session).toHaveProperty("branchName");
      expect(body.session).toHaveProperty("sandboxStatus");
      for (const field of [
        "codeServerUrl",
        "vncUrl",
        "ttydUrl",
        "tunnelUrls",
        "sandboxDashboardUrl",
      ]) {
        expect(body.session, field).not.toHaveProperty(field);
      }

      for (const path of ["events", "messages", "artifacts"]) {
        const response = await signedFetch({
          method: "GET",
          path: `/sessions/${sessionId}/${path}`,
        });
        expect(response.status, `${sessionId}/${path}`).toBe(200);
        expect(await response.json(), path).toHaveProperty(path);
      }
    }

    // Reading never widens what it may change.
    const stop = await signedFetch({ method: "POST", path: `/sessions/${usersOwn}/stop` });
    expect(stop.status).toBe(404);
  });

  it("answers 404 for a session its actor may not read, and 403 for an unknown actor", async () => {
    const otherId = await enrollMember(OTHER_OBJECT_ID, "Other Member");
    const { sessionName } = await initSession({ userId: otherId });
    await env.DB.prepare("UPDATE sessions SET visibility = 'private' WHERE id = ?")
      .bind(sessionName)
      .run();

    for (const path of ["", "/events", "/messages", "/artifacts"]) {
      const hidden = await signedFetch({ method: "GET", path: `/sessions/${sessionName}${path}` });
      expect(hidden.status, path).toBe(404);
      const missing = await signedFetch({ method: "GET", path: `/sessions/missing${path}` });
      expect(missing.status, path).toBe(404);
    }

    const before = await identityTableCounts();
    const unknown = await signedFetch({
      method: "GET",
      path: `/sessions/${ownSessionId}`,
      objectId: UNKNOWN_OBJECT_ID,
    });
    expect(unknown.status).toBe(403);
    await expect(unknown.json()).resolves.toEqual({
      error: "Forbidden",
      code: "service_actor_not_enrolled",
    });
    await expect(identityTableCounts()).resolves.toEqual(before);
  });

  it("shows its own externalRef on list rows and nobody else", async () => {
    const created = await signedFetch({
      method: "POST",
      path: "/sessions",
      body: createBody({ externalRef: "wi-300:1" }),
    });
    const { sessionId } = await created.json<{ sessionId: string }>();

    const list = await signedFetch({ method: "GET", path: "/sessions" });
    const { sessions } = await list.json<{ sessions: Array<Record<string, unknown>> }>();
    expect(sessions.find((session) => session.id === sessionId)).toMatchObject({
      externalRef: "wi-300:1",
    });
    expect(sessions.find((session) => session.id === ownSessionId)).not.toHaveProperty(
      "externalRef"
    );

    const teamsBot = await signedFetch({ service: "teams-bot", method: "GET", path: "/sessions" });
    const seenByTeams = await teamsBot.json<{ sessions: Array<Record<string, unknown>> }>();
    expect(seenByTeams.sessions.find((session) => session.id === sessionId)).toBeDefined();
    expect(seenByTeams.sessions.find((session) => session.id === sessionId)).not.toHaveProperty(
      "externalRef"
    );
  });

  it("keeps teams-bot stopping any session its actor can see", async () => {
    await enrollMember(OTHER_OBJECT_ID, "Other Member");
    const { sessionName } = await initSession({ userId: memberId });
    const stop = await signedFetch({
      service: "teams-bot",
      method: "POST",
      path: `/sessions/${sessionName}/stop`,
    });
    expect(stop.status).toBe(200);
  });
});
