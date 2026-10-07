import type { SettledTurn } from "../db/usage-ledger";
import type { MessageRepository } from "./message-repository";
import type { ParticipantRepository } from "./participant-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { UsageRepository } from "./usage-repository";

export interface SettledTurnSources {
  getSessionId: () => string | null;
  session: Pick<SessionCoreRepository, "getSession">;
  messages: Pick<MessageRepository, "getMessageById">;
  participants: Pick<ParticipantRepository, "getParticipantById">;
  usage: Pick<UsageRepository, "getMessageTokenTotals">;
}

/**
 * The usage-ledger row for a turn that just settled, read from the session's
 * own storage: the message's highest reported cost, the tokens its steps
 * recorded, and the prompt author's metered identity (the canonical user id
 * when the participant has one, otherwise the id they prompted under).
 * Null when the message or its author is unknown, which leaves no row.
 */
export function resolveSettledTurn(
  sources: SettledTurnSources,
  messageId: string,
  settledAt: number
): SettledTurn | null {
  const sessionId = sources.getSessionId();
  const session = sources.session.getSession();
  const message = sources.messages.getMessageById(messageId);
  if (!sessionId || !session || !message) return null;
  const author = sources.participants.getParticipantById(message.author_id);
  if (!author) return null;
  const tokens = sources.usage.getMessageTokenTotals(messageId);
  return {
    messageId,
    sessionId,
    userId: author.canonical_user_id ?? author.user_id,
    repoExternalId: session.repo_id ?? null,
    harness: session.harness ?? null,
    model: message.model ?? session.model ?? null,
    costUsd: message.reported_cost_usd,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    settledAt,
  };
}
