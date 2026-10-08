/**
 * The `serviceUrl` allowlist.
 *
 * Every Bot Framework activity names the connector endpoint the bot must
 * reply through. A forged activity could name any host, which would turn the
 * bot into an SSRF client carrying its own bearer token, so a serviceUrl is
 * checked against this allowlist before any outbound call is built from it:
 * once at ingress and again inside the reply client.
 */

/** `*.example.com` matches any host at least one label below example.com; anything else matches exactly. */
export function parseAllowedServiceUrlHosts(csv: string): string[] {
  return csv
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatches(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === pattern;
}

/**
 * True when `serviceUrl` is an absolute https URL, carries no credentials,
 * and its host matches the allowlist. Anything else, including a non-string,
 * is rejected.
 */
export function isAllowedServiceUrl(
  serviceUrl: unknown,
  allowedHosts: readonly string[]
): serviceUrl is string {
  if (typeof serviceUrl !== "string" || !URL.canParse(serviceUrl)) return false;
  const url = new URL(serviceUrl);
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const hostname = url.hostname.toLowerCase();
  return allowedHosts.some((pattern) => hostMatches(hostname, pattern));
}

/** The serviceUrl with exactly one trailing slash, the form REST paths are appended to. */
export function normalizeServiceUrl(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/, "") + "/";
}
