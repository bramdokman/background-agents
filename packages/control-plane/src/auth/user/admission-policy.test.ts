import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionDeniedError,
  AdmissionPolicy,
  AdmissionUnavailableError,
  parseAdmissionAllowlist,
  parseAdmissionBoolean,
  type AdmissionPolicyConfig,
  type GitHubAdmissionEvidence,
  type GoogleAdmissionEvidence,
  type MicrosoftAdmissionEvidence,
} from "./admission-policy";

const BASE_CONFIG: AdmissionPolicyConfig = {
  allowedGitHubUsers: [],
  allowedEmails: [],
  allowedEmailDomains: [],
  allowedGitHubOrganizations: [],
  microsoftTenantId: null,
  allowedMicrosoftDomains: [],
  unsafeAllowAllUsers: false,
};

const TENANT_ID = "2f0d9b3a-5c1e-4a7b-9d2c-8e6f1a3b5c7d";
const OTHER_TENANT_ID = "7a1c2e3d-4b5f-4a6c-8d9e-0f1a2b3c4d5e";

const MICROSOFT_SIGN_IN: MicrosoftAdmissionEvidence = {
  identity: {
    provider: "microsoft",
    issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    subject: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    displayName: "Person Example",
    verifiedEmails: ["person@corp.example"],
    primaryEmail: "person@corp.example",
  },
  tenantId: TENANT_ID,
};

const MICROSOFT_CONFIG: AdmissionPolicyConfig = {
  ...BASE_CONFIG,
  microsoftTenantId: TENANT_ID,
  allowedMicrosoftDomains: ["corp.example"],
};

const GOOGLE_SIGN_IN: GoogleAdmissionEvidence = {
  identity: {
    provider: "google",
    issuer: "https://accounts.google.com",
    subject: "google-subject",
    verifiedEmails: ["first@example.net", "allowed@corp.example"],
    primaryEmail: "first@example.net",
  },
};

const GITHUB_SIGN_IN: GitHubAdmissionEvidence = {
  identity: {
    provider: "github",
    issuer: "https://github.com",
    subject: "123",
    login: "octocat",
    verifiedEmails: [],
    primaryEmail: null,
  },
  accessToken: "ghu_token",
};

