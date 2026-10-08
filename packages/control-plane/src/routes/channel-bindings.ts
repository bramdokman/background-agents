import { Hono } from "hono";
import {
  DEFAULT_LINEAR_UNBOUND_CHANNELS,
  DEFAULT_MSTEAMS_UNBOUND_CHANNELS,
  DEFAULT_SLACK_UNBOUND_CHANNELS,
} from "@open-inspect/shared/types/integrations";
import {
  channelBindingResponseSchema,
  type TeamChannelBindingProvider,
} from "@open-inspect/shared/types/team-channel-bindings";
import { CHANNEL_SCOPE_BOTS, type ChannelScopeBot } from "../authorization/channel-scope";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import type { RequestContext } from "../http/request-context";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { error, json, serviceAuthorized } from "./shared";

/** The `unboundChannels` policy for `provider`: its global setting, else its default. */
async function unboundChannelsPolicy(
  provider: TeamChannelBindingProvider,
  ctx: RequestContext
): Promise<"workspace" | "reject"> {
  // Teams has no integration settings yet; its policy is the fixed default.
  if (provider === "msteams") return DEFAULT_MSTEAMS_UNBOUND_CHANNELS;
  const settings = await new IntegrationSettingsStore(ctx.db).getGlobal(provider);
  return (
    settings?.defaults?.unboundChannels ??
    (provider === "slack" ? DEFAULT_SLACK_UNBOUND_CHANNELS : DEFAULT_LINEAR_UNBOUND_CHANNELS)
  );
}

/** Route admission already matched the calling bot to `provider`. */
async function getBinding(
  provider: TeamChannelBindingProvider,
  externalId: string,
  ctx: RequestContext
) {
  try {
    const binding = await new TeamChannelBindingStore(ctx.db).get(provider, externalId);
    if (binding) {
      return json(
        channelBindingResponseSchema.parse({ teamId: binding.teamId, kind: binding.kind })
      );
    }
    // Unbound Slack DMs are personal conversations, not team routing destinations.
    if (provider === "slack" && /^D[A-Z0-9]+$/.test(externalId)) {
      return json(channelBindingResponseSchema.parse({ teamId: null }));
    }
    if ((await unboundChannelsPolicy(provider, ctx)) === "reject") {
      return json({ error: "Channel is not bound", code: "channel_unbound" }, 404);
    }
    return json(channelBindingResponseSchema.parse({ teamId: null }));
  } catch {
    return error("Channel binding lookup unavailable", 503);
  }
}

export const channelBindingRoutes = new Hono<ControlPlaneHonoEnv>();
// Every binding provider's bot looks its bindings up here; only that bot is admitted.
for (const [provider, bot] of Object.entries(CHANNEL_SCOPE_BOTS) as [
  TeamChannelBindingProvider,
  ChannelScopeBot,
][]) {
  channelBindingRoutes.get(
    `/channel-bindings/${provider}/:externalId`,
    admit({
      authentication: { kind: "service" },
      supportedScmProviders: "all",
      cacheControl: "private, no-store",
      authorization: serviceAuthorized(bot),
    }),
    (c) =>
      dispatch(c, async (_request, _env, params, ctx) =>
        getBinding(provider, params.externalId, ctx)
      )
  );
}
