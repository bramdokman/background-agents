/**
 * The verified identity behind a control-plane request.
 *
 * Every non-public request resolves to exactly one `Principal` before its
 * handler runs. The shapes make illegal states unrepresentable: only service
 * principals can carry asserted actors, and user principals always carry a
 * resolved identity.
 */

import type { ServiceName } from "@open-inspect/shared/service-auth";

/**
 * Actor namespaces bots may assert (`slack:U123` etc.). `microsoft` carries
 * the Entra object id (`oid`), the same subject the Microsoft web sign-in
 * stores, so a Teams bot's `aadObjectId` matches that identity directly.
 */
const ACTOR_NAMESPACES = ["slack", "github", "linear", "microsoft"] as const;
export type ActorNamespace = (typeof ACTOR_NAMESPACES)[number];

export function isActorNamespace(value: string): value is ActorNamespace {
  return (ACTOR_NAMESPACES as readonly string[]).includes(value);
}

/**
 * How a verified service actor becomes a canonical user. Slack, GitHub and
 * Linear actors enroll on first contact: the bot is the first-party source of
 * that identity. A Microsoft actor is an object id a bot read off an activity;
 * the tenant evidence for it is the web sign-in (`db/user-store.ts`,
 * `EMAIL_ATTESTING_PROVIDERS`), so a bot may resolve a user who has signed in
 * once and never create one.
 */
export type ActorEnrollment = "resolve-or-create" | "existing-only";

export function actorEnrollment(provider: ResolvedIdentity["provider"]): ActorEnrollment {
  return provider === "microsoft" ? "existing-only" : "resolve-or-create";
}

export interface ResolvedIdentity {
  provider: "github" | "google" | "slack" | "linear" | "microsoft";
  providerUserId: string;
  /** Canonical D1 `users.id`. Always set for user principals; null for actors the CP has never seen. */
  canonicalUserId: string | null;
  /** DO participant format: bare id for web users, `ns:id` for bot actors. */
  participantUserId: string;
}

/** Provider-independent evidence used to authenticate a browser request. */
export interface AuthenticationContext {
  mechanism: "browser_session";
  credentialId: string;
  channel: {
    kind: "sig1";
    service: "web";
  };
}

export type Principal =
  | { kind: "user"; userId: string }
  | { kind: "service"; service: ServiceName; actor: ResolvedIdentity | null }
  /** `sandboxId` is the authenticated sandbox's id when the session runtime reported it. */
  | { kind: "sandbox"; sessionId: string; sandboxId?: string | null };

/**
 * The actor namespace each service may assert. Web asserts none because its
 * identity arrives by token exchange, never assertion.
 */
export const ASSERTION_RIGHTS: Record<ServiceName, ActorNamespace | null> = {
  web: null,
  "slack-bot": "slack",
  "github-bot": "github",
  "linear-bot": "linear",
  "teams-bot": "microsoft",
};
