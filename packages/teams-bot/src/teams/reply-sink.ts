/**
 * The progress-message pattern: one "Working..." reply per turn, updated in
 * place as progress arrives and replaced by the final text; a failed update
 * falls back to a fresh post so the user always sees the outcome.
 *
 * Ported from Centaur `services/teamsbot/src/reply-sink.ts` (see PORTED.md).
 * The Chat SDK adapter is replaced by a two-method port the Bot Framework
 * REST client satisfies, and the placeholder reads "Working..." as OI's bots do.
 */

export const WORKING_TEXT = "Working...";

export type TeamsReplySink = {
  begin(): Promise<{ progressActivityId?: string }>;
  emit(delta: string, fullText: string): Promise<TeamsReplySinkResult>;
  complete(finalText: string, fullText: string): Promise<TeamsReplySinkResult>;
  fail(text: string, fullText: string): Promise<TeamsReplySinkResult>;
};

type TeamsReplySinkResult = void | { progressActivityId?: string };

/** What a sink needs from the channel: post a message, edit one by id. */
export interface ReplySinkPort {
  post(text: string): Promise<{ id?: string } | unknown>;
  update(messageId: string, text: string): Promise<unknown>;
}

/** Channel threads: a placeholder that is only replaced by the final text. */
export function createBlockReplySink(
  port: ReplySinkPort,
  initialMessageId?: string
): TeamsReplySink {
  let progressActivityId = initialMessageId;
  let flushedText = progressActivityId ? WORKING_TEXT : "";
  return {
    async begin() {
      if (!progressActivityId) {
        const posted = await port.post(WORKING_TEXT);
        progressActivityId = activityId(posted);
        flushedText = progressActivityId ? WORKING_TEXT : "";
      }
      return { progressActivityId };
    },
    async emit() {
      return { progressActivityId };
    },
    async complete(finalText) {
      if (finalText !== flushedText) {
        progressActivityId = await updateOrPost(port, progressActivityId, finalText);
        flushedText = finalText;
      }
      return { progressActivityId };
    },
    async fail(text) {
      progressActivityId = await updateOrPost(port, progressActivityId, text);
      flushedText = text;
      return { progressActivityId };
    },
  };
}

/** Personal chats: the placeholder is edited with every progress update. */
export function createStreamingEditReplySink(port: ReplySinkPort): TeamsReplySink {
  let progressActivityId: string | undefined;
  let flushedText = "";
  return {
    async begin() {
      const posted = await port.post(WORKING_TEXT);
      progressActivityId = activityId(posted);
      flushedText = progressActivityId ? WORKING_TEXT : "";
      return { progressActivityId };
    },
    async emit(_delta, fullText) {
      if (fullText && fullText !== flushedText) {
        progressActivityId = await updateOrPost(port, progressActivityId, fullText);
        flushedText = fullText;
      }
      return { progressActivityId };
    },
    async complete(finalText, fullText) {
      const text = finalText || fullText;
      if (text !== flushedText) {
        progressActivityId = await updateOrPost(port, progressActivityId, text);
        flushedText = text;
      }
      return { progressActivityId };
    },
    async fail(text) {
      progressActivityId = await updateOrPost(port, progressActivityId, text);
      flushedText = text;
      return { progressActivityId };
    },
  };
}

/** Edit `messageId` with `text`, posting instead when there is none or the edit fails. */
export async function updateOrPost(
  port: ReplySinkPort,
  messageId: string | undefined,
  text: string
): Promise<string | undefined> {
  if (!messageId) {
    return activityId(await port.post(text));
  }
  try {
    await port.update(messageId, text);
    return messageId;
  } catch {
    return activityId(await port.post(text));
  }
}

function activityId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value
    ? String((value as { id?: unknown }).id ?? "") || undefined
    : undefined;
}
