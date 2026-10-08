/**
 * Every sentence the bot says, in one place. Markdown as Teams renders it.
 */

export const HELP_TEXT = [
  "**Open-Inspect** starts coding sessions from this channel.",
  "",
  "- `@bot owner/repo <prompt>` or `@bot repo:owner/repo <prompt>` starts a session in a new thread.",
  "- `@bot <prompt>` does the same when this channel's team has exactly one repository.",
  "- Reply in a session's thread to send a follow-up prompt.",
  "- `@bot status` and `@bot stop` work inside a session's thread.",
  "- `!model <id>` and `!reasoning <effort>` at the start of a prompt pick the model for it.",
].join("\n");

export const UNBOUND_CHANNEL_MESSAGE =
  "This channel is not bound to a team. Ask a team lead or administrator to bind it in Open-Inspect before starting a session.";

export const BINDING_UNAVAILABLE_MESSAGE =
  "I couldn't verify this channel's binding. Please try again.";

export const NOT_A_CHANNEL_MESSAGE =
  "I can only start sessions from a team channel. Mention me in a channel that is bound to a team.";

export const NO_SESSION_IN_THREAD_MESSAGE =
  "There is no session in this thread. Mention me in the channel with `owner/repo <prompt>` to start one.";

export const THREAD_CLOSED_MESSAGE = "This session is no longer available from this thread.";

export const NO_IDENTITY_MESSAGE =
  "I can't tell who you are: your Teams account carries no directory identity. Ask an administrator to check the bot's permissions.";

export const SESSION_CREATE_FAILED_MESSAGE =
  "Sorry, I couldn't create a session. Please try again.";

export const PROMPT_FAILED_MESSAGE =
  "Session created but failed to send the prompt. Please try again.";

export const FOLLOW_UP_FAILED_MESSAGE = "I couldn't send that to the session. Please try again.";

export const STOP_REQUESTED_MESSAGE = "Stopping the running turn.";

export const STOP_FAILED_MESSAGE = "I couldn't stop the session. Please try again.";

export const MISSING_PROMPT_MESSAGE =
  "Add a prompt after the repository, for example `owner/repo fix the failing test`.";

export const DEFAULT_FORBIDDEN_MESSAGE = "You are not allowed to do that.";

export const DEFAULT_QUOTA_MESSAGE = "Your usage quota is exhausted for now.";

export const AGENT_COMPLETED_MESSAGE = "_Agent completed._";

export const CREATED_HEADING = "**Created:**";

export const CREATE_PR_LABEL = "Create a pull request";

export const OPEN_SESSION_LABEL = "Open the session";

export const TRUNCATED_NOTE = "_(truncated; the full answer is in the session)_";

export function agentFailedMessage(error: string): string {
  return `**The agent failed:** ${error}`;
}

export function signInMessage(webAppUrl: string): string {
  return `Sign in once at ${webAppUrl} with your M365 account, then try again.`;
}

export function sessionUrl(webAppUrl: string, sessionId: string): string {
  return `${webAppUrl}/session/${encodeURIComponent(sessionId)}`;
}

export function chooseRepositoryMessage(repos: readonly string[]): string {
  if (repos.length === 0) {
    return "This channel's team has no repositories yet. Ask a team lead to grant one in Open-Inspect.";
  }
  const shown = repos.slice(0, 10).map((name) => `- \`${name}\``);
  const more = repos.length > 10 ? `\n- and ${repos.length - 10} more` : "";
  return `Name a repository: \`@bot owner/repo <prompt>\`. This team can use:\n${shown.join("\n")}${more}`;
}
