/**
 * The pod's own Kubernetes identity, for the Kubernetes sandbox provider.
 *
 * The kubelet writes a projected ServiceAccount token into the pod and
 * rotates it before it expires, so the token is re-read from disk rather than
 * held for the life of the process: at most every TOKEN_REREAD_MS, and at
 * once when the API server answers 401.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KubernetesCredentials } from "../platform-ports";

/** Where the kubelet mounts the ServiceAccount token, namespace and CA. */
const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const TOKEN_REREAD_MS = 60_000;

/**
 * Credentials from a mounted ServiceAccount directory, or undefined when the
 * host is not running in a pod with a token mounted.
 */
export function readServiceAccountCredentials(
  directory: string = SERVICE_ACCOUNT_DIR,
  now: () => number = Date.now
): KubernetesCredentials | undefined {
  const tokenPath = join(directory, "token");
  if (!existsSync(tokenPath)) return undefined;
  const namespacePath = join(directory, "namespace");
  const ownNamespace = existsSync(namespacePath)
    ? readFileSync(namespacePath, "utf8").trim() || undefined
    : undefined;

  let cached: { token: string; readAtMs: number } | null = null;
  return {
    ownNamespace,
    async token(options) {
      if (!options?.refresh && cached && now() - cached.readAtMs < TOKEN_REREAD_MS) {
        return cached.token;
      }
      const token = (await readFile(tokenPath, "utf8")).trim();
      if (!token) throw new Error("The ServiceAccount token file is empty");
      cached = { token, readAtMs: now() };
      return token;
    },
  };
}
