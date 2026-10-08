import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import { describe, expect, it } from "vitest";
import { ControlPlaneClient, microsoftActor } from "../control-plane/client";
import { json, scriptedFetch, USER_OID } from "../test-support";
import { fetchAgentResponse, formatCompletionText, truncateError } from "./completion";
import { AGENT_COMPLETED_MESSAGE, THREAD_CLOSED_MESSAGE } from "./messages";

const WEB_APP_URL = "https://web.example.test";
const LINK = `[Open the session](${WEB_APP_URL}/session/session-1)`;

function response(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    textContent: "I added the badge.",
    toolCalls: [],
    artifacts: [],
    mediaArtifacts: [],
    success: true,
    ...overrides,
  };
}

const context = { model: "anthropic/claude-sonnet-4.5", repoFullName: "ProvidenceIT/playground" };

describe("formatCompletionText", () => {
  it("renders the answer, the artifacts, the footer and the session link", () => {
    const text = formatCompletionText({
      sessionId: "session-1",
      success: true,
      response: response({
        artifacts: [
          { type: "pr", url: "https://github.com/o/r/pull/12", label: "PR #12" },
          { type: "branch", url: "", label: "Branch: x" },
        ],
      }),
      context: { ...context, reasoningEffort: "high" },
      webAppUrl: WEB_APP_URL,
    });
    expect(text).toBe(
      [
        "I added the badge.",
        "**Created:**\n- [PR #12](https://github.com/o/r/pull/12)",
        `Done | anthropic/claude-sonnet-4.5 (high) | ProvidenceIT/playground\n\n${LINK}`,
      ].join("\n\n")
    );
  });

  it("offers the manual pull-request link when the agent only pushed a branch", () => {
    const text = formatCompletionText({
      sessionId: "session-1",
      success: true,
      response: response({
        artifacts: [
          {
            type: "branch",
            url: "https://github.com/o/r/tree/feat",
            label: "Branch: feat",
            metadata: { mode: "manual_pr", createPrUrl: "https://github.com/o/r/compare/feat" },
          },
        ],
      }),
      context,
      webAppUrl: WEB_APP_URL,
    });
    expect(text).toContain(
      "- [Branch: feat](https://github.com/o/r/tree/feat)\n- [Create a pull request](https://github.com/o/r/compare/feat)"
    );
  });

  it("says the agent completed when there is no text, and shows the failure when there is none either", () => {
    expect(
      formatCompletionText({
        sessionId: "session-1",
        success: true,
        response: response({ textContent: "" }),
        context,
        webAppUrl: WEB_APP_URL,
      })
    ).toBe(
      `${AGENT_COMPLETED_MESSAGE}\n\nDone | anthropic/claude-sonnet-4.5 | ProvidenceIT/playground\n\n${LINK}`
    );

    expect(
      formatCompletionText({
        sessionId: "session-1",
        success: false,
        error: "sandbox   timed\nout",
        response: null,
        context: { model: context.model },
        webAppUrl: WEB_APP_URL,
      })
    ).toBe(
      `**The agent failed:** sandbox timed out\n\nFailed: sandbox timed out | anthropic/claude-sonnet-4.5\n\n${LINK}`
    );
  });

  it("marks a turn the control plane failed but that still produced text", () => {
    const text = formatCompletionText({
      sessionId: "session-1",
      success: false,
      response: response({ success: false }),
      context,
      webAppUrl: WEB_APP_URL,
    });
    expect(text).toContain("I added the badge.");
    expect(text).toContain("Completed with issues | ");
  });

  it("truncates very long answers and keeps the link", () => {
    const text = formatCompletionText({
      sessionId: "session-1",
      success: true,
      response: response({ textContent: "a".repeat(25_000) }),
      context,
      webAppUrl: WEB_APP_URL,
    });
    expect(text.length).toBeLessThan(21_000);
    expect(text).toContain("_(truncated; the full answer is in the session)_");
    expect(text.endsWith(LINK)).toBe(true);
  });

  it("truncates errors on a word boundary-free cut with an ellipsis", () => {
    expect(truncateError("a  b\n c", 10)).toBe("a b c");
    expect(truncateError("abcdefghij", 5)).toBe("abcd…");
  });

  it("keeps the closure note short", () => {
    expect(THREAD_CLOSED_MESSAGE.length).toBeLessThan(80);
  });
});

