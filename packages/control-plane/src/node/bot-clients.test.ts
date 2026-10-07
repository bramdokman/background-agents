import { describe, expect, it, vi } from "vitest";
import {
  BOT_CLIENT_VARIABLE_NAMES,
  createBotClients,
  createHttpFetchClient,
  readBotClientConfig,
} from "./bot-clients";

describe("readBotClientConfig", () => {
  it("reads only the bot URL variables and treats an empty one as unset", () => {
    const config = readBotClientConfig({
      SLACK_BOT_URL: "https://slack-bot.example.com",
      LINEAR_BOT_URL: "",
      TEAMS_BOT_URL: "http://open-inspect-teams-bot:3100/",
      SLACK_BOT_TOKEN: "xoxb-not-a-url",
      PATH: "/usr/bin",
    });
    expect(Object.keys(config).sort()).toEqual(["SLACK_BOT", "TEAMS_BOT"]);
    expect(config.SLACK_BOT?.href).toBe("https://slack-bot.example.com/");
    expect(config.TEAMS_BOT?.href).toBe("http://open-inspect-teams-bot:3100/");
    expect(readBotClientConfig({})).toEqual({});
  });

  it("names each variable after the port it supplies", () => {
    expect(BOT_CLIENT_VARIABLE_NAMES).toEqual({
      SLACK_BOT: "SLACK_BOT_URL",
      LINEAR_BOT: "LINEAR_BOT_URL",
      TEAMS_BOT: "TEAMS_BOT_URL",
    });
  });

  it("rejects a relative, non-http, or request-shaped URL by name", () => {
    expect(() => readBotClientConfig({ TEAMS_BOT_URL: "teams-bot:3100" })).toThrow(
      "TEAMS_BOT_URL must be an absolute http(s) URL, got teams-bot:3100"
    );
    expect(() => readBotClientConfig({ LINEAR_BOT_URL: "ftp://linear-bot" })).toThrow(
      "LINEAR_BOT_URL must be an absolute http(s) URL, got ftp://linear-bot"
    );
    expect(() => readBotClientConfig({ SLACK_BOT_URL: "http://slack-bot?x=1" })).toThrow(
      "SLACK_BOT_URL must not carry a query or fragment, got http://slack-bot?x=1"
    );
  });
});

describe("createHttpFetchClient", () => {
  it("sends the request's path and query to the base URL, as a service binding would", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const client = createHttpFetchClient(new URL("http://open-inspect-teams-bot:3100"), fetchImpl);
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };

    const response = await client.fetch("https://internal/callbacks/complete?attempt=2", init);

    expect(await response.text()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      new URL("http://open-inspect-teams-bot:3100/callbacks/complete?attempt=2"),
      init
    );
  });

  it("keeps a base path prefix and accepts URL and Request inputs", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const client = createHttpFetchClient(new URL("https://bots.example.com/teams/"), fetchImpl);

    await client.fetch(new URL("https://internal/callbacks/activity"));
    await client.fetch(
      new Request("https://internal/callbacks/tool_call", { method: "POST", body: "{}" })
    );

    expect(fetchImpl.mock.calls[0]![0]).toEqual(
      new URL("https://bots.example.com/teams/callbacks/activity")
    );
    const forwarded = fetchImpl.mock.calls[1]![0] as Request;
    expect(forwarded).toBeInstanceOf(Request);
    expect(forwarded.url).toBe("https://bots.example.com/teams/callbacks/tool_call");
    expect(forwarded.method).toBe("POST");
    expect(await forwarded.text()).toBe("{}");
  });
});

describe("createBotClients", () => {
  it("supplies a port for each configured bot and none for the rest", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    const ports = createBotClients(
      { TEAMS_BOT: new URL("http://open-inspect-teams-bot:3100") },
      fetchImpl
    );
    expect(Object.keys(ports)).toEqual(["TEAMS_BOT"]);
    expect(ports.SLACK_BOT).toBeUndefined();
    expect(ports.LINEAR_BOT).toBeUndefined();
    await ports.TEAMS_BOT!.fetch("https://internal/callbacks/thread_closed", { method: "POST" });
    expect(fetchImpl.mock.calls[0]![0]).toEqual(
      new URL("http://open-inspect-teams-bot:3100/callbacks/thread_closed")
    );
    expect(createBotClients({})).toEqual({});
  });
});
