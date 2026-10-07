import { createModalClient } from "./client";
import { createDaytonaRestClient, type DaytonaRestClient } from "./daytona-rest-client";
import { createE2BRestClient } from "./e2b-rest-client";
import { DEFAULT_EGRESS_PROBE_HOST } from "./kubernetes-manifests";
import {
  createKubernetesRestClient,
  isDnsLabel,
  staticKubernetesCredentials,
} from "./kubernetes-rest-client";
import { createOpenComputerRestClient } from "./opencomputer-rest-client";
import { resolveSandboxBackendName, type SandboxBackendName } from "./provider-name";
import type { SandboxProvider } from "./provider";
import { createDaytonaProvider, type DaytonaSandboxProvider } from "./providers/daytona-provider";
import {
  createE2BProvider,
  DEFAULT_E2B_AUTO_PAUSE,
  DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS,
  type E2BSandboxProvider,
} from "./providers/e2b-provider";
import {
  createKubernetesProvider,
  DEFAULT_KUBERNETES_POD_START_TIMEOUT_MS,
  DEFAULT_KUBERNETES_RUNTIME_CLASS,
  DEFAULT_KUBERNETES_WORKSPACE_SIZE,
  isIpLiteral,
  type KubernetesSandboxProvider,
} from "./providers/kubernetes-provider";
import { createModalProvider, type ModalSandboxProvider } from "./providers/modal-provider";
import {
  createOpenComputerProvider,
  type OpenComputerSandboxProvider,
} from "./providers/opencomputer-provider";
import { createVercelSandboxClient } from "./providers/vercel/client";
import { createVercelProvider, type VercelSandboxProvider } from "./providers/vercel/provider";
import { resolveScmProviderFromEnv } from "../source-control";
import type { Env } from "../types";

function createModalProviderFromEnv(env: Env, backend: "modal" | "modal-vm"): ModalSandboxProvider {
  if (!env.MODAL_API_SECRET || !env.MODAL_WORKSPACE) {
    throw new Error(
      `MODAL_API_SECRET and MODAL_WORKSPACE are required when SANDBOX_PROVIDER=${backend}`
    );
  }

  const client = createModalClient(
    env.MODAL_API_SECRET,
    env.MODAL_WORKSPACE,
    env.MODAL_ENVIRONMENT_WEB_SUFFIX,
    env.MODAL_API_URL
  );

  return createModalProvider(client, backend, resolveScmProviderFromEnv(env.SCM_PROVIDER));
}

function createVercelProviderFromEnv(env: Env): VercelSandboxProvider {
  if (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID) {
    throw new Error("VERCEL_TOKEN and VERCEL_PROJECT_ID are required when SANDBOX_PROVIDER=vercel");
  }

  const client = createVercelSandboxClient({
    token: env.VERCEL_TOKEN,
    projectId: env.VERCEL_PROJECT_ID,
    teamId: env.VERCEL_TEAM_ID,
    apiBaseUrl: env.VERCEL_SANDBOX_API_BASE_URL,
  });

  return createVercelProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    token: env.VERCEL_TOKEN,
    teamId: env.VERCEL_TEAM_ID,
    apiBaseUrl: env.VERCEL_SANDBOX_API_BASE_URL,
    baseSnapshotId: env.VERCEL_BASE_SNAPSHOT_ID,
    baseSnapshotName: env.VERCEL_BASE_SNAPSHOT_NAME,
    runtime: env.VERCEL_RUNTIME,
    snapshotExpirationMs: parseNumericEnv(
      "VERCEL_SNAPSHOT_EXPIRATION_MS",
      env.VERCEL_SNAPSHOT_EXPIRATION_MS,
      0
    ),
    sandboxAccessPasswordSecret: env.VERCEL_TOKEN,
  });
}

function createOpenComputerProviderFromEnv(
  env: Env,
  options: { requireOpenComputerTemplate: boolean }
): OpenComputerSandboxProvider {
  if (!env.OPENCOMPUTER_API_URL || !env.OPENCOMPUTER_API_KEY) {
    throw new Error(
      "OPENCOMPUTER_API_URL and OPENCOMPUTER_API_KEY are required when SANDBOX_PROVIDER=opencomputer"
    );
  }
  if (options.requireOpenComputerTemplate && !env.OPENCOMPUTER_TEMPLATE) {
    throw new Error("OPENCOMPUTER_TEMPLATE is required to start OpenComputer sandboxes");
  }

  const client = createOpenComputerRestClient({
    apiUrl: env.OPENCOMPUTER_API_URL,
    apiKey: env.OPENCOMPUTER_API_KEY,
    template: env.OPENCOMPUTER_TEMPLATE,
  });

  return createOpenComputerProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    sandboxAccessPasswordSecret: env.OPENCOMPUTER_API_KEY,
    llmEnvVars: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    },
  });
}

/**
 * The Daytona transport for one operation, shared by the session provider and
 * the image-build resources.
 *
 * Only creating a sandbox needs a base image. Finalizing and reclaiming what
 * an earlier configuration created must stay possible after a provider
 * switch, when no Daytona base snapshot is built any more.
 */
