import type { SignInProvider } from "@open-inspect/shared/sign-in-provider";
import { createLogger } from "../../logger";
import type { SignInAuditStore } from "../../db/sign-in-audit-store";
import { AdmissionDeniedError, type AdmissionDenial } from "./admission-policy";
import type { ProviderProfileResolver } from "./provider-profile";

const logger = createLogger("auth:admission-audit");

function emailDomains(emails: readonly string[]): string[] {
  return [...new Set(emails.map((email) => email.slice(email.lastIndexOf("@") + 1)))];
}

/**
 * Decorator around the provider profile resolvers that records every
 * admission denial as an audit event before the error continues to Better
 * Auth. Admitted sign-ins and provider failures pass through untouched; a
 * failed audit write is logged and never changes the sign-in outcome.
 */
export class AdmissionAudit {
  constructor(private readonly store: SignInAuditStore) {}

  wrapResolver(provider: SignInProvider, inner: ProviderProfileResolver): ProviderProfileResolver {
    return async (tokens) => {
      try {
        return await inner(tokens);
      } catch (error) {
        if (error instanceof AdmissionDeniedError && error.denial) {
          await this.record(provider, error.denial);
        }
        throw error;
      }
    };
  }

  private async record(provider: SignInProvider, denial: AdmissionDenial): Promise<void> {
    const evidence = {
      issuer: denial.identity.issuer,
      subject: denial.identity.subject,
      ...(denial.tenantId ? { tenantId: denial.tenantId } : {}),
      emailDomains: emailDomains(denial.identity.verifiedEmails),
    };
    try {
      await this.store.writeDenied({ provider, reasonCode: denial.reason, evidence });
      logger.warn("Sign-in denied by admission policy", {
        event: "auth.sign_in_denied",
        provider,
        reason: denial.reason,
        ...evidence,
      });
    } catch (error) {
      logger.error("Sign-in denial audit failed", {
        event: "auth.sign_in_denial_audit_failed",
        provider,
        reason: denial.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
