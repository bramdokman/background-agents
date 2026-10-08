import { describe, expect, it } from "vitest";
import { CHANNEL_SCOPE_BOTS, parseChannelScope } from "./channel-scope";

const TEAMS_CHANNEL_ID = "19:f78857599fec4951a2c1116a3f1ade3e@thread.tacv2";

describe("signed channel scope", () => {
  it.each([
    ["slack:C1", { provider: "slack", externalId: "C1" }],
    ["linear:team-1", { provider: "linear", externalId: "team-1" }],
    [`msteams:${TEAMS_CHANNEL_ID}`, { provider: "msteams", externalId: TEAMS_CHANNEL_ID }],
    [
      "msteams:19:meeting_NzE4YjQ0@thread.v2",
      { provider: "msteams", externalId: "19:meeting_NzE4YjQ0@thread.v2" },
    ],
  ])("parses %s without confusing Slack workspace identity with team ownership", (value, scope) => {
    expect(parseChannelScope(value)).toEqual(scope);
  });

  it.each([
    "",
    "C1",
    "slack:",
    "unknown:C1",
    "slack: C1",
    "slack:C1:other",
    `slack:${TEAMS_CHANNEL_ID}`,
    `linear:${TEAMS_CHANNEL_ID}`,
    "msteams:",
    "msteams:C1",
    "msteams:19:f78857599fec4951a2c1116a3f1ade3e",
    "msteams:f78857599fec4951a2c1116a3f1ade3e@thread.tacv2",
    "msteams:19:f788 57599fec4951a2c1116a3f1ade3e@thread.tacv2",
    `msteams:${TEAMS_CHANNEL_ID}:other`,
    `msteams:${TEAMS_CHANNEL_ID}@other`,
    `MSTeams:${TEAMS_CHANNEL_ID}`,
  ])("rejects malformed or unsupported scope %s", (value) =>
    expect(parseChannelScope(value)).toBeNull()
  );

  it("admits exactly one bot per binding provider", () => {
    expect(CHANNEL_SCOPE_BOTS).toEqual({
      slack: "slack-bot",
      linear: "linear-bot",
      msteams: "teams-bot",
    });
  });
});
