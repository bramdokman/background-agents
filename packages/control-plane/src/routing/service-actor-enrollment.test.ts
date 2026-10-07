import { describe, expect, it, vi } from "vitest";
import type { ResolvedIdentity } from "../auth/principal";
import type { UserStore } from "../db/user-store";
import { resolveServiceActorUser } from "./service-actor-enrollment";

const OBJECT_ID = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

function actor(provider: ResolvedIdentity["provider"], providerUserId: string): ResolvedIdentity {
  return {
    provider,
    providerUserId,
    canonicalUserId: null,
    participantUserId: `${provider}:${providerUserId}`,
  };
}

function users(identityUserId: string | null) {
  const getIdentity = vi.fn(async () =>
    identityUserId === null
      ? null
      : {
          id: "ident-1",
          userId: identityUserId,
          provider: "microsoft",
          providerUserId: OBJECT_ID,
          providerLogin: null,
          providerEmail: null,
          providerIssuer: "https://login.microsoftonline.com",
          createdAt: 1,
        }
  );
  const resolveOrCreateUser = vi.fn(async () => ({
    id: "user-created",
    displayName: null,
    email: null,
    isNew: true,
  }));
  return {
    store: { getIdentity, resolveOrCreateUser } as unknown as UserStore,
    getIdentity,
    resolveOrCreateUser,
  };
}

describe("resolveServiceActorUser", () => {
  it("resolves a microsoft actor to the user whose identity holds that object id", async () => {
    const { store, getIdentity, resolveOrCreateUser } = users("user-signed-in");
    await expect(
      resolveServiceActorUser(store, actor("microsoft", OBJECT_ID), {
        displayName: "Asserted Name",
        email: "asserted@corp.test",
      })
    ).resolves.toEqual({ kind: "resolved", userId: "user-signed-in" });
    expect(getIdentity).toHaveBeenCalledExactlyOnceWith("microsoft", OBJECT_ID);
    expect(resolveOrCreateUser).not.toHaveBeenCalled();
  });

  it("refuses an unknown microsoft actor without creating a user", async () => {
    const { store, getIdentity, resolveOrCreateUser } = users(null);
    await expect(
      resolveServiceActorUser(store, actor("microsoft", OBJECT_ID), { email: "new@corp.test" })
    ).resolves.toEqual({ kind: "not_enrolled" });
    expect(getIdentity).toHaveBeenCalledExactlyOnceWith("microsoft", OBJECT_ID);
    expect(resolveOrCreateUser).not.toHaveBeenCalled();
  });

  it.each([
    ["slack", "U0123456", "member@corp.test"],
    ["linear", "usr_9", "member@corp.test"],
    ["github", "1001", undefined],
  ] as const)(
    "enrolls a first-contact %s actor with its attested claims",
    async (provider, providerUserId, providerEmail) => {
      const { store, getIdentity, resolveOrCreateUser } = users(null);
      await expect(
        resolveServiceActorUser(store, actor(provider, providerUserId), {
          displayName: "First Contact",
          email: "member@corp.test",
          avatarUrl: "https://avatars.test/1",
        })
      ).resolves.toEqual({ kind: "resolved", userId: "user-created" });
      expect(getIdentity).not.toHaveBeenCalled();
      expect(resolveOrCreateUser).toHaveBeenCalledExactlyOnceWith({
        provider,
        providerUserId,
        displayName: "First Contact",
        providerEmail,
        avatarUrl: "https://avatars.test/1",
      });
    }
  );
});
