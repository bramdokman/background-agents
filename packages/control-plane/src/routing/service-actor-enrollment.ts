/**
 * The canonical user behind a verified service actor, resolved once at
 * admission so the subject authorized is the subject attributed.
 */

import { actorEnrollment, type ResolvedIdentity } from "../auth/principal";
import type { UserStore } from "../db/user-store";
import type { ServiceActorProfileClaims } from "../routes/shared";

export type ServiceActorResolution =
  | { kind: "resolved"; userId: string }
  /** An existing-only namespace with no identity on record; nothing was written. */
  | { kind: "not_enrolled" };

/**
 * Namespaces that enroll on first contact go through `resolveOrCreateUser`
 * with the bot's profile claims. An existing-only namespace is matched on
 * `(provider, provider_user_id)` alone: the claims are not consulted, so a
 * bot can neither create a user nor relink one through an asserted email.
 */
export async function resolveServiceActorUser(
  users: UserStore,
  actor: ResolvedIdentity,
  claims: ServiceActorProfileClaims | undefined
): Promise<ServiceActorResolution> {
  if (actorEnrollment(actor.provider) === "existing-only") {
    const identity = await users.getIdentity(actor.provider, actor.providerUserId);
    return identity ? { kind: "resolved", userId: identity.userId } : { kind: "not_enrolled" };
  }
  const user = await users.resolveOrCreateUser({
    provider: actor.provider,
    providerUserId: actor.providerUserId,
    displayName: claims?.displayName,
    providerEmail:
      actor.provider === "slack" || actor.provider === "linear" ? claims?.email : undefined,
    avatarUrl: claims?.avatarUrl,
  });
  return { kind: "resolved", userId: user.id };
}
