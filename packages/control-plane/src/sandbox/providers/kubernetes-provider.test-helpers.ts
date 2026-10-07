import { vi } from "vitest";
import {
  KubernetesApiError,
  KubernetesConflictError,
  type DeleteOptions,
  type KubernetesApi,
  type KubernetesNetworkPolicy,
  type KubernetesPod,
  type KubernetesPvc,
} from "../kubernetes-rest-client";
import type { KubernetesProviderConfig } from "./kubernetes-provider";

type Meta = KubernetesPvc["metadata"];

/** A pod status the fake reports once a pod exists; mutate to drive startup. */
export type PodStatus = NonNullable<KubernetesPod["status"]>;

export const RUNNING_STATUS: PodStatus = {
  phase: "Running",
  containerStatuses: [{ name: "sandbox", state: { running: {} } }],
};

/**
 * In-memory API server for the provider tests: names are unique per kind,
 * creates answer 409 on a taken name, a delete whose uid precondition fails
 * answers 409, a merge patch with a stale resourceVersion answers 409, and a
 * claim deleted while a pod still mounts it stays, with a deletionTimestamp,
 * until that pod is gone (pvc-protection).
 */
export class FakeKubernetesApi implements KubernetesApi {
  readonly namespace = "oi-sandboxes";
  readonly pvcs = new Map<string, KubernetesPvc>();
  readonly secrets = new Map<string, Record<string, unknown>>();
  readonly pods = new Map<string, KubernetesPod>();
  networkPolicies: KubernetesNetworkPolicy[] = defaultNetworkPolicies();
  /** Status given to every new pod. */
  nextPodStatus: PodStatus = RUNNING_STATUS;
  /**
   * Deleting a pod removes it at once unless this is set (it then lingers,
   * terminating). A force delete (grace 0) always removes it at once.
   */
  podsLinger = false;
  /** When set, a deleted pod lingers, terminating, for this many pod listings. */
  podsLingerForListings = 0;
  private readonly lingering = new Map<string, number>();
  private uid = 0;
  private version = 0;

  readonly calls: string[] = [];

  private meta(body: Record<string, unknown>): Meta {
    const metadata = (body.metadata ?? {}) as Meta;
    return {
      ...metadata,
      uid: `uid-${++this.uid}`,
      resourceVersion: String(++this.version),
      annotations: { ...(metadata.annotations ?? {}) },
    };
  }

  createPvc = vi.fn(async (body: Record<string, unknown>) => {
    const metadata = this.meta(body);
    this.calls.push(`createPvc ${metadata.name}`);
    if (this.pvcs.has(metadata.name)) throw conflict("persistentvolumeclaims");
    const pvc = { metadata, spec: body.spec as Record<string, unknown> };
    this.pvcs.set(metadata.name, pvc);
    return structuredClone(pvc);
  });

  getPvc = vi.fn(async (name: string) => {
    const pvc = this.pvcs.get(name);
    return pvc ? structuredClone(pvc) : null;
  });

  patchPvcMetadata = vi.fn(async (name: string, patch: Record<string, unknown>) => {
    this.calls.push(`patchPvc ${name}`);
    const pvc = this.pvcs.get(name);
    if (!pvc) throw new KubernetesApiError(404, "NotFound", "not found", "patch pvc");
    if (
      patch.resourceVersion !== undefined &&
      patch.resourceVersion !== pvc.metadata.resourceVersion
    ) {
      throw conflict("persistentvolumeclaims");
    }
    const annotations = { ...(pvc.metadata.annotations ?? {}) };
    for (const [key, value] of Object.entries(
      (patch.annotations ?? {}) as Record<string, string | null>
    )) {
      if (value === null) delete annotations[key];
      else annotations[key] = value;
    }
    pvc.metadata = { ...pvc.metadata, annotations, resourceVersion: String(++this.version) };
    return structuredClone(pvc);
  });

  deletePvc = vi.fn(async (name: string, options?: DeleteOptions) => {
    this.calls.push(`deletePvc ${name}`);
    const pvc = this.pvcs.get(name);
    if (!pvc) return;
    if (options?.uid && options.uid !== pvc.metadata.uid) throw preconditionFailed("pvc");
    pvc.metadata.deletionTimestamp ??= "2026-01-01T00:00:00Z";
    this.releaseClaims();
  });

  createSecret = vi.fn(async (body: Record<string, unknown>) => {
    const name = (body.metadata as Meta).name;
    this.calls.push(`createSecret ${name}`);
    if (this.secrets.has(name)) throw conflict("secrets");
    this.secrets.set(name, structuredClone(body));
  });

  deleteSecret = vi.fn(async (name: string) => {
    this.calls.push(`deleteSecret ${name}`);
    this.secrets.delete(name);
  });