export function createDaytonaRestClientFromEnv(
  env: Env,
  options: { requireBaseSnapshot: boolean }
): DaytonaRestClient {
  if (!env.DAYTONA_API_URL || !env.DAYTONA_API_KEY) {
    throw new Error(
      "DAYTONA_API_URL and DAYTONA_API_KEY are required when SANDBOX_PROVIDER=daytona"
    );
  }
  if (options.requireBaseSnapshot && !env.DAYTONA_BASE_SNAPSHOT) {
    throw new Error("DAYTONA_BASE_SNAPSHOT is required to create Daytona sandboxes");
  }

  return createDaytonaRestClient({
    apiUrl: env.DAYTONA_API_URL,
    apiKey: env.DAYTONA_API_KEY,
    target: env.DAYTONA_TARGET,
    baseSnapshot: env.DAYTONA_BASE_SNAPSHOT,
    toolboxApiUrl: env.DAYTONA_TOOLBOX_API_URL,
    autoStopIntervalMinutes: parseNumericEnv(
      "DAYTONA_AUTO_STOP_INTERVAL_MINUTES",
      env.DAYTONA_AUTO_STOP_INTERVAL_MINUTES,
      120
    ),
    autoArchiveIntervalMinutes: parseNumericEnv(
      "DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES",
      env.DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES,
      10080
    ),
  });
}

function createDaytonaProviderFromEnv(env: Env): DaytonaSandboxProvider {
  const client = createDaytonaRestClientFromEnv(env, { requireBaseSnapshot: true });

  return createDaytonaProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    gitlabAccessToken: env.GITLAB_ACCESS_TOKEN,
    sandboxAccessPasswordSecret: client.config.apiKey,
  });
}

function createE2BProviderFromEnv(env: Env): E2BSandboxProvider {
  if (!env.E2B_API_KEY || !env.E2B_TEMPLATE_ID) {
    throw new Error("E2B_API_KEY and E2B_TEMPLATE_ID are required when SANDBOX_PROVIDER=e2b");
  }

  const client = createE2BRestClient({
    apiUrl: env.E2B_API_URL || "https://api.e2b.app",
    apiKey: env.E2B_API_KEY,
    templateId: env.E2B_TEMPLATE_ID,
  });

  return createE2BProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    sandboxAccessPasswordSecret: env.E2B_API_KEY,
    sandboxTimeoutSeconds: parseNumericEnv(
      "E2B_SANDBOX_TIMEOUT_SECONDS",
      env.E2B_SANDBOX_TIMEOUT_SECONDS,
      DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS
    ),
    autoPause: parseBooleanEnv("E2B_AUTO_PAUSE", env.E2B_AUTO_PAUSE, DEFAULT_E2B_AUTO_PAUSE),
  });
}

/** In-cluster API server address, reachable from any pod through the default Service. */
const DEFAULT_KUBERNETES_API_URL = "https://kubernetes.default.svc";

