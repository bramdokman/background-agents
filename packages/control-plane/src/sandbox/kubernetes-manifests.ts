/**
 * Pure builders for the Kubernetes objects behind one sandbox: a workspace
 * PersistentVolumeClaim (the durable unit), an immutable Secret holding the
 * session env, and one Pod per generation.
 *
 * Nothing here talks to the API server, so the security-relevant shape of
 * every object (Pod Security "restricted", no ServiceAccount token, the
 * runtime class, what is persisted) is unit-tested directly.
 */

/** Value of the `app.kubernetes.io/managed-by` label on everything the provider creates. */
export const MANAGED_BY = "open-inspect";

export const LABELS = {
  managedBy: "app.kubernetes.io/managed-by",
  role: "openinspect.dev/role",
  /** Hash naming one sandbox lineage (a session's sandbox id); selects its pods. */
  sandbox: "openinspect.dev/sandbox",
} as const;

export const ANNOTATIONS = {
  sessionId: "openinspect.dev/session-id",
  sandboxId: "openinspect.dev/sandbox-id",
  repo: "openinspect.dev/repo",
  generationCreatedAtMs: "openinspect.dev/generation-created-at-ms",
  /** Set when a create finished making its pod; a PVC without it is a partial create. */
  createCompleteAtMs: "openinspect.dev/create-complete-at-ms",
  /** Last create, resume or preserve-stop; GC retention counts from here. */
  lastActiveAtMs: "openinspect.dev/last-active-at-ms",
  stoppedAtMs: "openinspect.dev/stopped-at-ms",
  /** A destroy-stop marks the workspace instead of deleting it; GC deletes it after a grace. */
  destroyRequestedAtMs: "openinspect.dev/destroy-requested-at-ms",
  /** Set by the garbage collector before it deletes an idle workspace. */
  gcClaimedAtMs: "openinspect.dev/gc-claimed-at-ms",
} as const;

/** Whether a workspace claim has been given up: deleting, destroy-stopped, or claimed by GC. */
export function isReleasedClaim(metadata: {
  deletionTimestamp?: string | null;
  annotations?: Record<string, string> | null;
}): boolean {
  return (
    !!metadata.deletionTimestamp ||
    !!metadata.annotations?.[ANNOTATIONS.destroyRequestedAtMs] ||
    !!metadata.annotations?.[ANNOTATIONS.gcClaimedAtMs]
  );
}

export const SANDBOX_ROLE = "sandbox";

/** The runtime user the kubernetes image target pins (packages/sandbox-images/targets.json). */
export const SANDBOX_UID = 1000;
const SANDBOX_HOME = "/home/sandbox";
export const SANDBOX_CONTAINER_NAME = "sandbox";
export const PREPARE_CONTAINER_NAME = "prepare";
const WORKSPACE_VOLUME = "workspace";
const CA_VOLUME = "trust";
const PREPARE_VOLUME_PATH = "/oi-volume";
const CA_MOUNT_PATH = "/opt/openinspect-trust";
const CA_BUNDLE_PATH = `${CA_MOUNT_PATH}/ca-bundle.crt`;
const EXTRA_CA_PATH = `${CA_MOUNT_PATH}/extra-ca.crt`;

/** The image's own Python, which the runtime supervisor runs on. */
const SANDBOX_PYTHON = "/opt/openinspect/python/bin/python";
/** Matches the Daytona entrypoint: the image's runtime supervisor. */
const SANDBOX_COMMAND = [SANDBOX_PYTHON, "-m", "sandbox_runtime.entrypoint"];

/**
 * The address the prepare step probes unless KUBERNETES_EGRESS_PROBE_HOST
 * names another: a public address no sandbox may reach directly. Before the
 * sandbox container starts, the prepare step waits until a direct connection
 * to it fails: NetworkPolicy is enforced a moment after a pod starts (100-300
 * ms measured on k3s with kube-router), and nothing else orders the runtime
 * after it.
 */
export const DEFAULT_EGRESS_PROBE_HOST = "1.1.1.1";
const EGRESS_PROBE_PORT = 443;
/** How long the prepare step waits for default-deny egress before it fails the pod. */
const EGRESS_ENFORCEMENT_WAIT_SECONDS = 30;

/** How long a deleted pod has to flush before it is killed. */
const SANDBOX_TERMINATION_GRACE_SECONDS = 30;
/** Cap on the image's own ephemeral writes; the workspace lives on the PVC. */
export const DEFAULT_KUBERNETES_EPHEMERAL_STORAGE_LIMIT = "10Gi";

