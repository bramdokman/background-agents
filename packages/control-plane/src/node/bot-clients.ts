/**
 * Outbound clients for the bots the control plane delivers callbacks to.
 *
 * On Workers each bot is a service binding (`SLACK_BOT`, `LINEAR_BOT`): the
 * callback code fetches `https://internal/callbacks/...` and the binding
 * ignores the host. The Node host has no bindings, so each bot is reached by
 * URL instead: `SLACK_BOT_URL`, `LINEAR_BOT_URL` and `TEAMS_BOT_URL` name a
 * bot's base URL, and its client sends the path and query of the request it is
 * given to that base. A variable left unset leaves the port absent, as an
 * undeployed binding does, so that bot's callbacks are skipped, never failed.
 */

import type { FetchClient } from "../platform-ports";
import type { Platform } from "../types";
import { pickVariables, type ConfigSource } from "./config";

/** The bot ports a URL can supply, each named after the Worker binding it stands in for. */
export type BotClientPort = "SLACK_BOT" | "LINEAR_BOT" | "TEAMS_BOT";

/** The bot URL variables; `readBotClientConfig` reads through this table only. */
export const BOT_CLIENT_VARIABLE_NAMES = {
  SLACK_BOT: "SLACK_BOT_URL",
  LINEAR_BOT: "LINEAR_BOT_URL",
  TEAMS_BOT: "TEAMS_BOT_URL",
} as const satisfies Record<BotClientPort, string>;

/** Each configured bot's base URL, by the port it serves. */
export type BotClientConfig = Partial<Record<BotClientPort, URL>>;

/**
 * The bot URLs from `source`. Each present variable must be an absolute
 * `http:` or `https:` URL without a query or fragment; a bot's base URL is a
 * place to send paths to, not a request in itself.
 */
export function readBotClientConfig(source: ConfigSource): BotClientConfig {
  const variables = pickVariables(source, Object.values(BOT_CLIENT_VARIABLE_NAMES));
  const config: BotClientConfig = {};
  for (const [port, name] of Object.entries(BOT_CLIENT_VARIABLE_NAMES) as [
    BotClientPort,
    string,
  ][]) {
    const raw = variables[name as keyof typeof variables];
    if (raw === undefined || raw === "") continue;
    config[port] = parseBotUrl(name, raw);
  }
  return config;
}

function parseBotUrl(name: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, got ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an absolute http(s) URL, got ${raw}`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must not carry a query or fragment, got ${raw}`);
  }
  return url;
}

/**
 * A `FetchClient` over plain HTTP to `base`: the request's path and query are
 * appended to the base URL's path and its host is discarded, which is what a
 * Worker service binding does with the `https://internal` host the callback
 * code addresses. A base path is kept, so a bot mounted under a prefix works.
 */
export function createHttpFetchClient(base: URL, fetchImpl: typeof fetch = fetch): FetchClient {
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const resolve = (url: string): URL => {
    const given = new URL(url);
    const target = new URL(base);
    target.pathname = basePath + given.pathname.replace(/^\/+/, "");
    target.search = given.search;
    return target;
  };
  return {
    fetch(input, init) {
      if (input instanceof Request) {
        return fetchImpl(new Request(resolve(input.url), input), init);
      }
      return fetchImpl(resolve(input instanceof URL ? input.href : input), init);
    },
  };
}

/** The bot ports for `config`: a client per configured URL, nothing for the rest. */
export function createBotClients(
  config: BotClientConfig,
  fetchImpl: typeof fetch = fetch
): Pick<Platform, BotClientPort> {
  const ports: Pick<Platform, BotClientPort> = {};
  for (const port of Object.keys(BOT_CLIENT_VARIABLE_NAMES) as BotClientPort[]) {
    const base = config[port];
    if (base) ports[port] = createHttpFetchClient(base, fetchImpl);
  }
  return ports;
}
