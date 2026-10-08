/**
 * Process entry: configuration from the environment, the state store opened,
 * the collaborators wired, the server started, and SIGTERM turned into an
 * orderly shutdown.
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createInboundAuthenticator } from "./bot-framework/auth";
import { createBotFrameworkClient } from "./bot-framework/client";
import { createClientCredentialsTokenProvider } from "./bot-framework/token";
import { loadConfig } from "./config";
import { ControlPlaneClient } from "./control-plane/client";
import { asError, createLogger } from "./logger";
import { createActivityHandler } from "./sessions/handler";
import { TeamsStateStore } from "./state/store";

/** Inbound claims older than this are pruned; the connector retries within seconds. */
const INBOUND_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

function main(): void {
  const config = loadConfig(process.env);
  const log = createLogger("main", {}, config.logLevel);
  const store = TeamsStateStore.open(config.stateDir);
  store.pruneInboundActivities(INBOUND_CLAIM_TTL_MS);

  const tokens = createClientCredentialsTokenProvider({
    tenantId: config.tenantId,
    appId: config.appId,
    appSecret: config.appSecret,
  });
  const bot = createBotFrameworkClient({
    tokens,
    allowedServiceUrlHosts: config.allowedServiceUrlHosts,
  });
  const controlPlane = new ControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    secret: config.serviceAuthSecret,
    log: createLogger("control-plane", {}, config.logLevel),
  });
  const handleActivity = createActivityHandler({
    tenantId: config.tenantId,
    allowedServiceUrlHosts: config.allowedServiceUrlHosts,
    webAppUrl: config.webAppUrl,
    controlPlane,
    bot,
    store,
    log: createLogger("activity", {}, config.logLevel),
  });
  const app = createApp({
    auth: createInboundAuthenticator({ appId: config.appId, tenantId: config.tenantId }),
    handleActivity,
    log: createLogger("http", {}, config.logLevel),
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info("teams_bot.listening", { host: info.address, port: info.port });
  });

  const stop = (signal: NodeJS.Signals): void => {
    log.info("teams_bot.signal", { signal });
    server.close((error) => {
      if (error) log.error("teams_bot.shutdown_failed", { error: asError(error) });
      store.close();
      process.exit(error ? 1 : 0);
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main();
