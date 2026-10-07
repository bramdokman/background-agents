import {
  AdmissionPolicy,
  parseAdmissionAllowlist,
  parseAdmissionBoolean,
  type AdmissionPolicyConfig,
} from "./admission-policy";
import {
  SIGN_IN_PROVIDERS,
  SIGN_IN_PROVIDER_ISSUERS,
  type SignInProvider,
} from "@open-inspect/shared/sign-in-provider";
import {
  createUserAuth,
  type MicrosoftProviderAuthConfig,
  type SocialProviderAuthConfig,
} from "./better-auth";
import { GitHubProviderIdentityResolver } from "./providers/github-identity";
import { GitHubSignInProfileResolver } from "./providers/github-profile";
import { GoogleSignInProfileResolver } from "./providers/google-profile";
import { MicrosoftSignInProfileResolver } from "./providers/microsoft-profile";
import { AdmissionAudit } from "./admission-audit";
import { SignInClaim } from "./sign-in-claim";
import { IdentityClaimStore } from "../../db/identity-claim-store";
import { SignInAuditStore } from "../../db/sign-in-audit-store";
import type { SqlDatabase } from "../../db/sql-database";
import type { Env } from "../../types";

const MINIMUM_SECRET_LENGTH = 32;
/** Entra tenant ids are GUIDs; the `tid` claim is compared against this form. */
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class UserAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserAuthConfigurationError";
  }
}

function requireConfig(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new UserAuthConfigurationError(`${name} is not configured`);
  }
  return normalized;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function parsePublicWebOrigin(value: string | undefined): string {
  const configured = requireConfig(value, "WEB_APP_URL");
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new UserAuthConfigurationError("WEB_APP_URL is invalid");
  }

  const isOriginOnly =
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  const isSecure = url.protocol === "https:";
  const isLocalDevelopment = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!isOriginOnly || (!isSecure && !isLocalDevelopment)) {
    throw new UserAuthConfigurationError(
      "WEB_APP_URL must be an HTTPS origin or an HTTP loopback origin"
    );
  }
  return url.origin;
}

interface OAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

interface MicrosoftCredentials extends OAuthCredentials {
  readonly tenantId: string;
}

interface ProviderCredentials {
  readonly github: OAuthCredentials | null;
  readonly google: OAuthCredentials | null;
  readonly microsoft: MicrosoftCredentials | null;
}

interface NormalizedUserAuthConfig {
  readonly publicWebOrigin: string;
  readonly secret: string;
  readonly appName: string;
  readonly admission: AdmissionPolicyConfig;
  readonly providers: ProviderCredentials;
}

function normalizeProviderCredentials(
  id: SignInProvider,
  clientIdValue: string | undefined,
  clientSecretValue: string | undefined
): OAuthCredentials | null {
  const clientId = clientIdValue?.trim();
  const clientSecret = clientSecretValue?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    const prefix = id.toUpperCase();
    throw new UserAuthConfigurationError(
      `${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must be configured together`
    );
  }
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * The Microsoft provider is single-tenant by construction: the tenant selects
 * the token endpoints and is the one `tid` admission accepts, so it is
 * required alongside the client pair rather than defaulting to `common`.
 */
function normalizeMicrosoftCredentials(env: Env): MicrosoftCredentials | null {
  const clientId = env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = env.MICROSOFT_CLIENT_SECRET?.trim();
  const tenantId = env.MICROSOFT_TENANT_ID?.trim().toLowerCase();
  if (!clientId && !clientSecret && !tenantId) return null;
  if (!clientId || !clientSecret || !tenantId) {
    throw new UserAuthConfigurationError(
      "MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_TENANT_ID must be configured together"
    );
  }
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new UserAuthConfigurationError("MICROSOFT_TENANT_ID must be the tenant's GUID");
  }
  return { clientId, clientSecret, tenantId };
}

function normalizeUserAuthConfig(env: Env): NormalizedUserAuthConfig {
  const secret = requireConfig(env.BROWSER_AUTH_SECRET, "BROWSER_AUTH_SECRET");
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new UserAuthConfigurationError(
      `BROWSER_AUTH_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters`
    );
  }

  const providers: ProviderCredentials = Object.freeze({
    github: normalizeProviderCredentials("github", env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    google: normalizeProviderCredentials("google", env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    microsoft: normalizeMicrosoftCredentials(env),
  });
  if (!SIGN_IN_PROVIDERS.some((provider) => providers[provider] !== null)) {
    throw new UserAuthConfigurationError(
      "At least one sign-in provider must be configured: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET and MICROSOFT_TENANT_ID"
    );
  }

  return {
    publicWebOrigin: parsePublicWebOrigin(env.WEB_APP_URL),
    secret,
    appName: env.APP_NAME?.trim() || "Open-Inspect",
    admission: {
      allowedGitHubUsers: parseAdmissionAllowlist(env.ALLOWED_USERS),
      allowedEmails: parseAdmissionAllowlist(env.ALLOWED_EMAILS),
      allowedEmailDomains: parseAdmissionAllowlist(env.ALLOWED_EMAIL_DOMAINS),
      allowedGitHubOrganizations: parseAdmissionAllowlist(env.ALLOWED_GITHUB_ORGS),
      microsoftTenantId: providers.microsoft?.tenantId ?? null,
      allowedMicrosoftDomains: parseAdmissionAllowlist(env.MICROSOFT_ALLOWED_DOMAINS),
      unsafeAllowAllUsers: parseAdmissionBoolean(env.UNSAFE_ALLOW_ALL_USERS),
    },
    providers,
  };
}

const UNSUPPORTED_ADMISSION_MESSAGE: Readonly<Record<SignInProvider, string>> = {
  github:
    "GitHub sign-in has no compatible admission policy; configure a GitHub-specific or provider-neutral admission rule, or UNSAFE_ALLOW_ALL_USERS",
  google:
    "Google sign-in requires provider-neutral admission through ALLOWED_EMAILS, ALLOWED_EMAIL_DOMAINS, or UNSAFE_ALLOW_ALL_USERS",
  microsoft:
    "Microsoft sign-in requires MICROSOFT_ALLOWED_DOMAINS, or provider-neutral admission through ALLOWED_EMAILS, ALLOWED_EMAIL_DOMAINS, or UNSAFE_ALLOW_ALL_USERS",
};

function requireProviderAdmission(
  admissionPolicy: AdmissionPolicy,
  provider: SignInProvider
): void {
  if (!admissionPolicy.supportsSignInProvider(provider)) {
    throw new UserAuthConfigurationError(UNSUPPORTED_ADMISSION_MESSAGE[provider]);
  }
}

function createGitHubAuthConfig(
  credentials: OAuthCredentials | null,
  appName: string,
  admissionPolicy: AdmissionPolicy
): SocialProviderAuthConfig | undefined {
  if (!credentials) return undefined;
  requireProviderAdmission(admissionPolicy, "github");

  const profile = new GitHubSignInProfileResolver({
    identityResolver: new GitHubProviderIdentityResolver({
      issuer: SIGN_IN_PROVIDER_ISSUERS.github,
      userAgent: `${appName} Control Plane`,
    }),
    admissionPolicy,
  });
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    getUserInfo: profile.getUserInfo,
  };
}

