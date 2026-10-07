import { describe, expect, it, vi } from "vitest";
import type { AdmissionPolicy } from "../admission-policy";
import { MicrosoftSignInProfileResolver } from "./microsoft-profile";

const TENANT_ID = "2f0d9b3a-5c1e-4a7b-9d2c-8e6f1a3b5c7d";
const OBJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

function unsignedIdToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=+$/, "");
  return `${encode({ alg: "RS256", kid: "test" })}.${encode(claims)}.signature`;
}

const BASE_CLAIMS = {
  iss: ISSUER,
  tid: TENANT_ID,
  oid: OBJECT_ID,
  sub: "pairwise-subject",
  email: "Person@Corp.Example",
  name: "Person Example",
  picture: "https://example.com/avatar.png",
};

function resolver(
  requireAdmission: AdmissionPolicy["requireAdmission"] = vi.fn(async () => ({
    reason: "unsafe_allow_all" as const,
  }))
) {
  const verifyIdToken = vi.fn(async () => true);
  return {
    requireAdmission,
    verifyIdToken,
    resolver: new MicrosoftSignInProfileResolver(
      {
        clientId: "microsoft-client-id",
        tenantId: TENANT_ID,
        admissionPolicy: { requireAdmission },
      },
      { verifyIdToken }
    ),
  };
}

describe("MicrosoftSignInProfileResolver", () => {
  it("verifies the ID token, admits on tenant evidence, and records the object id", async () => {
    const {
      resolver: profile,
      requireAdmission,
      verifyIdToken,
    } = resolver(
      vi.fn(async () => ({
        reason: "microsoft_tenant_domain" as const,
        tenantId: TENANT_ID,
        domain: "corp.example",
      }))
    );
    const idToken = unsignedIdToken({ ...BASE_CLAIMS, xms_edov: true });

    const result = await profile.getUserInfo({ idToken });

    expect(verifyIdToken).toHaveBeenCalledWith(idToken);
    expect(requireAdmission).toHaveBeenCalledWith({
      identity: {
        provider: "microsoft",
        issuer: ISSUER,
        subject: OBJECT_ID,
        displayName: "Person Example",
        avatarUrl: "https://example.com/avatar.png",
        verifiedEmails: ["person@corp.example"],
        primaryEmail: "person@corp.example",
      },
      tenantId: TENANT_ID,
    });
    expect(result.user).toEqual({
      id: OBJECT_ID,
      name: "Person Example",
      email: "person@corp.example",
      image: "https://example.com/avatar.png",
      emailVerified: true,
    });
  });

  it.each([
    ["email_verified", { email_verified: true }],
    ["verified_primary_email", { verified_primary_email: ["person@corp.example"] }],
    ["verified_secondary_email", { verified_secondary_email: ["PERSON@corp.example"] }],
  ])("treats the %s claim as attesting the email", async (_claim, attestation) => {
    const { resolver: profile, requireAdmission } = resolver();

    await profile.getUserInfo({ idToken: unsignedIdToken({ ...BASE_CLAIMS, ...attestation }) });

    expect(requireAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ verifiedEmails: ["person@corp.example"] }),
      })
    );
  });

  it("hands an unattested email to admission as unverified evidence", async () => {
    const { resolver: profile, requireAdmission } = resolver();

    await profile.getUserInfo({
      idToken: unsignedIdToken({ ...BASE_CLAIMS, verified_primary_email: ["other@corp.example"] }),
    });

    expect(requireAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          verifiedEmails: [],
          primaryEmail: "person@corp.example",
        }),
      })
    );
  });

  it("propagates an admission denial unchanged", async () => {
    const denial = new Error("denied");
    const { resolver: profile } = resolver(vi.fn(async () => Promise.reject(denial)));

    await expect(
      profile.getUserInfo({ idToken: unsignedIdToken({ ...BASE_CLAIMS, xms_edov: true }) })
    ).rejects.toBe(denial);
  });

  it("rejects an unverifiable ID token before admission", async () => {
    const requireAdmission = vi.fn();
    const profile = new MicrosoftSignInProfileResolver(
      {
        clientId: "microsoft-client-id",
        tenantId: TENANT_ID,
        admissionPolicy: { requireAdmission },
      },
      { verifyIdToken: vi.fn(async () => false) }
    );

    await expect(
      profile.getUserInfo({ idToken: unsignedIdToken(BASE_CLAIMS) })
    ).rejects.toMatchObject({ name: "OAuthProviderError", failure: "malformed_response" });
    expect(requireAdmission).not.toHaveBeenCalled();
  });

  it.each([
    ["no ID token", undefined],
    ["a token without the object id", unsignedIdToken({ ...BASE_CLAIMS, oid: undefined })],
    ["a token without an email", unsignedIdToken({ ...BASE_CLAIMS, email: undefined })],
    ["a token that is not a JWT", "not-a-jwt"],
  ])("rejects %s before admission", async (_case, idToken) => {
    const { resolver: profile, requireAdmission } = resolver();

    await expect(profile.getUserInfo({ idToken })).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
    expect(requireAdmission).not.toHaveBeenCalled();
  });
});
