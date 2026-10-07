import { z } from "zod";
import type { SignInProvider } from "@open-inspect/shared/sign-in-provider";
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } from "./providers/constants";
import type { VerifiedProviderIdentity } from "./providers/types";

export interface GitHubAdmissionEvidence {
  readonly identity: VerifiedProviderIdentity<"github">;
  readonly accessToken: string;
}

export interface GoogleAdmissionEvidence {
  readonly identity: VerifiedProviderIdentity<"google">;
}

/**
 * A Microsoft Entra ID sign-in: the identity's `verifiedEmails` holds the
 * token's email only when the tenant attests it (see `microsoft-profile.ts`),
 * and `tenantId` is the verified `tid` claim. Both are admission gates that
 * no allowlist, nor `UNSAFE_ALLOW_ALL_USERS`, bypasses.
 */
export interface MicrosoftAdmissionEvidence {
  readonly identity: VerifiedProviderIdentity<"microsoft">;
  readonly tenantId: string;
}

export type VerifiedProviderSignIn =
  GitHubAdmissionEvidence | GoogleAdmissionEvidence | MicrosoftAdmissionEvidence;

export interface AdmissionPolicyConfig {
  readonly allowedGitHubUsers: readonly string[];
  readonly allowedEmails: readonly string[];
  readonly allowedEmailDomains: readonly string[];
  readonly allowedGitHubOrganizations: readonly string[];
  /** The one Entra tenant Microsoft sign-ins may come from; null when the provider is off. */
  readonly microsoftTenantId: string | null;
  /** Verified email domains admitted from that tenant through Microsoft sign-in only. */
  readonly allowedMicrosoftDomains: readonly string[];
  readonly unsafeAllowAllUsers: boolean;
}

export type AdmissionDecision =
  | { readonly reason: "unsafe_allow_all" }
  | { readonly reason: "github_user_allowlist" }
  | { readonly reason: "email_allowlist" }
  | { readonly reason: "email_domain_allowlist" }
  | { readonly reason: "github_organization"; readonly organization: string }
  | {
      readonly reason: "microsoft_tenant_domain";
      readonly tenantId: string;
      readonly domain: string;
    };

export type AdmissionDenialReason =
  | "no_matching_rule"
  | "microsoft_tenant_mismatch"
  | "microsoft_email_unverified"
  | "microsoft_domain_not_allowed";

/** What was denied, for the audit row: the verified evidence, never the token. */
export interface AdmissionDenial {
  readonly reason: AdmissionDenialReason;
  readonly identity: VerifiedProviderIdentity;
  readonly tenantId?: string;
}

export interface AdmissionPolicyDependencies {
  readonly fetcher?: typeof fetch;
}

export class AdmissionDeniedError extends Error {
  constructor(readonly denial: AdmissionDenial | null = null) {
    super("User is not admitted by this deployment");
    this.name = "AdmissionDeniedError";
  }
}

export class AdmissionUnavailableError extends Error {
  constructor() {
    super("Admission policy could not be evaluated");
    this.name = "AdmissionUnavailableError";
  }
}

const membershipSchema = z.object({
  state: z.enum(["active", "pending"]),
});