function createGoogleAuthConfig(
  credentials: OAuthCredentials | null,
  admissionPolicy: AdmissionPolicy
): SocialProviderAuthConfig | undefined {
  if (!credentials) return undefined;
  requireProviderAdmission(admissionPolicy, "google");

  const profile = new GoogleSignInProfileResolver({
    clientId: credentials.clientId,
    admissionPolicy,
  });
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    getUserInfo: profile.getUserInfo,
  };
}

function createMicrosoftAuthConfig(
  credentials: MicrosoftCredentials | null,
  admissionPolicy: AdmissionPolicy
): MicrosoftProviderAuthConfig | undefined {
  if (!credentials) return undefined;
  requireProviderAdmission(admissionPolicy, "microsoft");

  const profile = new MicrosoftSignInProfileResolver({
    clientId: credentials.clientId,
    tenantId: credentials.tenantId,
    admissionPolicy,
  });
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    tenantId: credentials.tenantId,
    getUserInfo: profile.getUserInfo,
  };
}

interface ResolverDecorators {
  readonly claim: SignInClaim;
  readonly audit: AdmissionAudit;
}

/** Audit sits inside the claim: a denial is recorded, and nothing is claimed. */
function decorateResolver<Config extends SocialProviderAuthConfig>(
  provider: SignInProvider,
  { claim, audit }: ResolverDecorators,
  config: Config | undefined
): Config | undefined {
  if (!config) return undefined;
  return {
    ...config,
    getUserInfo: claim.wrapResolver(provider, audit.wrapResolver(provider, config.getUserInfo)),
  };
}

function createUserAuthRuntime(
  config: NormalizedUserAuthConfig,
  database: SqlDatabase
): UserAuthRuntime {
  const admissionPolicy = new AdmissionPolicy(config.admission);
  const decorators: ResolverDecorators = {
    claim: new SignInClaim(new IdentityClaimStore(database)),
    audit: new AdmissionAudit(new SignInAuditStore(database)),
  };
  const github = decorateResolver(
    "github",
    decorators,
    createGitHubAuthConfig(config.providers.github, config.appName, admissionPolicy)
  );
  const google = decorateResolver(
    "google",
    decorators,
    createGoogleAuthConfig(config.providers.google, admissionPolicy)
  );
  const microsoft = decorateResolver(
    "microsoft",
    decorators,
    createMicrosoftAuthConfig(config.providers.microsoft, admissionPolicy)
  );

  const auth = createUserAuth({
    database,
    publicWebOrigin: config.publicWebOrigin,
    secret: config.secret,
    ...(github ? { github } : {}),
    ...(google ? { google } : {}),
    ...(microsoft ? { microsoft } : {}),
  });
  return {
    auth,
    enabledProviders: Object.freeze(
      SIGN_IN_PROVIDERS.filter((provider) => config.providers[provider] !== null)
    ),
  };
}

export function createUserAuthRuntimeFromEnv(env: Env, database: SqlDatabase): UserAuthRuntime {
  return createUserAuthRuntime(normalizeUserAuthConfig(env), database);
}

type BetterAuthInstance = ReturnType<typeof createUserAuth>;

export interface UserAuthRuntime {
  readonly auth: BetterAuthInstance;
  readonly enabledProviders: readonly SignInProvider[];
}

interface CachedUserAuth {
  readonly fingerprint: string;
  readonly runtime: UserAuthRuntime;
}

const userAuthByDatabase = new WeakMap<SqlDatabase, CachedUserAuth>();

function configurationFingerprint(config: NormalizedUserAuthConfig): string {
  return JSON.stringify(config);
}

export function getUserAuthRuntime(env: Env, database: SqlDatabase): UserAuthRuntime {
  const config = normalizeUserAuthConfig(env);
  const fingerprint = configurationFingerprint(config);
  const cached = userAuthByDatabase.get(database);
  if (cached?.fingerprint === fingerprint) {
    return cached.runtime;
  }
  const runtime = createUserAuthRuntime(config, database);
  userAuthByDatabase.set(database, { fingerprint, runtime });
  return runtime;
}

export function getUserAuth(env: Env, database: SqlDatabase): BetterAuthInstance {
  return getUserAuthRuntime(env, database).auth;
}

export type BetterAuthRuntime = BetterAuthInstance;
