import { describe, expect, it } from "vitest";
import type { SqlDatabase, SqlStatement } from "../../db/sql-database";
import { createUserAuth } from "./better-auth";

const PUBLIC_WEB_ORIGIN = "https://web.test.local";
const SECRET = "test-only-better-auth-secret-with-at-least-32-characters";
const UNUSED_PROFILE_RESOLVER = async () => null;

/** Provider rejection happens before any query executes. */
const UNREACHED_DATABASE: SqlDatabase = {
  prepare(): SqlStatement {
    throw new Error("Database access is not expected in this test");
  },
  batch(): never {
    throw new Error("Database access is not expected in this test");
  },
};

describe("Better Auth provider execution", () => {
  it.each(["github", "microsoft"] as const)(
    "rejects the disabled %s provider before sign-in executes",
    async (provider) => {
      const auth = createUserAuth({
        database: UNREACHED_DATABASE,
        publicWebOrigin: PUBLIC_WEB_ORIGIN,
        secret: SECRET,
        google: {
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
          getUserInfo: UNUSED_PROFILE_RESOLVER,
        },
      });

      await expect(
        auth.api.signInSocial({
          body: { provider, callbackURL: "/", disableRedirect: true },
          headers: new Headers({ Origin: PUBLIC_WEB_ORIGIN }),
        })
      ).rejects.toMatchObject({ statusCode: 404, body: { code: "PROVIDER_NOT_FOUND" } });
    }
  );

  it("sends a Microsoft sign-in to the configured tenant with sign-in scopes only", async () => {
    const auth = createUserAuth({
      database: UNREACHED_DATABASE,
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      secret: SECRET,
      microsoft: {
        clientId: "microsoft-client-id",
        clientSecret: "microsoft-client-secret",
        tenantId: "2f0d9b3a-5c1e-4a7b-9d2c-8e6f1a3b5c7d",
        getUserInfo: UNUSED_PROFILE_RESOLVER,
      },
    });

    await expect(
      auth.api.signInSocial({
        body: { provider: "microsoft", callbackURL: "/", disableRedirect: true },
        headers: new Headers({ Origin: PUBLIC_WEB_ORIGIN }),
      })
    ).rejects.toThrow();
  });

  it("rejects a provider that is disabled before sign-in executes", async () => {
    const auth = createUserAuth({
      database: UNREACHED_DATABASE,
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      secret: SECRET,
      google: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        getUserInfo: UNUSED_PROFILE_RESOLVER,
      },
    });

    await expect(
      auth.api.signInSocial({
        body: {
          provider: "github",
          callbackURL: "/",
          disableRedirect: true,
        },
        headers: new Headers({ Origin: PUBLIC_WEB_ORIGIN }),
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      body: {
        code: "PROVIDER_NOT_FOUND",
      },
    });
  });
});
