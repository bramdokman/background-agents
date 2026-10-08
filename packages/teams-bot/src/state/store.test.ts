import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STATE_FILE_NAME, TeamsStateStore } from "./store";

const threadKey = "19:chan@thread.tacv2;messageid=100";

function newSession(overrides: Partial<Parameters<TeamsStateStore["putThreadSession"]>[0]> = {}) {
  return {
    threadKey,
    sessionId: "session-1",
    teamId: "team-platform",
    repoFullName: "ProvidenceIT/playground",
    model: "anthropic/claude-sonnet-4.5",
    reasoningEffort: null,
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    channelId: "19:chan@thread.tacv2",
    rootActivityId: "100",
    ...overrides,
  };
}

describe("TeamsStateStore", () => {
  const stores: TeamsStateStore[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function open(now?: () => number) {
    const store = TeamsStateStore.inMemory(now);
    stores.push(store);
    return store;
  }

  it("maps a thread to its session and reads it back", () => {
    let now = 1_000;
    const store = open(() => now);
    const stored = store.putThreadSession(
      newSession({ progressActivityId: "reply-1", lastMessageId: "m-1", turnState: "working" })
    );
    expect(stored).toEqual({
      threadKey,
      sessionId: "session-1",
      teamId: "team-platform",
      repoFullName: "ProvidenceIT/playground",
      model: "anthropic/claude-sonnet-4.5",
      reasoningEffort: null,
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      channelId: "19:chan@thread.tacv2",
      rootActivityId: "100",
      progressActivityId: "reply-1",
      lastMessageId: "m-1",
      turnState: "working",
      closed: false,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(store.getThreadSession("other")).toBeNull();
    now = 2_000;
    expect(
      store.updateThreadSession(threadKey, { turnState: "idle", progressActivityId: null })
    ).toMatchObject({
      turnState: "idle",
      progressActivityId: null,
      lastMessageId: "m-1",
      updatedAt: 2_000,
    });
    expect(store.updateThreadSession("missing", { turnState: "idle" })).toBeNull();
    expect(store.findThreadSessionsBySessionId("session-1").map((row) => row.threadKey)).toEqual([
      threadKey,
    ]);
  });

  it("closes a thread only for the session it maps to", () => {
    const store = open();
    store.putThreadSession(newSession({ turnState: "working" }));
    expect(store.closeThreadSession(threadKey, "session-other")).toBe(false);
    expect(store.getThreadSession(threadKey)?.closed).toBe(false);
    expect(store.closeThreadSession(threadKey, "session-1")).toBe(true);
    expect(store.getThreadSession(threadKey)).toMatchObject({ closed: true, turnState: "idle" });
  });

  it("replaces the mapping when a new session starts in the same thread", () => {
    const store = open();
    store.putThreadSession(newSession());
    store.putThreadSession(newSession({ sessionId: "session-2" }));
    expect(store.getThreadSession(threadKey)?.sessionId).toBe("session-2");
    expect(store.findThreadSessionsBySessionId("session-1")).toEqual([]);
  });

  it("keeps conversation references and tolerates corrupt ones", () => {
    const store = open();
    expect(store.getConversationReference(threadKey)).toBeNull();
    store.putConversationReference(threadKey, {
      conversationId: threadKey,
      serviceUrl: "https://smba.trafficmanager.net/",
    });
    store.putConversationReference(threadKey, { conversationId: threadKey, activityId: "100" });
    expect(store.getConversationReference(threadKey)).toEqual({
      conversationId: threadKey,
      activityId: "100",
    });
  });

  it("claims each inbound activity once and prunes old claims", () => {
    let now = 10_000;
    const store = open(() => now);
    expect(store.claimInboundActivity("a-1")).toBe(true);
    expect(store.claimInboundActivity("a-1")).toBe(false);
    now = 20_000;
    expect(store.claimInboundActivity("a-2")).toBe(true);
    expect(store.pruneInboundActivities(5_000)).toBe(1);
    expect(store.claimInboundActivity("a-1")).toBe(true);
    expect(store.claimInboundActivity("a-2")).toBe(false);
  });

  it("dedupes callbacks by (messageId, kind) and lets a released claim through again", () => {
    const store = open();
    expect(store.claimCallback("m-1", "complete")).toBe(true);
    expect(store.claimCallback("m-1", "complete")).toBe(false);
    expect(store.claimCallback("m-1", "tool_call")).toBe(true);
    expect(store.claimCallback("m-2", "complete")).toBe(true);
    store.releaseCallback("m-1", "complete");
    expect(store.claimCallback("m-1", "complete")).toBe(true);
  });

  it("persists to a file under the state directory and survives reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "teams-bot-state-"));
    dirs.push(dir);
    const first = TeamsStateStore.open(join(dir, "nested"));
    first.putThreadSession(newSession());
    first.close();
    const second = TeamsStateStore.open(join(dir, "nested"));
    stores.push(second);
    expect(second.getThreadSession(threadKey)?.sessionId).toBe("session-1");
    expect(STATE_FILE_NAME).toBe("teams-bot.sqlite");
  });
});