/**
 * The paths a sandbox keeps across a preserve-stop, as subPaths of its one
 * workspace volume. Agent conversation state lives in /tmp (the bridge's
 * session-id file and the runtime's handoff files), the OpenCode data
 * directory, and the Claude harness directory; the rest of $HOME stays
 * image-owned so an image upgrade reaches resumed sessions. `seed` names the
 * image-owned entries under the mount path that are copied into the volume
 * on every boot, without overwriting what the session wrote.
 */
export const PERSISTED_PATHS: ReadonlyArray<{
  subPath: string;
  mountPath: string;
  seed?: readonly string[];
}> = [
  { subPath: "workspace", mountPath: "/workspace" },
  // Only the runtime user's own directory: the image's /tmp also holds
  // root-owned build leftovers the runtime user cannot read.
  { subPath: "tmp", mountPath: "/tmp", seed: ["opencode"] },
  {
    subPath: "home/opencode-data",
    mountPath: `${SANDBOX_HOME}/.local/share/opencode`,
    seed: ["."],
  },
  { subPath: "home/openinspect", mountPath: `${SANDBOX_HOME}/.openinspect` },
];

/**
 * Runs before every start of the sandbox container, as the runtime user, with
 * the whole volume mounted. Creates each persisted subPath (a subPath the
 * kubelet creates itself is root-owned), seeds image-owned files without
 * clobbering session state, and assembles the CA bundle when one is set. With
 * `verifyEgressDenied`, it last waits until direct egress is blocked, and
 * fails the pod if it never is.
 */
export function prepareScript(
  options: { verifyEgressDenied?: boolean; egressProbeHost?: string } = {}
): string {
  const lines = ["set -eu", `v=${PREPARE_VOLUME_PATH}`];
  for (const path of PERSISTED_PATHS) {
    lines.push(`mkdir -p "$v/${path.subPath}"`);
    for (const entry of path.seed ?? []) {
      const source = `${path.mountPath}/${entry}`;
      const target = `$v/${path.subPath}/${entry}`;
      lines.push(
        `if [ -d "${source}" ]; then mkdir -p "${target}" && cp -an "${source}/." "${target}/"; fi`
      );
    }
  }
  lines.push(
    `chmod 1777 "$v/tmp"`,
    'if [ -n "${OI_EXTRA_CA_CERT:-}" ]; then',
    `  printf '%s\\n' "$OI_EXTRA_CA_CERT" > ${EXTRA_CA_PATH}`,
    `  cat /etc/ssl/certs/ca-certificates.crt ${EXTRA_CA_PATH} > ${CA_BUNDLE_PATH}`,
    "fi"
  );
  if (options.verifyEgressDenied) {
    lines.push(egressProbeScript(options.egressProbeHost ?? DEFAULT_EGRESS_PROBE_HOST));
  }
  return lines.join("\n");
}

