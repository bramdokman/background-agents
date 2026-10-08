/**
 * The command grammar, applied to the message text after the bot's mention
 * has been stripped. Teams bots have no server-side slash commands, so this
 * is the whole surface: `help`, `status`, `stop`, and otherwise a prompt that
 * may name a repository and carry the shared `!model`/`!reasoning` flags.
 */

import {
  parseInlinePromptFlags,
  type InlinePromptOptions,
} from "@open-inspect/shared/inline-prompt-flags";
import { MISSING_PROMPT_MESSAGE } from "./messages";

export interface RepositoryRef {
  owner: string;
  name: string;
  fullName: string;
}

export type Command =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "prompt"; repo: RepositoryRef | null; text: string; options: InlinePromptOptions }
  | { kind: "error"; message: string };

const REPO_TOKEN = /^(?:repo:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** `owner/name` or `repo:owner/name`, or null for anything else. */
export function parseRepositoryToken(token: string): RepositoryRef | null {
  const match = REPO_TOKEN.exec(token);
  if (!match) return null;
  const [, owner, name] = match;
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return { owner, name, fullName: `${owner}/${name}` };
}

/**
 * Parse one message. Inside a thread that already has a session the text is
 * a follow-up prompt and no repository is read from it; in the channel the
 * first token may name the repository.
 */
export function parseCommand(text: string, context: { inThread: boolean }): Command {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "help" };
  const word = trimmed.toLowerCase();
  if (word === "help" || word === "?") return { kind: "help" };
  if (word === "status") return { kind: "status" };
  if (word === "stop" || word === "cancel") return { kind: "stop" };

  const flags = parseInlinePromptFlags(trimmed);
  if (!flags.ok) return { kind: "error", message: flags.error };
  const body = flags.text.trim();
  if (context.inThread) {
    if (body === "") return { kind: "error", message: MISSING_PROMPT_MESSAGE };
    return { kind: "prompt", repo: null, text: body, options: flags.options };
  }

  const [first = "", ...rest] = body.split(/\s+/);
  const repo = parseRepositoryToken(first);
  if (repo) {
    const prompt = rest.join(" ").trim();
    if (prompt === "") return { kind: "error", message: MISSING_PROMPT_MESSAGE };
    return { kind: "prompt", repo, text: prompt, options: flags.options };
  }
  if (body === "") return { kind: "help" };
  return { kind: "prompt", repo: null, text: body, options: flags.options };
}
