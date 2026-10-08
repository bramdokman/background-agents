import { describe, expect, it } from "vitest";
import { createBotFrameworkClient, ServiceUrlNotAllowedError } from "./client";
import { parseAllowedServiceUrlHosts } from "./service-url";
import { createClientCredentialsTokenProvider, tokenEndpoint } from "./token";
import { APP_ID, scriptedFetch, SERVICE_URL, TENANT_ID } from "../test-support";

const allowedServiceUrlHosts = parseAllowedServiceUrlHosts("smba.trafficmanager.net");
const address = {
  serviceUrl: SERVICE_URL,
  conversationId: "19:chan@thread.tacv2;messageid=100",
  bot: { id: `28:${APP_ID}`, name: "Open-Inspect" },
  user: { id: "29:1user", name: "Casey" },
};

describe("client-credentials token provider", () => {
  it("requests a token from the single tenant with the connector scope and caches it", async () => {
    let now = 1_000_000;
    const remote = scriptedFetch({
      "POST /9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a/oauth2/v2.0/token": () =>
        Response.json({
          access_token: "placeholder-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
    });
    const tokens = createClientCredentialsTokenProvider({
      tenantId: TENANT_ID,
      appId: APP_ID,
      appSecret: "placeholder-app-secret",
      fetch: remote.fetch,
      now: () => now,
    });
    await expect(tokens.getToken()).resolves.toBe("placeholder-token");
    await expect(tokens.getToken()).resolves.toBe("placeholder-token");
    expect(remote.requests).toHaveLength(1);
    expect(remote.requests[0].url).toBe(tokenEndpoint(TENANT_ID));
    expect(new URLSearchParams(remote.requests[0].rawBody).get("scope")).toBe(
      "https://api.botframework.com/.default"
    );
    expect(new URLSearchParams(remote.requests[0].rawBody).get("grant_type")).toBe(
      "client_credentials"
    );
    now += 3600 * 1000;
    await tokens.getToken();
    expect(remote.requests).toHaveLength(2);
  });

  it("fails with the status only when the token endpoint refuses", async () => {
    const remote = scriptedFetch({
      "POST *": () => Response.json({ error: "invalid_client" }, { status: 401 }),
    });
    const tokens = createClientCredentialsTokenProvider({
      tenantId: TENANT_ID,
      appId: APP_ID,
      appSecret: "placeholder-app-secret",
      fetch: remote.fetch,
    });
    await expect(tokens.getToken()).rejects.toThrow("Bot Framework token request failed with 401");
  });
});

describe("Bot Framework REST client", () => {
  const tokens = { getToken: async () => "placeholder-token" };

  it("replies, posts and updates through the connector on the activity's serviceUrl", async () => {
    const remote = scriptedFetch({
      "POST *": () => Response.json({ id: "reply-1" }),
      "PUT *": () => Response.json({ id: "reply-1" }),
    });
    const client = createBotFrameworkClient({
      tokens,
      allowedServiceUrlHosts,
      fetch: remote.fetch,
    });

    await expect(client.replyToActivity(address, "100", "Working...")).resolves.toEqual({
      id: "reply-1",
    });
    await client.updateActivity(address, "reply-1", "Done");
    await client.sendToConversation(address, "Note");

    expect(remote.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST ${SERVICE_URL}v3/conversations/${encodeURIComponent(address.conversationId)}/activities/100`,
      `PUT ${SERVICE_URL}v3/conversations/${encodeURIComponent(address.conversationId)}/activities/reply-1`,
      `POST ${SERVICE_URL}v3/conversations/${encodeURIComponent(address.conversationId)}/activities`,
    ]);
    expect(remote.requests[0].headers.authorization).toBe("Bearer placeholder-token");
    expect(remote.requests[0].body).toEqual({
      type: "message",
      text: "Working...",
      textFormat: "markdown",
      conversation: { id: address.conversationId },
      from: address.bot,
      recipient: address.user,
      replyToId: "100",
    });
    expect(remote.requests[1].body).toMatchObject({ id: "reply-1", text: "Done" });
  });

  it("refuses to call a serviceUrl outside the allowlist before any request is made", async () => {
    const remote = scriptedFetch({ "POST *": () => Response.json({ id: "x" }) });
    const client = createBotFrameworkClient({
      tokens,
      allowedServiceUrlHosts,
      fetch: remote.fetch,
    });
    const forged = { ...address, serviceUrl: "https://attacker.example/" };
    await expect(client.replyToActivity(forged, "100", "hi")).rejects.toBeInstanceOf(
      ServiceUrlNotAllowedError
    );
    await expect(client.updateActivity(forged, "1", "hi")).rejects.toBeInstanceOf(
      ServiceUrlNotAllowedError
    );
    await expect(
      client.sendProactive({ conversationId: "c", serviceUrl: "https://attacker.example/" }, "hi")
    ).rejects.toBeInstanceOf(ServiceUrlNotAllowedError);
    expect(remote.requests).toHaveLength(0);
  });

  it("posts proactively from a stored reference as a reply to its root activity", async () => {
    const remote = scriptedFetch({ "POST *": () => Response.json({ id: "proactive-1" }) });
    const client = createBotFrameworkClient({
      tokens,
      allowedServiceUrlHosts,
      fetch: remote.fetch,
    });
    await expect(
      client.sendProactive(
        {
          activityId: "100",
          conversationId: address.conversationId,
          serviceUrl: SERVICE_URL,
          bot: { id: address.bot.id, name: "Open-Inspect" },
          user: { id: "29:1user" },
        },
        "Finished"
      )
    ).resolves.toEqual({ id: "proactive-1" });
    expect(remote.requests[0].url).toContain("/activities/100");
    expect(remote.requests[0].body).toMatchObject({
      replyToId: "100",
      from: { id: address.bot.id },
    });
  });

  it("surfaces connector errors with their status, marks 4xx as refusals, and the reply port can post", async () => {
    let status = 404;
    const remote = scriptedFetch({
      "PUT *": () => new Response("gone", { status }),
      "POST *": () => Response.json({ id: "fresh" }),
    });
    const client = createBotFrameworkClient({
      tokens,
      allowedServiceUrlHosts,
      fetch: remote.fetch,
    });
    await expect(client.updateActivity(address, "old", "text")).rejects.toThrow(
      "Bot Framework updateActivity failed with 404"
    );
    // A 4xx is the connector's final word on this edit; a 5xx says nothing about whether it applied.
    await expect(client.updateActivity(address, "old", "text")).rejects.toMatchObject({
      name: "BotFrameworkRequestError",
      status: 404,
      refused: true,
    });
    status = 502;
    await expect(client.updateActivity(address, "old", "text")).rejects.toMatchObject({
      status: 502,
      refused: false,
    });
    const port = client.replyPort(address, "100");
    await expect(port.post("hello")).resolves.toEqual({ id: "fresh" });
    expect(remote.requests.at(-1)?.body).toMatchObject({ replyToId: "100", text: "hello" });
  });
});