describe("fetchAgentResponse", () => {
  const actor = microsoftActor(USER_OID);
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

  it("aggregates events and the artifacts created during the turn", async () => {
    const remote = scriptedFetch({
      "GET /sessions/session-1/events": () => json({ events, hasMore: false }),
      "GET /sessions/session-1/artifacts": () =>
        json({
          artifacts: [
            {
              id: "a1",
              type: "pr",
              url: "https://github.com/o/r/pull/12",
              metadata: { number: 12 },
              createdAt: 2_500,
            },
            { id: "a0", type: "pr", url: "https://old", metadata: { number: 3 }, createdAt: 10 },
            { id: "s1", type: "screenshot", url: null, metadata: null, createdAt: 2_600 },
          ],
        }),
    });
    const client = new ControlPlaneClient({
      baseUrl: "http://open-inspect-control-plane:8787",
      secret: "placeholder-service-secret",
      fetch: remote.fetch,
    });
    const result = await fetchAgentResponse(client, { actor }, "session-1", "message-1", "trace");
    expect(result).toEqual({
      textContent: "I added the badge.",
      toolCalls: [{ tool: "Bash", summary: "Ran: npm test" }],
      artifacts: [
        {
          type: "pr",
          url: "https://github.com/o/r/pull/12",
          label: "PR #12",
          metadata: { number: 12 },
        },
      ],
      mediaArtifacts: [],
      success: true,
      error: undefined,
    });
    expect(remote.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/sessions/session-1/events",
      "/sessions/session-1/artifacts",
    ]);
  });

  it("is null when the events cannot be read, and tolerates an artifacts failure", async () => {
    const denied = new ControlPlaneClient({
      baseUrl: "http://open-inspect-control-plane:8787",
      secret: "placeholder-service-secret",
      fetch: scriptedFetch({ "GET *": () => json({ error: "Forbidden" }, 403) }).fetch,
    });
    await expect(
      fetchAgentResponse(denied, { actor }, "session-1", "message-1")
    ).resolves.toBeNull();

    const partial = new ControlPlaneClient({
      baseUrl: "http://open-inspect-control-plane:8787",
      secret: "placeholder-service-secret",
      fetch: scriptedFetch({
        "GET /sessions/session-1/events": () => json({ events, hasMore: false }),
        "GET /sessions/session-1/artifacts": () => json({ error: "down" }, 503),
      }).fetch,
    });
    await expect(
      fetchAgentResponse(partial, { actor }, "session-1", "message-1")
    ).resolves.toMatchObject({ textContent: "I added the badge.", artifacts: [] });
  });

  it("reads without an actor, scoped to the channel, when asked to", async () => {
    const remote = scriptedFetch({
      "GET /sessions/session-1/events": () => json({ events, hasMore: false }),
      "GET /sessions/session-1/artifacts": () => json({ artifacts: [] }),
    });
    const client = new ControlPlaneClient({
      baseUrl: "http://open-inspect-control-plane:8787",
      secret: "placeholder-service-secret",
      fetch: remote.fetch,
    });
    const scope = { channel: "msteams:19:chan@thread.tacv2" };
    await expect(
      fetchAgentResponse(client, scope, "session-1", "message-1")
    ).resolves.toMatchObject({ textContent: "I added the badge." });
    for (const request of remote.requests) {
      expect(request.headers["x-openinspect-actor"]).toBeUndefined();
      expect(new URL(request.url).searchParams.get("channel")).toBe("msteams:19:chan@thread.tacv2");
    }
  });
});
