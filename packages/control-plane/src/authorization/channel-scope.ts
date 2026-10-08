import type { ServiceName } from "@open-inspect/shared/service-auth";
import {
  teamChannelBindingProviderSchema,
  type TeamChannelBindingProvider,
} from "@open-inspect/shared/types/team-channel-bindings";

/** The one bot admitted to each binding provider's channel scope and binding lookup. */
export const CHANNEL_SCOPE_BOTS = {
  slack: "slack-bot",
  linear: "linear-bot",
  msteams: "teams-bot",
} as const satisfies Record<TeamChannelBindingProvider, Exclude<ServiceName, "web">>;

export type ChannelScopeBot = (typeof CHANNEL_SCOPE_BOTS)[TeamChannelBindingProvider];

/**
 * The external id each provider's scope may carry. Slack channel and Linear team ids are one
 * token; a Microsoft Teams channel id (`19:<id>@thread.tacv2`) carries its own `:` and `@`, so a
 * scope is split on the provider's `:` only and the remainder is checked per provider.
 */
const EXTERNAL_ID_PATTERNS: Record<TeamChannelBindingProvider, RegExp> = {
  slack: /^[^:\s]+$/,
  linear: /^[^:\s]+$/,
  msteams: /^19:[^\s:@]+@[^\s:@]+$/,
};

export interface ChannelScope {
  provider: TeamChannelBindingProvider;
  externalId: string;
}

/** The provider prefix prevents one bot from selecting another integration's scope. */
export function parseChannelScope(value: string): ChannelScope | null {
  const separator = value.indexOf(":");
  if (separator === -1) return null;
  const provider = teamChannelBindingProviderSchema.safeParse(value.slice(0, separator));
  if (!provider.success) return null;
  const externalId = value.slice(separator + 1);
  return EXTERNAL_ID_PATTERNS[provider.data].test(externalId)
    ? { provider: provider.data, externalId }
    : null;
}
