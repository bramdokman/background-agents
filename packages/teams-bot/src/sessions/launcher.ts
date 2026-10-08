/**
 * Starting a session from a channel mention, and the model/flag resolution
 * both the launcher and follow-ups share. Every control-plane call carries
 * the Teams user as actor; every denial is rendered in the thread.
 */

import {
  DEFAULT_MODEL,
  getReasoningConfig,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
} from "@open-inspect/shared/models";
import type { InlinePromptOptions } from "@open-inspect/shared/inline-prompt-flags";
import type { MsTeamsCallbackContext } from "@open-inspect/shared/types/session-api";
import type { ActivityAddress, BotFrameworkClient } from "../bot-framework/client";
import type { ControlPlaneClient } from "../control-plane/client";
import { type ControlPlaneFailure, type ControlPlaneResult } from "../control-plane/client";
import type { Logger } from "../logger";
import type { TeamsStateStore } from "../state/store";
import { toStoredConversationReference } from "../teams/conversation-reference";
import { teamsGetChannelId } from "../teams/message";
import { WORKING_TEXT } from "../teams/reply-sink";
import type { TeamsActivity } from "../types";
import type { RepositoryRef } from "./commands";
import {
  BINDING_UNAVAILABLE_MESSAGE,
  chooseRepositoryMessage,
  DEFAULT_FORBIDDEN_MESSAGE,
  DEFAULT_QUOTA_MESSAGE,
  NOT_A_CHANNEL_MESSAGE,
  PROMPT_FAILED_MESSAGE,
  SESSION_CREATE_FAILED_MESSAGE,
  signInMessage,
  UNBOUND_CHANNEL_MESSAGE,
} from "./messages";

export interface LaunchDeps {
  controlPlane: ControlPlaneClient;
  bot: BotFrameworkClient;
  store: TeamsStateStore;
  log: Logger;
  webAppUrl: string;
}

export interface ModelSelection {
  model: string;
  reasoningEffort?: string;
}

/** Apply inline flags to the defaults, or say why they cannot be applied. */
export function resolveModelSelection(
  options: InlinePromptOptions,
  defaults: ModelSelection
): { ok: true; selection: ModelSelection } | { ok: false; error: string } {
  let model = defaults.model;
  if (options.model) {
    if (!isValidModel(options.model)) {
      return { ok: false, error: `Unknown model "${options.model}".` };
    }
    model = normalizeModelId(options.model);
  }
  let reasoningEffort = options.model ? undefined : defaults.reasoningEffort;
  if (options.reasoningEffort) {
    if (!isValidReasoningEffort(model, options.reasoningEffort)) {
      const efforts = getReasoningConfig(model)?.efforts;
      const suffix = efforts?.length
        ? ` Supported values: ${efforts.join(", ")}.`
        : " This model does not support reasoning controls.";
      return {
        ok: false,
        error: `Reasoning effort "${options.reasoningEffort}" is not valid for "${model}".${suffix}`,
      };
    }
    reasoningEffort = options.reasoningEffort;
  }
  return { ok: true, selection: { model, ...(reasoningEffort ? { reasoningEffort } : {}) } };
}

/** The text a control-plane failure shows the user; the control plane's own message when it sent one. */
export function renderFailure(
  failure: ControlPlaneFailure,
  webAppUrl: string,
  fallback: string
): string {
  switch (failure.reason) {
    case "not_enrolled":
      return signInMessage(webAppUrl);
    case "quota":
      return failure.message ?? DEFAULT_QUOTA_MESSAGE;
    case "forbidden":
      return failure.message ?? DEFAULT_FORBIDDEN_MESSAGE;
    case "invalid":
      return failure.message ?? fallback;
    default:
      return fallback;
  }
}

export interface LaunchInput {
  activity: TeamsActivity;
  threadKey: string;
  address: ActivityAddress;
  /** The root post of the thread; replies go under it. */
  rootActivityId: string;
  actor: string;
  repo: RepositoryRef | null;
  prompt: string;
  options: InlinePromptOptions;
  traceId: string;
}

