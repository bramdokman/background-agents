import type { SignInProvider } from "@open-inspect/shared/sign-in-provider";
import type { SqlDatabase } from "./sql-database";

export const SIGN_IN_DENIED_ACTION = "auth.sign_in_denied";

export interface SignInDenialAuditInput {
  readonly provider: SignInProvider;
  /** An `AdmissionDenialReason` (auth/user/admission-policy.ts). */
  readonly reasonCode: string;
  /** The verified evidence that was denied: identifiers, never tokens or full emails. */
  readonly evidence: {
    readonly issuer: string;
    readonly subject: string;
    readonly tenantId?: string;
    readonly emailDomains: readonly string[];
  };
}

/**
 * Durable record of an admission denial at the OAuth callback. The person
 * has no user row yet, so the row names no actor; the provider is the
 * resource and the evidence is the metadata, so an operator can tell a
 * wrong tenant from a missing domain allowlist entry without the logs.
 */
export class SignInAuditStore {
  constructor(private readonly db: SqlDatabase) {}

  async writeDenied(input: SignInDenialAuditInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
           actor_service_snapshot, action, resource_type, resource_id,
           target_user_id_snapshot, reason_code, operation_result, metadata_json)
         VALUES (?, ?, ?, 'user', NULL, NULL, ?, 'sign_in', ?, NULL, ?, 'denied', ?)`
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        crypto.randomUUID(),
        SIGN_IN_DENIED_ACTION,
        input.provider,
        input.reasonCode,
        JSON.stringify({
          before: {},
          requested: { provider: input.provider, ...input.evidence },
          after: {},
        })
      )
      .run();
  }
}