function createKubernetesProviderFromEnv(env: Env): KubernetesSandboxProvider {
  const namespace = env.KUBERNETES_NAMESPACE?.trim();
  const sandboxImage = env.KUBERNETES_SANDBOX_IMAGE?.trim();
  if (!namespace || !sandboxImage) {
    throw new Error(
      "KUBERNETES_NAMESPACE and KUBERNETES_SANDBOX_IMAGE are required when SANDBOX_PROVIDER=kubernetes"
    );
  }
  if (!isDnsLabel(namespace)) {
    throw new Error(`KUBERNETES_NAMESPACE is not a valid namespace name: ${namespace}`);
  }

  const credentials =
    env.KUBERNETES_CREDENTIALS ??
    (env.KUBERNETES_API_TOKEN ? staticKubernetesCredentials(env.KUBERNETES_API_TOKEN) : undefined);
  if (!credentials) {
    throw new Error(
      "SANDBOX_PROVIDER=kubernetes needs the host's ServiceAccount token (run the Node host in a pod) or KUBERNETES_API_TOKEN"
    );
  }
  // Sandboxes run agent-controlled code; the control plane's own credentials,
  // volume and object-store keys must never share their namespace.
  if (credentials.ownNamespace && credentials.ownNamespace === namespace) {
    throw new Error(
      `KUBERNETES_NAMESPACE must not be the control plane's own namespace (${namespace})`
    );
  }

  const runtimeClass = (env.KUBERNETES_RUNTIME_CLASS ?? DEFAULT_KUBERNETES_RUNTIME_CLASS).trim();
  const allowUnsandboxed = parseBooleanEnv(
    "KUBERNETES_ALLOW_UNSANDBOXED_RUNTIME",
    env.KUBERNETES_ALLOW_UNSANDBOXED_RUNTIME,
    false
  );
  if (!runtimeClass && !allowUnsandboxed) {
    throw new Error(
      "KUBERNETES_RUNTIME_CLASS is empty: sandboxes need a sandboxing runtime (gVisor or Kata). Set KUBERNETES_ALLOW_UNSANDBOXED_RUNTIME=true only for throwaway test clusters"
    );
  }

  const sandboxControlPlaneUrl = env.KUBERNETES_SANDBOX_CONTROL_PLANE_URL?.trim() || undefined;
  if (sandboxControlPlaneUrl && !sandboxControlPlaneUrl.startsWith("https://")) {
    throw new Error("KUBERNETES_SANDBOX_CONTROL_PLANE_URL must be an https URL");
  }

  const api = createKubernetesRestClient({
    apiUrl: env.KUBERNETES_API_URL?.trim() || DEFAULT_KUBERNETES_API_URL,
    namespace,
    credentials,
  });

  return createKubernetesProvider(api, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    sandboxImage,
    runtimeClassName: runtimeClass || null,
    storageClassName: env.KUBERNETES_STORAGE_CLASS?.trim() || undefined,
    workspaceSize: env.KUBERNETES_WORKSPACE_SIZE?.trim() || DEFAULT_KUBERNETES_WORKSPACE_SIZE,
    nodeSelector: parseNodeSelector(env.KUBERNETES_NODE_SELECTOR),
    podStartTimeoutMs: parseNumericEnv(
      "KUBERNETES_POD_START_TIMEOUT_MS",
      env.KUBERNETES_POD_START_TIMEOUT_MS,
      DEFAULT_KUBERNETES_POD_START_TIMEOUT_MS
    ),
    egressProxyUrl: env.KUBERNETES_EGRESS_PROXY_URL?.trim() || undefined,
    sandboxControlPlaneUrl,
    sandboxCaCert: env.KUBERNETES_SANDBOX_CA_CERT?.trim() || undefined,
    requireNetworkPolicy: parseBooleanEnv(
      "KUBERNETES_REQUIRE_NETWORK_POLICY",
      env.KUBERNETES_REQUIRE_NETWORK_POLICY,
      true
    ),
    egressProbeHost: parseEgressProbeHost(env.KUBERNETES_EGRESS_PROBE_HOST),
  });
}

/**
 * `KUBERNETES_EGRESS_PROBE_HOST`: the address a pod's prepare step must fail
 * to reach directly before its sandbox starts. An IP literal only: the pod
 * may have no resolver, and the value is written into the pod's command.
 */
function parseEgressProbeHost(value: string | undefined): string {
  const host = value?.trim();
  if (!host) return DEFAULT_EGRESS_PROBE_HOST;
  if (!/^[0-9a-fA-F.:]+$/.test(host) || !isIpLiteral(host)) {
    throw new Error("KUBERNETES_EGRESS_PROBE_HOST must be an IP address");
  }
  return host;
}

/** `key=value,key=value`, as `kubectl --selector` writes equality selectors. */
function parseNodeSelector(value: string | undefined): Record<string, string> {
  const selector: Record<string, string> = {};
  for (const part of (value ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator).trim();
    const labelValue = entry.slice(separator + 1).trim();
    if (separator <= 0 || !key) {
      throw new Error(`KUBERNETES_NODE_SELECTOR entries must be key=value, got ${entry}`);
    }
    selector[key] = labelValue;
  }
  return selector;
}

export function createSandboxProviderFromEnv(env: Env, backend: "daytona"): DaytonaSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "e2b"): E2BSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: "kubernetes"
): KubernetesSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: "modal" | "modal-vm"
): ModalSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "vercel"): VercelSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: "opencomputer",
  options?: { requireOpenComputerTemplate?: boolean }
): OpenComputerSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend?: SandboxBackendName,
  options?: SandboxProviderFactoryOptions
): SandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: SandboxBackendName = resolveSandboxBackendName(env.SANDBOX_PROVIDER),
  options: SandboxProviderFactoryOptions = {}
): SandboxProvider {
  switch (backend) {
    case "daytona":
      return createDaytonaProviderFromEnv(env);
    case "vercel":
      return createVercelProviderFromEnv(env);
    case "opencomputer":
      return createOpenComputerProviderFromEnv(env, {
        requireOpenComputerTemplate: options.requireOpenComputerTemplate ?? true,
      });
    case "e2b":
      return createE2BProviderFromEnv(env);
    case "kubernetes":
      return createKubernetesProviderFromEnv(env);
    case "modal":
    case "modal-vm":
      return createModalProviderFromEnv(env, backend);
  }
}

/**
 * Configuration a provider needs for the operation at hand, rather than for
 * every operation it supports. A deployment that has switched providers still
 * has resources to finalize and reclaim on the old one.
 */
interface SandboxProviderFactoryOptions {
  requireOpenComputerTemplate?: boolean;
}

function parseNumericEnv(name: string, value: string | undefined, defaultValue: number): number {
  const raw = value?.trim();
  if (!raw) return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid number`);
  }
  return parsed;
}

function parseBooleanEnv(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be a valid boolean`);
}