function egressProbeScript(host: string): string {
  const target = `${host}:${EGRESS_PROBE_PORT}`;
  return [
    `${SANDBOX_PYTHON} - <<'EOF'`,
    "import socket, sys, time",
    `deadline = time.monotonic() + ${EGRESS_ENFORCEMENT_WAIT_SECONDS}`,
    "while True:",
    "    try:",
    `        socket.create_connection(("${host}", ${EGRESS_PROBE_PORT}), timeout=1).close()`,
    "    except OSError:",
    "        sys.exit(0)",
    "    if time.monotonic() > deadline:",
    `        sys.exit("egress is not confined: a direct connection to ${target} still succeeds")`,
    "    time.sleep(0.1)",
    "EOF",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

export interface SandboxObjectNames {
  /** 20 hex characters of sha256(sessionId NUL sandboxId); the `sandbox` label value. */
  hash: string;
  /** Name of the PVC and the Secret, and the provider object id. */
  base: string;
}

/** Provider object ids are `oi-` plus 20 hex characters. */
const BASE_NAME_PATTERN = /^oi-([0-9a-f]{20})$/;

export async function sandboxObjectNames(
  sessionId: string,
  sandboxId: string
): Promise<SandboxObjectNames> {
  // The session id is part of the hash: sandbox ids are
  // `sandbox-{owner}-{repo}-{ms}`, which two sessions on one repository can
  // share when they spawn in the same millisecond.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${sessionId}\0${sandboxId}`)
  );
  const hash = Array.from(new Uint8Array(digest, 0, 10), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return { hash, base: `oi-${hash}` };
}

/** Parse a provider object id back into its names, or null when it is not one. */
export function parseSandboxObjectId(providerObjectId: string): SandboxObjectNames | null {
  const match = BASE_NAME_PATTERN.exec(providerObjectId);
  return match ? { hash: match[1]!, base: providerObjectId } : null;
}

/** One pod per generation: a late stop for an old generation cannot name a newer pod. */
export function podName(names: SandboxObjectNames, generationCreatedAtMs: number): string {
  return `${names.base}-${generationCreatedAtMs.toString(36)}`;
}

export function sandboxLabelSelector(names: SandboxObjectNames): string {
  return `${LABELS.managedBy}=${MANAGED_BY},${LABELS.sandbox}=${names.hash}`;
}

function baseLabels(names: SandboxObjectNames): Record<string, string> {
  return {
    [LABELS.managedBy]: MANAGED_BY,
    [LABELS.role]: SANDBOX_ROLE,
    [LABELS.sandbox]: names.hash,
  };
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export interface WorkspaceClaimInput {
  names: SandboxObjectNames;
  sessionId: string;
  sandboxId: string;
  repo: string | null;
  storageClassName?: string;
  size: string;
  nowMs: number;
}

export function buildWorkspaceClaim(input: WorkspaceClaimInput): Record<string, unknown> {
  const annotations: Record<string, string> = {
    [ANNOTATIONS.sessionId]: input.sessionId,
    [ANNOTATIONS.sandboxId]: input.sandboxId,
    [ANNOTATIONS.lastActiveAtMs]: String(input.nowMs),
  };
  if (input.repo) annotations[ANNOTATIONS.repo] = input.repo;
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: input.names.base, labels: baseLabels(input.names), annotations },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: input.size } },
      ...(input.storageClassName ? { storageClassName: input.storageClassName } : {}),
    },
  };
}

export interface OwnerClaim {
  name: string;
  uid: string;
}

function ownedBy(claim: OwnerClaim): Array<Record<string, unknown>> {
  // No blockOwnerDeletion: setting it needs finalizer RBAC under
  // OwnerReferencesPermissionEnforcement, and nothing here relies on it.
  return [{ apiVersion: "v1", kind: "PersistentVolumeClaim", name: claim.name, uid: claim.uid }];
}

/**
 * The session env, immutable, owned by the workspace claim so it goes when the
 * claim goes. Resume has no env of its own (ResumeConfig carries none), so
 * every generation reads this one.
 */
export function buildEnvSecret(
  names: SandboxObjectNames,
  claim: OwnerClaim,
  env: Record<string, string>
): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    immutable: true,
    metadata: { name: names.base, labels: baseLabels(names), ownerReferences: ownedBy(claim) },
    stringData: env,
  };
}

export interface SandboxResourceSpec {
  cpuCores: number;
  memoryMib: number;
  cpuLimitCores: number;
  memoryLimitMib: number;
  ephemeralStorageLimit: string;
}

export interface SandboxPodInput {
  names: SandboxObjectNames;
  claim: OwnerClaim;
  sessionId: string;
  sandboxId: string;
  generationCreatedAtMs: number;
  image: string;
  /** Null only when unsandboxed pods were explicitly allowed. */
  runtimeClassName: string | null;
  nodeSelector: Record<string, string>;
  timeoutSeconds: number;
  resources: SandboxResourceSpec;
  /** Per-generation values that override the Secret's (`env` wins over `envFrom`). */
  generationEnv: Record<string, string>;
  /** PEM appended to the system trust store for the runtime's own clients. */
  caCert?: string;
  /** No resolver at all: every name is resolved by the egress proxy. */
  dnsless: boolean;
  /** Hold the sandbox container until direct egress is blocked (see DEFAULT_EGRESS_PROBE_HOST). */
  verifyEgressDenied?: boolean;
  /** The address that probe must fail to reach; DEFAULT_EGRESS_PROBE_HOST when unset. */
  egressProbeHost?: string;
}

const RESTRICTED_CONTAINER_SECURITY = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  runAsNonRoot: true,
};

