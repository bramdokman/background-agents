import { z } from "zod";
import type { AdmissionPolicy, MicrosoftAdmissionEvidence } from "../admission-policy";
import type { ProviderProfile, ProviderTokens } from "../provider-profile";
import { MicrosoftIdTokenVerifier } from "./microsoft-id-token";
import { OAuthProviderError } from "./types";

/**
 * The ID-token claims this deployment reads. `email` and the verification
 * claims are optional claims the administrator adds to the app registration
 * (docs/AUTH.md); a token without them is a configuration gap, not a user.
 * @see https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
 */
const microsoftClaimsSchema = z.object({
  iss: z.url(),
  tid: z.string().min(1),
  oid: z.string().min(1),
  sub: z.string().min(1),
  email: z.email().optional(),
  name: z.string().min(1).optional(),
  picture: z.url().optional(),
  email_verified: z.boolean().optional(),
  xms_edov: z.boolean().optional(),
  verified_primary_email: z.array(z.string()).optional(),
  verified_secondary_email: z.array(z.string()).optional(),
});

type MicrosoftClaims = z.infer<typeof microsoftClaimsSchema>;

/** Verifies the token's signature, audience, issuer tenant and age. */
type VerifyMicrosoftIdToken = (token: string) => Promise<boolean>;

export interface MicrosoftSignInProfileResolverConfig {
  readonly clientId: string;
  readonly tenantId: string;
  readonly admissionPolicy: Pick<AdmissionPolicy, "requireAdmission">;
}

export interface MicrosoftSignInProfileResolverDependencies {
  readonly verifyIdToken?: VerifyMicrosoftIdToken;
}

function decodeJwtPayload(token: string): unknown {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  // JWTs use base64url encoding; atob() requires standard base64 with padding.
  const b64 = segments[1].replaceAll("-", "+").replaceAll("_", "/");
  try {
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
  } catch {
    return null;
  }
}

/**
 * Entra does not attest `email` by itself: the tenant does, through the
 * optional claims. Any one of them proves the address, and `xms_edov` proves
 * the tenant owns its domain, which is what the domain allowlist admits.
 */
function isEmailAttested(claims: MicrosoftClaims, email: string): boolean {
  const listed = (addresses: readonly string[] | undefined) =>
    addresses?.some((address) => address.toLowerCase() === email) ?? false;
  return (
    claims.email_verified === true ||
    claims.xms_edov === true ||
    listed(claims.verified_primary_email) ||
    listed(claims.verified_secondary_email)
  );
}

/**
 * Microsoft Entra ID (single tenant) sign-in evidence.
 *
 * The identity subject is the `oid` claim, the tenant-wide immutable object
 * id, rather than `sub`, which Entra pairs to this application. Teams
 * surfaces the same value as `aadObjectId`, so an identity recorded here is
 * matchable by a bot ingress without a second lookup.
 */
export class MicrosoftSignInProfileResolver {
  private readonly verifyIdToken: VerifyMicrosoftIdToken;

  constructor(
    private readonly config: MicrosoftSignInProfileResolverConfig,
    dependencies: MicrosoftSignInProfileResolverDependencies = {}
  ) {
    // Our own verifier (microsoft-id-token.ts): signature against the
    // tenant's JWKS, audience = client id, issuer = <authority>/<tenant>/v2.0,
    // max age 1h. Better Auth's `microsoft().verifyIdToken` cannot import
    // Microsoft's keys, which carry no `alg`.
    this.verifyIdToken =
      dependencies.verifyIdToken ??
      (() => {
        const verifier = new MicrosoftIdTokenVerifier(config);
        return async (token) => (await verifier.verify(token)) !== false;
      })();
  }

  readonly getUserInfo = async (tokens: ProviderTokens): Promise<ProviderProfile> => {
    if (!tokens.idToken) {
      throw new OAuthProviderError("malformed_response", "Microsoft did not return an ID token");
    }
    if (!(await this.verifyIdToken(tokens.idToken))) {
      throw new OAuthProviderError("malformed_response", "Microsoft returned an invalid ID token");
    }
    const parsedClaims = microsoftClaimsSchema.safeParse(decodeJwtPayload(tokens.idToken));
    if (!parsedClaims.success) {
      throw new OAuthProviderError("malformed_response", "Microsoft returned an invalid ID token");
    }
    const claims = parsedClaims.data;
    const email = claims.email?.toLowerCase();
    if (!email) {
      throw new OAuthProviderError("malformed_response", "Microsoft did not return an email");
    }

    const signIn: MicrosoftAdmissionEvidence = {
      identity: {
        provider: "microsoft",
        issuer: claims.iss,
        subject: claims.oid,
        ...(claims.name ? { displayName: claims.name } : {}),
        ...(claims.picture ? { avatarUrl: claims.picture } : {}),
        verifiedEmails: isEmailAttested(claims, email) ? [email] : [],
        primaryEmail: email,
      },
      tenantId: claims.tid,
    };
    await this.config.admissionPolicy.requireAdmission(signIn);

    // Admission only passes with the email in `verifiedEmails`.
    return {
      user: {
        id: signIn.identity.subject,
        name: signIn.identity.displayName ?? email,
        email,
        ...(signIn.identity.avatarUrl ? { image: signIn.identity.avatarUrl } : {}),
        emailVerified: true,
      },
      data: claims,
    };
  };
}
