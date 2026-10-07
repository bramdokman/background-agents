import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../../node/sqlite-database";
import { SignInAuditStore } from "../../db/sign-in-audit-store";
import { AdmissionAudit } from "./admission-audit";
import { AdmissionDeniedError, type AdmissionDenial } from "./admission-policy";
import { OAuthProviderError } from "./providers/types";

const TENANT_ID = "2f0d9b3a-5c1e-4a7b-9d2c-8e6f1a3b5c7d";

const MICROSOFT_DENIAL: AdmissionDenial = {
  reason: "microsoft_domain_not_allowed",
  identity: {
    provider: "microsoft",
    issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    subject: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    verifiedEmails: ["person@other.example"],
    primaryEmail: "person@other.example",
  },
  tenantId: TENANT_ID,
};

interface AuditRow {
  action: string;
  principal_kind: string;
  actor_user_id_snapshot: string | null;
  resource_type: string;
  resource_id: string;
  reason_code: string;
  operation_result: string;
  metadata_json: string;
}

describe("AdmissionAudit", () => {
  let db: NodeSqlDatabase;
  let audit: AdmissionAudit;

  beforeEach(() => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    audit = new AdmissionAudit(new SignInAuditStore(db));
  });
  afterEach(() => db.close());

  async function auditRows(): Promise<AuditRow[]> {
    const result = await db
      .prepare(
        `SELECT action, principal_kind, actor_user_id_snapshot, resource_type, resource_id,
                reason_code, operation_result, metadata_json
         FROM authorization_audit_events WHERE action = 'auth.sign_in_denied'`
      )
      .all<AuditRow>();
    return result.results ?? [];
  }

  it("records a denial with its reason and evidence, then rethrows it", async () => {
    const denial = new AdmissionDeniedError(MICROSOFT_DENIAL);
    const resolver = audit.wrapResolver("microsoft", async () => Promise.reject(denial));

    await expect(resolver({ idToken: "id-token" })).rejects.toBe(denial);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "auth.sign_in_denied",
      principal_kind: "user",
      actor_user_id_snapshot: null,
      resource_type: "sign_in",
      resource_id: "microsoft",
      reason_code: "microsoft_domain_not_allowed",
      operation_result: "denied",
    });
    expect(JSON.parse(rows[0].metadata_json)).toEqual({
      before: {},
      requested: {
        provider: "microsoft",
        issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
        subject: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        tenantId: TENANT_ID,
        emailDomains: ["other.example"],
      },
      after: {},
    });
  });

  it("records a GitHub denial with the same shape and no tenant", async () => {
    const resolver = audit.wrapResolver("github", async () =>
      Promise.reject(
        new AdmissionDeniedError({
          reason: "no_matching_rule",
          identity: {
            provider: "github",
            issuer: "https://github.com",
            subject: "583231",
            login: "octocat",
            verifiedEmails: ["octocat@example.com"],
            primaryEmail: "octocat@example.com",
          },
        })
      )
    );

    await expect(resolver({ accessToken: "token" })).rejects.toBeInstanceOf(AdmissionDeniedError);

    const [row] = await auditRows();
    expect(row).toMatchObject({ resource_id: "github", reason_code: "no_matching_rule" });
    expect(JSON.parse(row.metadata_json).requested).toEqual({
      provider: "github",
      issuer: "https://github.com",
      subject: "583231",
      emailDomains: ["example.com"],
    });
  });

  it("writes nothing for an admitted sign-in or a provider failure", async () => {
    const profile = {
      user: { id: "subject", name: "Person", email: "person@corp.example", emailVerified: true },
      data: {},
    };
    await expect(
      audit.wrapResolver("microsoft", async () => profile)({ idToken: "id-token" })
    ).resolves.toBe(profile);

    const failure = new OAuthProviderError("malformed_response", "no token");
    await expect(
      audit.wrapResolver("microsoft", async () => Promise.reject(failure))({})
    ).rejects.toBe(failure);

    expect(await auditRows()).toEqual([]);
  });

  it("keeps the denial when the audit write itself fails", async () => {
    const store = { writeDenied: vi.fn(async () => Promise.reject(new Error("db down"))) };
    const denial = new AdmissionDeniedError(MICROSOFT_DENIAL);
    const resolver = new AdmissionAudit(store as unknown as SignInAuditStore).wrapResolver(
      "microsoft",
      async () => Promise.reject(denial)
    );

    await expect(resolver({ idToken: "id-token" })).rejects.toBe(denial);
    expect(store.writeDenied).toHaveBeenCalledOnce();
  });
});