export function buildSandboxPod(input: SandboxPodInput): Record<string, unknown> {
  const env: Array<{ name: string; value: string }> = Object.entries(input.generationEnv).map(
    ([name, value]) => ({ name, value })
  );
  if (input.caCert) {
    for (const name of [
      "SSL_CERT_FILE",
      "REQUESTS_CA_BUNDLE",
      "CURL_CA_BUNDLE",
      "GIT_SSL_CAINFO",
    ]) {
      env.push({ name, value: CA_BUNDLE_PATH });
    }
    env.push({ name: "NODE_EXTRA_CA_CERTS", value: EXTRA_CA_PATH });
  }

  const volumes: Array<Record<string, unknown>> = [
    { name: WORKSPACE_VOLUME, persistentVolumeClaim: { claimName: input.claim.name } },
  ];
  const prepareMounts: Array<Record<string, unknown>> = [
    { name: WORKSPACE_VOLUME, mountPath: PREPARE_VOLUME_PATH },
  ];
  const sandboxMounts: Array<Record<string, unknown>> = PERSISTED_PATHS.map((path) => ({
    name: WORKSPACE_VOLUME,
    mountPath: path.mountPath,
    subPath: path.subPath,
  }));
  if (input.caCert) {
    volumes.push({ name: CA_VOLUME, emptyDir: { sizeLimit: "1Mi" } });
    prepareMounts.push({ name: CA_VOLUME, mountPath: CA_MOUNT_PATH });
    sandboxMounts.push({ name: CA_VOLUME, mountPath: CA_MOUNT_PATH, readOnly: true });
  }

  const { resources } = input;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName(input.names, input.generationCreatedAtMs),
      labels: baseLabels(input.names),
      annotations: {
        [ANNOTATIONS.sessionId]: input.sessionId,
        [ANNOTATIONS.sandboxId]: input.sandboxId,
        [ANNOTATIONS.generationCreatedAtMs]: String(input.generationCreatedAtMs),
      },
      ownerReferences: ownedBy(input.claim),
    },
    spec: {
      ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // A crashed runtime surfaces to the control plane; no silent restarts.
      restartPolicy: "Never",
      // The provider-enforced lifetime (supportsSandboxTimeout).
      activeDeadlineSeconds: input.timeoutSeconds,
      terminationGracePeriodSeconds: SANDBOX_TERMINATION_GRACE_SECONDS,
      ...(Object.keys(input.nodeSelector).length > 0 ? { nodeSelector: input.nodeSelector } : {}),
      ...(input.dnsless
        ? {
            // Nothing listens on loopback :53, so a lookup fails at once
            // instead of timing out against a resolver the policy blocks.
            dnsPolicy: "None",
            dnsConfig: { nameservers: ["127.0.0.1"], options: [{ name: "attempts", value: "1" }] },
          }
        : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: SANDBOX_UID,
        runAsGroup: SANDBOX_UID,
        fsGroup: SANDBOX_UID,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      },
      initContainers: [
        {
          name: PREPARE_CONTAINER_NAME,
          image: input.image,
          command: [
            "/bin/sh",
            "-c",
            prepareScript({
              verifyEgressDenied: input.verifyEgressDenied,
              egressProbeHost: input.egressProbeHost,
            }),
          ],
          ...(input.caCert ? { env: [{ name: "OI_EXTRA_CA_CERT", value: input.caCert }] } : {}),
          resources: {
            requests: { cpu: "100m", memory: "64Mi" },
            limits: { cpu: "1", memory: "256Mi" },
          },
          securityContext: RESTRICTED_CONTAINER_SECURITY,
          terminationMessagePolicy: "FallbackToLogsOnError",
          volumeMounts: prepareMounts,
        },
      ],
      containers: [
        {
          name: SANDBOX_CONTAINER_NAME,
          image: input.image,
          command: SANDBOX_COMMAND,
          envFrom: [{ secretRef: { name: input.names.base } }],
          env,
          resources: {
            requests: {
              cpu: cpuQuantity(resources.cpuCores),
              memory: `${Math.round(resources.memoryMib)}Mi`,
            },
            limits: {
              cpu: cpuQuantity(resources.cpuLimitCores),
              memory: `${Math.round(resources.memoryLimitMib)}Mi`,
              "ephemeral-storage": resources.ephemeralStorageLimit,
            },
          },
          securityContext: RESTRICTED_CONTAINER_SECURITY,
          terminationMessagePolicy: "FallbackToLogsOnError",
          volumeMounts: sandboxMounts,
        },
      ],
      volumes,
    },
  };
}

function cpuQuantity(cores: number): string {
  return `${Math.max(1, Math.round(cores * 1000))}m`;
}
