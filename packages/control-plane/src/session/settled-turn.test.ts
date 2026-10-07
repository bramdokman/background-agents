import { describe, expect, it } from "vitest";
import { resolveSettledTurn, type SettledTurnSources } from "./settled-turn";

function sources(overrides: Partial<SettledTurnSources> = {}): SettledTurnSources {
  return {
    getSessionId: () => "session-public",
    session: {
      getSession: () =>
        ({ repo_id: 42, harness: "opencode", model: "anthropic/claude-haiku-4-5" }) as never,
    },
    messages: {
      getMessageById: (id) =>
        id === "msg-1"
          ? ({ id, author_id: "participant-1", model: null, reported_cost_usd: 0.3 } as never)
          : null,
    },
    participants: {
      getParticipantById: (id) =>
        id === "participant-1"
          ? ({ id, user_id: "github:7", canonical_user_id: "alice" } as never)
          : null,
    },
    usage: { getMessageTokenTotals: () => ({ inputTokens: 900, outputTokens: 100 }) },
    ...overrides,
  };
}

describe("resolveSettledTurn", () => {
  it("attributes the turn to the author's canonical user with the session's repo and harness", () => {
    expect(resolveSettledTurn(sources(), "msg-1", 1_700_000_000_000)).toEqual({
      messageId: "msg-1",
      sessionId: "session-public",
      userId: "alice",
      repoExternalId: 42,
      harness: "opencode",
      model: "anthropic/claude-haiku-4-5",
      costUsd: 0.3,
      inputTokens: 900,
      outputTokens: 100,
      settledAt: 1_700_000_000_000,
    });
  });

  it("falls back to the participant id and the message's own model", () => {
    const turn = resolveSettledTurn(
      sources({
        messages: {
          getMessageById: () =>
            ({
              author_id: "participant-1",
              model: "openai/gpt-5",
              reported_cost_usd: 0,
            }) as never,
        },
        participants: {
          getParticipantById: () =>
            ({ id: "participant-1", user_id: "github:7", canonical_user_id: null }) as never,
        },
      }),
      "msg-1",
      1
    );
    expect(turn).toMatchObject({ userId: "github:7", model: "openai/gpt-5", costUsd: 0 });
  });

  it("leaves no row for an unknown message or author", () => {
    expect(resolveSettledTurn(sources(), "msg-unknown", 1)).toBeNull();
    expect(
      resolveSettledTurn(sources({ participants: { getParticipantById: () => null } }), "msg-1", 1)
    ).toBeNull();
  });
});