  createPod = vi.fn(async (body: Record<string, unknown>) => {
    const metadata = this.meta(body);
    this.calls.push(`createPod ${metadata.name}`);
    if (this.pods.has(metadata.name)) throw conflict("pods");
    const pod: KubernetesPod = {
      metadata: { ...metadata, labels: { ...(metadata.labels ?? {}) } },
      spec: body.spec as Record<string, unknown>,
      status: structuredClone(this.nextPodStatus),
    };
    this.pods.set(metadata.name, pod);
    return structuredClone(pod);
  });

  getPod = vi.fn(async (name: string) => {
    const pod = this.pods.get(name);
    return pod ? structuredClone(pod) : null;
  });

  listPods = vi.fn(async (labelSelector: string) => {
    for (const [name, remaining] of this.lingering) {
      if (remaining > 0) {
        this.lingering.set(name, remaining - 1);
        continue;
      }
      this.lingering.delete(name);
      this.removePod(name);
    }
    const wanted = labelSelector.split(",").map((part) => part.split("="));
    return [...this.pods.values()]
      .filter((pod) => wanted.every(([key, value]) => pod.metadata.labels?.[key!] === value))
      .map((pod) => structuredClone(pod));
  });

  deletePod = vi.fn(async (name: string, options?: DeleteOptions) => {
    this.calls.push(`deletePod ${name}`);
    const pod = this.pods.get(name);
    if (!pod) return;
    if (options?.uid && options.uid !== pod.metadata.uid) throw preconditionFailed("pod");
    // A zero grace is a force delete: the API server drops the object at
    // once, whatever the kubelet is still doing with the containers.
    if (options?.gracePeriodSeconds !== 0 && (this.podsLinger || this.podsLingerForListings > 0)) {
      pod.metadata.deletionTimestamp = "2026-01-01T00:00:00Z";
      if (!this.podsLinger && !this.lingering.has(name)) {
        this.lingering.set(name, this.podsLingerForListings);
      }
    } else {
      this.removePod(name);
    }
  });

  private removePod(name: string) {
    this.pods.delete(name);
    this.releaseClaims();
  }

  /** Finish deleting claims no pod mounts any more. */
  private releaseClaims() {
    const mounted = new Set(
      [...this.pods.values()].flatMap((pod) =>
        (
          (pod.spec as { volumes?: Array<{ persistentVolumeClaim?: { claimName: string } }> })
            ?.volumes ?? []
        ).flatMap((volume) =>
          volume.persistentVolumeClaim ? [volume.persistentVolumeClaim.claimName] : []
        )
      )
    );
    for (const [name, pvc] of this.pvcs) {
      if (pvc.metadata.deletionTimestamp && !mounted.has(name)) this.pvcs.delete(name);
    }
  }

  listNetworkPolicies = vi.fn(async () => structuredClone(this.networkPolicies));

  /** Seed a pod that is not the provider's own, e.g. a previous generation. */
  seedPod(name: string, labels: Record<string, string>, annotations: Record<string, string>) {
    this.pods.set(name, {
      metadata: { name, uid: `uid-${++this.uid}`, labels, annotations },
      status: structuredClone(RUNNING_STATUS),
    });
  }
}

function preconditionFailed(resource: string) {
  return new KubernetesConflictError(
    "Conflict",
    `Precondition failed: UID in precondition does not match the UID of the ${resource}`,
    "delete"
  );
}

function conflict(resource: string) {
  return new KubernetesConflictError("AlreadyExists", `${resource} already exists`, "create");
}

export function defaultNetworkPolicies(): KubernetesNetworkPolicy[] {
  return [
    {
      metadata: { name: "default-deny" },
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
    },
    {
      metadata: { name: "sandbox-egress" },
      spec: {
        podSelector: { matchLabels: { "openinspect.dev/role": "sandbox" } },
        policyTypes: ["Egress"],
        egress: [{ to: [{ podSelector: { matchLabels: { app: "egress-proxy" } } }] }],
      },
    },
  ];
}

export const providerConfig: KubernetesProviderConfig = {
  scmProvider: "github",
  sandboxImage: "registry.test/sandbox@sha256:abc",
  runtimeClassName: "gvisor",
  workspaceSize: "20Gi",
  nodeSelector: {},
  podStartTimeoutMs: 50,
  requireNetworkPolicy: true,
  pollIntervalMs: 1,
  sleep: async () => {},
};

export const baseCreateConfig = {
  sessionId: "sess-1",
  sandboxId: "sandbox-octo-repo-1700000000000",
  repoOwner: "octo",
  repoName: "repo",
  controlPlaneUrl: "https://cp.test",
  sandboxAuthToken: "sandbox-token",
  harness: "opencode" as const,
  provider: "anthropic",
  model: "claude",
  timeoutSeconds: 3600,
  generationCreatedAtMs: 1_700_000_000_000,
  userEnvVars: { USER_SECRET: "u1", RESTORED_FROM_SNAPSHOT: "true" },
};