describe("AdmissionPolicy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("evaluates the complete verified email set with OR semantics", async () => {
    const policy = new AdmissionPolicy({
      ...BASE_CONFIG,
      allowedEmailDomains: ["corp.example"],
    });

    await expect(policy.requireAdmission(GOOGLE_SIGN_IN)).resolves.toEqual({
      reason: "email_domain_allowlist",
    });
  });

  it("admits an active GitHub organization member with the current access token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ state: "active" }));
    const policy = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      { fetcher }
    );

    await expect(policy.requireAdmission(GITHUB_SIGN_IN)).resolves.toEqual({
      reason: "github_organization",
      organization: "open-inspect",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/user/memberships/orgs/open-inspect",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ghu_token" }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("preserves the Worker receiver when using the default global fetch", async () => {
    const runtimeFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(Response.json({ state: "active" }));
    });
    vi.stubGlobal("fetch", runtimeFetch);
    const policy = new AdmissionPolicy({
      ...BASE_CONFIG,
      allowedGitHubOrganizations: ["open-inspect"],
    });

    await expect(policy.requireAdmission(GITHUB_SIGN_IN)).resolves.toEqual({
      reason: "github_organization",
      organization: "open-inspect",
    });
    expect(runtimeFetch).toHaveBeenCalledOnce();
  });

  it("parses deployment admission settings conservatively", () => {
    expect(parseAdmissionAllowlist(" Alice,alice, BOB ,, ")).toEqual(["alice", "bob"]);
    expect(parseAdmissionBoolean(" TRUE ")).toBe(true);
    expect(parseAdmissionBoolean("1")).toBe(false);
    expect(parseAdmissionBoolean(undefined)).toBe(false);
  });

  it("keeps unsafe allow-all limited to an otherwise empty policy", async () => {
    const emptyPolicy = new AdmissionPolicy({
      ...BASE_CONFIG,
      unsafeAllowAllUsers: true,
    });
    await expect(emptyPolicy.requireAdmission(GOOGLE_SIGN_IN)).resolves.toEqual({
      reason: "unsafe_allow_all",
    });

    const configuredPolicy = new AdmissionPolicy({
      ...BASE_CONFIG,
      allowedEmails: ["someone@example.com"],
      unsafeAllowAllUsers: true,
    });
    await expect(configuredPolicy.requireAdmission(GOOGLE_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionDeniedError
    );
  });

  it("does not apply the GitHub username allowlist to another provider", async () => {
    const policy = new AdmissionPolicy({
      ...BASE_CONFIG,
      allowedGitHubUsers: ["google-subject"],
    });

    await expect(policy.requireAdmission(GOOGLE_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionDeniedError
    );
  });

  it("records what a GitHub organization denial was about", async () => {
    const policy = new AdmissionPolicy(
      { ...BASE_CONFIG, allowedGitHubOrganizations: ["open-inspect"] },
      { fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })) }
    );

    await expect(policy.requireAdmission(GITHUB_SIGN_IN)).rejects.toMatchObject({
      name: "AdmissionDeniedError",
      denial: { reason: "no_matching_rule", identity: GITHUB_SIGN_IN.identity },
    });
  });

  it("distinguishes definitive non-membership from an unavailable organization check", async () => {
    const unavailable = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
      }
    );
    await expect(unavailable.requireAdmission(GITHUB_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionUnavailableError
    );

    const denied = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
      }
    );
    await expect(denied.requireAdmission(GITHUB_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionDeniedError
    );

    const pending = new AdmissionPolicy(
      {
        ...BASE_CONFIG,
        allowedGitHubOrganizations: ["open-inspect"],
      },
      {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ state: "pending" })),
      }
    );
    await expect(pending.requireAdmission(GITHUB_SIGN_IN)).rejects.toBeInstanceOf(
      AdmissionDeniedError
    );
  });

  describe("Microsoft Entra ID", () => {
    it("admits a verified email from an allowlisted domain of the configured tenant", async () => {
      const policy = new AdmissionPolicy(MICROSOFT_CONFIG);

      await expect(policy.requireAdmission(MICROSOFT_SIGN_IN)).resolves.toEqual({
        reason: "microsoft_tenant_domain",
        tenantId: TENANT_ID,
        domain: "corp.example",
      });
    });

    it("compares the tenant case-insensitively and admits by provider-neutral rules too", async () => {
      const policy = new AdmissionPolicy({
        ...BASE_CONFIG,
        microsoftTenantId: TENANT_ID.toUpperCase(),
        allowedEmails: ["person@corp.example"],
      });

      await expect(policy.requireAdmission(MICROSOFT_SIGN_IN)).resolves.toEqual({
        reason: "email_allowlist",
      });
    });

    it("denies a non-allowlisted domain from the configured tenant", async () => {
      const policy = new AdmissionPolicy(MICROSOFT_CONFIG);
      const signIn: MicrosoftAdmissionEvidence = {
        ...MICROSOFT_SIGN_IN,
        identity: {
          ...MICROSOFT_SIGN_IN.identity,
          verifiedEmails: ["person@other.example"],
          primaryEmail: "person@other.example",
        },
      };

      await expect(policy.requireAdmission(signIn)).rejects.toMatchObject({
        name: "AdmissionDeniedError",
        denial: { reason: "microsoft_domain_not_allowed", tenantId: TENANT_ID },
      });
    });

    it("denies another tenant even when the domain is allowlisted", async () => {
      const policy = new AdmissionPolicy({
        ...MICROSOFT_CONFIG,
        allowedEmailDomains: ["corp.example"],
      });

      await expect(
        policy.requireAdmission({ ...MICROSOFT_SIGN_IN, tenantId: OTHER_TENANT_ID })
      ).rejects.toMatchObject({
        name: "AdmissionDeniedError",
        denial: { reason: "microsoft_tenant_mismatch", tenantId: OTHER_TENANT_ID },
      });
    });

    it("denies an unattested email even from the configured tenant", async () => {
      const policy = new AdmissionPolicy(MICROSOFT_CONFIG);

      await expect(
        policy.requireAdmission({
          ...MICROSOFT_SIGN_IN,
          identity: { ...MICROSOFT_SIGN_IN.identity, verifiedEmails: [] },
        })
      ).rejects.toMatchObject({
        name: "AdmissionDeniedError",
        denial: { reason: "microsoft_email_unverified" },
      });
    });

    it("keeps the tenant and verification gates ahead of unsafe allow-all", async () => {
      const policy = new AdmissionPolicy({
        ...BASE_CONFIG,
        microsoftTenantId: TENANT_ID,
        unsafeAllowAllUsers: true,
      });

      await expect(policy.requireAdmission(MICROSOFT_SIGN_IN)).resolves.toEqual({
        reason: "unsafe_allow_all",
      });
      await expect(
        policy.requireAdmission({ ...MICROSOFT_SIGN_IN, tenantId: OTHER_TENANT_ID })
      ).rejects.toBeInstanceOf(AdmissionDeniedError);
      await expect(
        policy.requireAdmission({
          ...MICROSOFT_SIGN_IN,
          identity: { ...MICROSOFT_SIGN_IN.identity, verifiedEmails: [] },
        })
      ).rejects.toBeInstanceOf(AdmissionDeniedError);
    });

    it("does not apply the Microsoft domain allowlist to another provider", async () => {
      const policy = new AdmissionPolicy({
        ...MICROSOFT_CONFIG,
        allowedMicrosoftDomains: ["example.net"],
      });

      await expect(policy.requireAdmission(GOOGLE_SIGN_IN)).rejects.toBeInstanceOf(
        AdmissionDeniedError
      );
      expect(policy.supportsSignInProvider("google")).toBe(false);
      expect(policy.supportsSignInProvider("microsoft")).toBe(true);
    });
  });
});
