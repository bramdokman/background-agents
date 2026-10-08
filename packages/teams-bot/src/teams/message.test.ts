import { describe, expect, it } from "vitest";
import {
  checkTeamsActivity,
  formatQuotedReplyContext,
  messageMentionsBot,
  normalizeTeamsText,
  teamsGetChannelId,
  teamsGetSenderObjectId,
  teamsQuotedReplyContext,
  teamsThreadKey,
} from "./message";
import { toStoredConversationReference } from "./conversation-reference";
import {
  activityFixture,
  APP_ID,
  CHANNEL_ID,
  OTHER_TENANT_ID,
  SERVICE_URL,
  TENANT_ID,
  USER_OID,
} from "../test-support";

describe("Teams message normalisation (ported from Centaur)", () => {
  it("detects and strips the bot's mention, collapsing whitespace", () => {
    const activity = activityFixture();
    expect(messageMentionsBot(activity)).toBe(true);
    expect(normalizeTeamsText(activity)).toBe("ProvidenceIT/playground add a README badge");
  });

  it("leaves mentions of other users in place", () => {
    const activity = activityFixture({
      text: "<at>Open-Inspect</at> ask <at>Riley</at> about it",
      entities: [
        { type: "mention", text: "<at>Open-Inspect</at>", mentioned: { id: `28:${APP_ID}` } },
        { type: "mention", text: "<at>Riley</at>", mentioned: { id: "29:riley" } },
      ],
    });
    expect(normalizeTeamsText(activity)).toBe("ask <at>Riley</at> about it");
  });

  it("reports no mention when the recipient is unknown or not mentioned", () => {
    expect(messageMentionsBot(activityFixture({ recipient: undefined }))).toBe(false);
    expect(messageMentionsBot(activityFixture({ entities: [] }))).toBe(false);
  });

  it("extracts quoted replies, skipping deleted ones, and renders them as prompt context", () => {
    const activity = activityFixture({
      entities: [
        {
          type: "quotedreply",
          quotedReply: {
            messageId: "message-1",
            preview: "Original request: summarize this pipeline.",
            senderId: "user-2",
            senderName: "Riley",
            time: "1772050244572",
          },
        },
        { type: "quotedreply", quotedReply: { messageId: "gone", isReplyDeleted: true } },
        { type: "quotedreply", quotedReply: { preview: "undated", time: "not-a-date" } },
      ],
    });
    const quotes = teamsQuotedReplyContext(activity);
    expect(quotes).toEqual([
      {
        messageId: "message-1",
        senderName: "Riley",
        text: "Original request: summarize this pipeline.",
        timestamp: "2026-02-25T20:10:44.572Z",
      },
      {
        messageId: "quoted-2",
        senderName: undefined,
        text: "undated",
        timestamp: "1970-01-01T00:00:00.000Z",
      },
    ]);
    const rendered = formatQuotedReplyContext(quotes);
    expect(rendered).toContain("## Teams Thread Context");
    expect(rendered).toContain("- Riley: Original request: summarize this pipeline.");
    expect(rendered).toContain("- Unknown: undated");
    expect(formatQuotedReplyContext([])).toBe("");
  });

  it("fails closed for non-Teams and non-message activities", () => {
    expect(checkTeamsActivity(activityFixture({ channelId: "webchat" }), TENANT_ID)).toEqual({
      ok: false,
      reason: "not_teams",
    });
    expect(checkTeamsActivity(activityFixture({ type: "conversationUpdate" }), TENANT_ID)).toEqual({
      ok: false,
      reason: "not_message",
    });
  });

  it("uses the tenant as the outer boundary", () => {
    expect(checkTeamsActivity(activityFixture(), TENANT_ID)).toEqual({ ok: true });
    expect(
      checkTeamsActivity(
        activityFixture({
          channelData: { channel: { id: CHANNEL_ID }, tenant: { id: OTHER_TENANT_ID } },
          conversation: { id: "c", conversationType: "channel", tenantId: OTHER_TENANT_ID },
        }),
        TENANT_ID
      )
    ).toEqual({ ok: false, reason: "tenant" });
    expect(
      checkTeamsActivity(
        activityFixture({
          channelData: { channel: { id: CHANNEL_ID } },
          conversation: { id: "c" },
        }),
        TENANT_ID
      )
    ).toEqual({ ok: false, reason: "tenant" });
    expect(
      checkTeamsActivity(
        activityFixture({
          channelData: { tenant: { id: TENANT_ID } },
          conversation: { id: "a:1", conversationType: "personal", tenantId: TENANT_ID },
        }),
        TENANT_ID
      )
    ).toEqual({ ok: true });
  });

  it("derives one thread key for a root post and its replies", () => {
    const root = activityFixture({
      id: "100",
      conversation: { id: CHANNEL_ID, conversationType: "channel", tenantId: TENANT_ID },
    });
    const reply = activityFixture({
      id: "101",
      replyToId: "100",
      conversation: {
        id: `${CHANNEL_ID};messageid=100`,
        conversationType: "channel",
        tenantId: TENANT_ID,
      },
    });
    expect(teamsThreadKey(root)).toBe(`${CHANNEL_ID};messageid=100`);
    expect(teamsThreadKey(reply)).toBe(`${CHANNEL_ID};messageid=100`);
    expect(
      teamsThreadKey(
        activityFixture({
          channelData: {},
          conversation: { id: "a:chat", conversationType: "personal" },
        })
      )
    ).toBe("a:chat");
    expect(teamsThreadKey(activityFixture({ conversation: undefined }))).toBeUndefined();
  });

  it("reads the channel id and the sender's directory id", () => {
    expect(teamsGetChannelId(activityFixture())).toBe(CHANNEL_ID);
    expect(teamsGetChannelId(activityFixture({ channelData: { teamsChannelId: "19:x" } }))).toBe(
      "19:x"
    );
    expect(teamsGetSenderObjectId(activityFixture())).toBe(USER_OID);
    expect(
      teamsGetSenderObjectId(activityFixture({ from: { id: "29:1", aadObjectId: " " } }))
    ).toBeUndefined();
  });

  it("stores the conversation reference needed to post after a restart", () => {
    const reference = toStoredConversationReference(activityFixture());
    expect(reference).toEqual({
      activityId: "1759900000001",
      bot: { id: `28:${APP_ID}`, name: "Open-Inspect" },
      channelId: "msteams",
      conversation: {
        id: `${CHANNEL_ID};messageid=1759900000001`,
        conversationType: "channel",
        tenantId: TENANT_ID,
      },
      conversationId: `${CHANNEL_ID};messageid=1759900000001`,
      conversationType: "channel",
      serviceUrl: SERVICE_URL,
      teamId: "19:team@thread.tacv2",
      tenantId: TENANT_ID,
      user: { id: "29:1user", name: "Casey", aadObjectId: USER_OID },
    });
  });
});