async function resolveRepository(
  deps: LaunchDeps,
  input: LaunchInput,
  teamId: string
): Promise<ControlPlaneResult<RepositoryRef | null>> {
  if (input.repo) return { ok: true, data: input.repo };
  const repos = await deps.controlPlane.listRepositories(input.actor, teamId, input.traceId);
  if (!repos.ok) return repos;
  if (repos.data.length === 1) {
    const [only] = repos.data;
    return { ok: true, data: { owner: only.owner, name: only.name, fullName: only.fullName } };
  }
  await deps.bot.replyToActivity(
    input.address,
    input.rootActivityId,
    chooseRepositoryMessage(repos.data.map((repo) => repo.fullName))
  );
  return { ok: true, data: null };
}

/** Start a session for a channel mention and send its first prompt. Replies in the thread on every outcome. */
export async function launchSession(deps: LaunchDeps, input: LaunchInput): Promise<void> {
  const { activity, address, rootActivityId, actor, traceId } = input;
  const reply = (text: string) => deps.bot.replyToActivity(address, rootActivityId, text);
  const logBase = { trace_id: traceId, thread_key: input.threadKey, actor };

  const channelId = teamsGetChannelId(activity);
  if (!channelId) {
    await reply(NOT_A_CHANNEL_MESSAGE);
    return;
  }

  const binding = await deps.controlPlane.lookupChannelBinding(channelId, traceId);
  if (binding.kind !== "resolved" || binding.binding.teamId === null) {
    deps.log.info("launch.rejected", {
      ...logBase,
      channel_id: channelId,
      reject_reason: binding.kind === "unavailable" ? "binding_unavailable" : "channel_unbound",
    });
    await reply(
      binding.kind === "unavailable" ? BINDING_UNAVAILABLE_MESSAGE : UNBOUND_CHANNEL_MESSAGE
    );
    return;
  }
  const teamId = binding.binding.teamId;

  const selection = resolveModelSelection(input.options, { model: DEFAULT_MODEL });
  if (!selection.ok) {
    await reply(selection.error);
    return;
  }

  const repo = await resolveRepository(deps, input, teamId);
  if (!repo.ok) {
    await reply(renderFailure(repo, deps.webAppUrl, SESSION_CREATE_FAILED_MESSAGE));
    return;
  }
  if (!repo.data) return;

  const session = await deps.controlPlane.createSession(
    actor,
    {
      teamId,
      repoOwner: repo.data.owner,
      repoName: repo.data.name,
      model: selection.selection.model,
      reasoningEffort: selection.selection.reasoningEffort,
      actorDisplayName: activity.from?.name,
    },
    traceId
  );
  if (!session.ok) {
    deps.log.info("launch.rejected", {
      ...logBase,
      team_id: teamId,
      reject_reason: session.reason,
      http_status: session.status,
      code: session.code,
    });
    await reply(renderFailure(session, deps.webAppUrl, SESSION_CREATE_FAILED_MESSAGE));
    return;
  }
  const sessionId = session.data.sessionId;

  const callbackContext: MsTeamsCallbackContext = {
    source: "msteams",
    conversationId: input.threadKey,
    serviceUrl: address.serviceUrl,
    replyToId: rootActivityId,
    channelId,
    repoFullName: repo.data.fullName,
    model: selection.selection.model,
  };
  const prompt = await deps.controlPlane.sendPrompt(
    actor,
    sessionId,
    { content: input.prompt, callbackContext },
    traceId
  );
  if (!prompt.ok) {
    deps.log.info("launch.prompt_rejected", {
      ...logBase,
      session_id: sessionId,
      reject_reason: prompt.reason,
      http_status: prompt.status,
      code: prompt.code,
    });
    await reply(renderFailure(prompt, deps.webAppUrl, PROMPT_FAILED_MESSAGE));
    return;
  }

  const working = await reply(WORKING_TEXT);
  deps.store.putThreadSession({
    threadKey: input.threadKey,
    sessionId,
    teamId,
    repoFullName: repo.data.fullName,
    model: selection.selection.model,
    reasoningEffort: selection.selection.reasoningEffort ?? null,
    serviceUrl: address.serviceUrl,
    channelId,
    rootActivityId,
    progressActivityId: working.id || null,
    lastMessageId: prompt.data.messageId,
    turnState: "working",
  });
  deps.store.putConversationReference(input.threadKey, toStoredConversationReference(activity));
  deps.log.info("launch.started", {
    ...logBase,
    team_id: teamId,
    session_id: sessionId,
    message_id: prompt.data.messageId,
    repo: repo.data.fullName,
    model: selection.selection.model,
  });
}