function normalize(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export function parseAdmissionAllowlist(value: string | undefined): string[] {
  return normalize(value?.split(",") ?? []);
}

export function parseAdmissionBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function emailDomain(email: string): string | null {
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return null;
  return email.slice(separator + 1).toLowerCase();
}

function isGitHubSignIn(signIn: VerifiedProviderSignIn): signIn is GitHubAdmissionEvidence {
  return signIn.identity.provider === "github";
}

function isMicrosoftSignIn(signIn: VerifiedProviderSignIn): signIn is MicrosoftAdmissionEvidence {
  return signIn.identity.provider === "microsoft";
}

function denied(signIn: VerifiedProviderSignIn, reason: AdmissionDenialReason): never {
  throw new AdmissionDeniedError({
    reason,
    identity: signIn.identity,
    ...(isMicrosoftSignIn(signIn) ? { tenantId: signIn.tenantId } : {}),
  });
}

export class AdmissionPolicy {
  private readonly config: AdmissionPolicyConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: AdmissionPolicyConfig, dependencies: AdmissionPolicyDependencies = {}) {
    this.config = {
      allowedGitHubUsers: normalize(config.allowedGitHubUsers),
      allowedEmails: normalize(config.allowedEmails),
      allowedEmailDomains: normalize(config.allowedEmailDomains),
      allowedGitHubOrganizations: normalize(config.allowedGitHubOrganizations),
      microsoftTenantId: config.microsoftTenantId?.trim().toLowerCase() || null,
      allowedMicrosoftDomains: normalize(config.allowedMicrosoftDomains),
      unsafeAllowAllUsers: config.unsafeAllowAllUsers,
    };
    this.fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  supportsSignInProvider(provider: SignInProvider): boolean {
    const hasProviderNeutralAdmission =
      this.config.allowedEmails.length > 0 || this.config.allowedEmailDomains.length > 0;
    const hasGitHubAdmission =
      this.config.allowedGitHubUsers.length > 0 ||
      this.config.allowedGitHubOrganizations.length > 0;
    const hasMicrosoftAdmission = this.config.allowedMicrosoftDomains.length > 0;
    const hasConfiguredAllowlist =
      hasProviderNeutralAdmission || hasGitHubAdmission || hasMicrosoftAdmission;

    if (!hasConfiguredAllowlist && this.config.unsafeAllowAllUsers) return true;
    const providerSupport: Readonly<Record<SignInProvider, boolean>> = {
      github: hasProviderNeutralAdmission || hasGitHubAdmission,
      google: hasProviderNeutralAdmission,
      microsoft: hasProviderNeutralAdmission || hasMicrosoftAdmission,
    };
    return providerSupport[provider];
  }

  async requireAdmission(signIn: VerifiedProviderSignIn): Promise<AdmissionDecision> {
    // The tenant and verification gates precede every allowlist, including
    // the unsafe allow-all: a Microsoft identity from another tenant, or
    // without an attested email, is never this deployment's user.
    if (isMicrosoftSignIn(signIn)) this.requireMicrosoftTenant(signIn);

    const hasConfiguredAllowlist =
      this.config.allowedGitHubUsers.length > 0 ||
      this.config.allowedEmails.length > 0 ||
      this.config.allowedEmailDomains.length > 0 ||
      this.config.allowedGitHubOrganizations.length > 0 ||
      this.config.allowedMicrosoftDomains.length > 0;
    if (!hasConfiguredAllowlist && this.config.unsafeAllowAllUsers) {
      return { reason: "unsafe_allow_all" };
    }

    if (
      isGitHubSignIn(signIn) &&
      signIn.identity.login &&
      this.config.allowedGitHubUsers.includes(signIn.identity.login.toLowerCase())
    ) {
      return { reason: "github_user_allowlist" };
    }

    const emails = normalize(signIn.identity.verifiedEmails);
    if (emails.some((email) => this.config.allowedEmails.includes(email))) {
      return { reason: "email_allowlist" };
    }
    if (
      emails.some((email) => {
        const domain = emailDomain(email);
        return domain !== null && this.config.allowedEmailDomains.includes(domain);
      })
    ) {
      return { reason: "email_domain_allowlist" };
    }

    if (isGitHubSignIn(signIn) && this.config.allowedGitHubOrganizations.length > 0) {
      return this.requireGitHubOrganization(signIn);
    }
    if (isMicrosoftSignIn(signIn)) {
      const domain = emails
        .map(emailDomain)
        .find(
          (candidate) =>
            candidate !== null && this.config.allowedMicrosoftDomains.includes(candidate)
        );
      if (domain) return { reason: "microsoft_tenant_domain", tenantId: signIn.tenantId, domain };
      denied(signIn, "microsoft_domain_not_allowed");
    }
    denied(signIn, "no_matching_rule");
  }

  private requireMicrosoftTenant(signIn: MicrosoftAdmissionEvidence): void {
    if (
      this.config.microsoftTenantId === null ||
      signIn.tenantId.toLowerCase() !== this.config.microsoftTenantId
    ) {
      denied(signIn, "microsoft_tenant_mismatch");
    }
    if (signIn.identity.verifiedEmails.length === 0) {
      denied(signIn, "microsoft_email_unverified");
    }
  }

  private async requireGitHubOrganization(
    signIn: GitHubAdmissionEvidence
  ): Promise<AdmissionDecision> {
    const accessToken = signIn.accessToken;
    let unavailable = false;

    for (const organization of this.config.allowedGitHubOrganizations) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
      try {
        const response = await this.fetcher(
          `https://api.github.com/user/memberships/orgs/${encodeURIComponent(organization)}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "Open-Inspect-Control-Plane",
            },
            signal: controller.signal,
          }
        );
        if (response.status === 404) continue;
        if (!response.ok) {
          unavailable = true;
          continue;
        }
        const parsed = membershipSchema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) {
          unavailable = true;
          continue;
        }
        if (parsed.data.state === "active") {
          return { reason: "github_organization", organization };
        }
      } catch {
        unavailable = true;
      } finally {
        clearTimeout(timer);
      }
    }

    if (unavailable) throw new AdmissionUnavailableError();
    denied(signIn, "no_matching_rule");
  }
}
