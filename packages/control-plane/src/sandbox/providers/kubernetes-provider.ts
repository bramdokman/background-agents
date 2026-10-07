/**
 * Kubernetes sandbox provider: one workspace PVC, one immutable env Secret and
 * one Pod per generation, in a namespace of their own.
 *
 * The model is Daytona's: a preserve-stop deletes the pod and keeps the
 * volume; a resume starts a new pod on the same volume with
 * RESTORED_FROM_SNAPSHOT=true, so the runtime keeps the agent's working tree
 * and skips setup. A destroy-stop deletes the pod and the Secret and marks the
 * volume for garbage collection after a grace period, so a mistaken destroy
 * (for example after a resume that failed during a node drain) loses no work
 * an operator cannot recover.
 *
 * Isolation is the deployment's (docs/KUBERNETES_SANDBOX_PROVIDER.md): a
 * sandboxing RuntimeClass, Pod Security "restricted", default-deny egress plus
 * an allowlisting proxy, and an admission policy pinning the pod shape. The
 * provider refuses to run without a runtime class or, by default, without a
 * deny-all egress policy in its namespace.
 */

import {
  DEFAULT_KUBERNETES_CPU_CORES,
  DEFAULT_KUBERNETES_CPU_LIMIT_CORES,
  DEFAULT_KUBERNETES_MEMORY_LIMIT_MIB,
  DEFAULT_KUBERNETES_MEMORY_MIB,
  supportsConfigurableSandboxTimeout,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  KubernetesApiError,
  KubernetesConflictError,
  KubernetesTransportError,
  type KubernetesApi,
  type KubernetesPod,
  type KubernetesPvc,
} from "../kubernetes-rest-client";
import {
  ANNOTATIONS,
  buildEnvSecret,
  buildSandboxPod,
  buildWorkspaceClaim,
  DEFAULT_KUBERNETES_EPHEMERAL_STORAGE_LIMIT,
  isReleasedClaim,
  LABELS,
  MANAGED_BY,
  parseSandboxObjectId,
  PREPARE_CONTAINER_NAME,
  podName,
  SANDBOX_CONTAINER_NAME,
  SANDBOX_ROLE,
  sandboxLabelSelector,
  sandboxObjectNames,
  type OwnerClaim,
  type SandboxObjectNames,
  type SandboxResourceSpec,
} from "../kubernetes-manifests";
import {
  buildSandboxEnvVars,
  DEFERRED_START_ENV_VAR,
  IMAGE_BUILD_MODE_ENV_VAR,
  scmCloneIdentity,
} from "../sandbox-env";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  PrebuiltImageUnavailableError,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type PendingSandboxAllocation,
  type ResolveSandboxConfig,
  type ResolveSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxLifetime,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
} from "../provider";
import { resolveSandboxPortPlan } from "./port-resolution";

const log = createLogger("kubernetes-provider");

export const DEFAULT_KUBERNETES_RUNTIME_CLASS = "gvisor";
export const DEFAULT_KUBERNETES_WORKSPACE_SIZE = "20Gi";
/** Inside the control plane's connect watchdog, with room for the bridge to dial in. */
export const DEFAULT_KUBERNETES_POD_START_TIMEOUT_MS = 120_000;
const POD_POLL_INTERVAL_MS = 1_000;
/** A preflight answer is reused for this long; only a passing one is cached. */
const NETWORK_POLICY_PREFLIGHT_TTL_MS = 5 * 60_000;
/** Longest a preserve-stop waits for the pod to go when the caller sets no deadline. */
const PRESERVE_STOP_WAIT_MS = 45_000;
/**
 * Grace a resume gives a previous generation's pod. It must be positive: a
 * zero grace is a force delete, which removes the Pod object before the
 * kubelet has stopped its containers, so the drain wait below would see no
 * pod while the old container still writes to the workspace.
 */
const RESUME_PREVIOUS_POD_GRACE_SECONDS = 5;
/**
 * Longest a resume waits for a previous generation's pod to go before
 * starting its own. Well above the grace, to leave room for the runtime
 * (gVisor) teardown and the kubelet's status sync.
 */
const RESUME_DRAIN_WAIT_MS = 45_000;
/** Bound on best-effort cleanup after a failed start; the GC sweeps what it misses. */
const FAILED_START_CLEANUP_MS = 5_000;
/** Termination messages and API text are cut to this before they reach logs or users. */
const MAX_DIAGNOSTIC_LENGTH = 300;

/** Container waits that will not resolve on their own. */
const PERMANENT_WAIT_REASONS = new Set([
  "CreateContainerConfigError",
  "CreateContainerError",
  "InvalidImageName",
  "RunContainerError",
]);
const IMAGE_PULL_WAIT_REASONS = new Set(["ErrImagePull", "ImagePullBackOff"]);
const MISSING_IMAGE_PATTERN = /not found|manifest unknown|unauthorized|denied|no such host/i;

export interface KubernetesProviderConfig {
  scmProvider: SourceControlProviderName;
  sandboxImage: string;
  /** Null only when unsandboxed pods were explicitly allowed. */
  runtimeClassName: string | null;
  storageClassName?: string;
  workspaceSize: string;
  nodeSelector: Record<string, string>;
  podStartTimeoutMs: number;
  /** HTTP CONNECT proxy for the sandbox; an IP-literal host makes the pods DNS-less. */
  egressProxyUrl?: string;
  /** In-cluster https URL sandboxes use for the control plane, in place of WORKER_URL. */
  sandboxControlPlaneUrl?: string;
  /** PEM CA the sandbox trusts in addition to the system store. */
  sandboxCaCert?: string;
  requireNetworkPolicy: boolean;
  /**
   * The address a pod's prepare step must fail to reach directly before its
   * sandbox starts (`KUBERNETES_EGRESS_PROBE_HOST`); DEFAULT_EGRESS_PROBE_HOST when unset.
   */
  egressProbeHost?: string;
  /** Deployment-wide env for every sandbox (`KUBERNETES_SANDBOX_ENV`); user secrets override it. */
  sandboxEnv?: Record<string, string>;
  /** Injected in tests. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface NetworkPolicyPreflight {
  checkedAtMs: number;
}

/** Passing preflights per namespace, shared by every provider instance in the process. */
const passedPreflights = new Map<string, NetworkPolicyPreflight>();

/** Test hook: forget cached preflight results. */
export function resetKubernetesPreflightCache(): void {
  passedPreflights.clear();
}

export class KubernetesSandboxProvider implements SandboxProvider {
  readonly name = "kubernetes";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: supportsConfigurableSandboxTimeout(this.name),
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly api: KubernetesApi,
    private readonly config: KubernetesProviderConfig
  ) {
    this.pollIntervalMs = config.pollIntervalMs ?? POD_POLL_INTERVAL_MS;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // -----------------------------------------------------------------------
  // Lost-response recovery
  // -----------------------------------------------------------------------

  /**
   * Names are deterministic, so the reference recorded before the launch is
   * the provider object id itself: the control plane holds a cleanup
   * obligation for exactly the objects the create may make, even if the
   * create's answer is lost.
   */
  async pendingSandboxAllocation(
    config: Pick<
      CreateSandboxConfig,
      "sessionId" | "sandboxId" | "generationCreatedAtMs" | "timeoutSeconds"
    >
  ): Promise<PendingSandboxAllocation | undefined> {
    if (config.generationCreatedAtMs === undefined) return undefined;
    return {
      reference: (await sandboxObjectNames(config.sessionId, config.sandboxId)).base,
      lifetime: finiteLifetime(config.generationCreatedAtMs, config.timeoutSeconds),
    };
  }

  /** The generation's pod, if the lost create made it; stamps the claim complete if so. */
  async resolveSandbox(config: ResolveSandboxConfig): Promise<ResolveSandboxResult> {
    const names = await sandboxObjectNames(config.sessionId, config.sandboxId);
    let pod: KubernetesPod | null;
    try {
      pod = await this.api.getPod(podName(names, config.generationCreatedAtMs));
    } catch (error) {
      throw classifyKubernetesError("Failed to look up Kubernetes sandbox", error);
    }
    if (
      !pod ||
      pod.metadata.deletionTimestamp ||
      isTerminal(pod) ||
      pod.metadata.annotations?.[ANNOTATIONS.sandboxId] !== config.sandboxId ||
      pod.metadata.annotations?.[ANNOTATIONS.generationCreatedAtMs] !==
        String(config.generationCreatedAtMs)
    ) {
      // Transient: the attempt failed, but nothing says the deployment is broken.
      throw new SandboxProviderError(
        "The Kubernetes sandbox pod for this attempt does not exist",
        "transient"
      );
    }
    // The lost create may not have reached its own mark.
    await this.markCreateComplete(names);
    return {
      sandboxId: config.sandboxId,
      providerObjectId: names.base,
      lifetime: finiteLifetime(config.generationCreatedAtMs, config.timeoutSeconds),
    };
  }

  /** A failure that could still have created this generation: no answer, or a 5xx. */
  isUnknownStartupError(error: unknown): boolean {
    const cause = error instanceof SandboxProviderError ? error.cause : error;
    if (cause instanceof KubernetesTransportError) return true;
    return cause instanceof KubernetesApiError && cause.status >= 500;
  }

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    if (config.prebuiltImageId) {
      // Image builds are not offered for this provider yet, so a selected
      // image is a stale row from another provider: retire it.
      throw new PrebuiltImageUnavailableError(
        "The Kubernetes provider does not boot prebuilt images"
      );
    }
    const generationCreatedAtMs = config.generationCreatedAtMs ?? Date.now();
    const names = await sandboxObjectNames(config.sessionId, config.sandboxId);
    let created: { claim?: OwnerClaim; pod?: string } = {};
    try {
      await this.ensureEgressPolicy();
      const claim = await this.ensureWorkspaceClaim(config, names);
      created = { claim };
      await this.replaceEnvSecret(names, claim, this.buildEnv(config));
      const pod = await this.ensurePod(
        this.podSpec(config, names, claim, generationCreatedAtMs, {}),
        config.sandboxId,
        generationCreatedAtMs
      );
      created.pod = pod;
      await this.markCreateComplete(names);
      await this.waitForRunning(pod);
      return {
        sandboxId: config.sandboxId,
        providerObjectId: names.base,
        createdAt: Date.now(),
        lifetime: finiteLifetime(generationCreatedAtMs, config.timeoutSeconds),
      };
    } catch (error) {
      const classified = classifyKubernetesError("Failed to create Kubernetes sandbox", error);
      // An unanswered request may have made objects this call cannot see;
      // the recorded pending reference and resolveSandbox handle those. A
      // definite failure leaves nothing worth keeping: the volume is new.
      if (!this.isUnknownStartupError(classified)) {
        await this.cleanupFailedCreate(names, created);
      }
      throw classified;
    }
  }

  // -----------------------------------------------------------------------
  // Resume
  // -----------------------------------------------------------------------

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    const names = parseSandboxObjectId(config.providerObjectId);
    if (!names) {
      return {
        success: false,
        error: "Provider object id is not a Kubernetes sandbox",
        shouldSpawnFresh: true,
      };
    }
    const generationCreatedAtMs = config.generationCreatedAtMs ?? Date.now();
    let podToClean: string | undefined;
    const released: ResumeResult = {
      success: false,
      error: "Workspace volume no longer exists or was released",
      shouldSpawnFresh: true,
    };
    try {
      // Most starts in a long session are resumes: they get the same check.
      await this.ensureEgressPolicy();
      const pvc = await this.api.getPvc(names.base);
      // Gone, destroy-stopped, or claimed by the garbage collector.
      if (!pvc || isReleasedClaim(pvc.metadata)) return released;
      const annotations = pvc.metadata.annotations ?? {};
      if (annotations[ANNOTATIONS.sandboxId] !== config.sandboxId) {
        throw new SandboxProviderError(
          "Workspace volume belongs to a different sandbox",
          "permanent"
        );
      }
      const claim = claimRef(pvc);
      // Released between the read and the write: the same answer as above.
      if (!(await this.claimForResume(names, pvc))) return released;

      // Never adopt a previous generation's pod: it may be terminating, hung,
      // or the remains of a preserve-stop that failed. Recovery is a new
      // execution (ADR 0004). Nor start beside one: the claim is
      // ReadWriteOnce, which does not keep two pods on one node apart. The
      // grace is positive on purpose: the Pod object then stays, terminating,
      // until the kubelet confirms its containers stopped, so the wait below
      // holds the claim. A pod on a hung node never goes, and the resume
      // fails as transient instead of starting beside it.
      await this.deleteSandboxPods(names, {
        gracePeriodSeconds: RESUME_PREVIOUS_POD_GRACE_SECONDS,
      });
      const lingering = await this.waitForPodsGone(names, Date.now() + RESUME_DRAIN_WAIT_MS);
      if (lingering) {
        throw new SandboxProviderError(
          `A previous sandbox pod was still ${lingering} after ${RESUME_DRAIN_WAIT_MS}ms`,
          "transient"
        );
      }

      const pod = await this.ensurePod(
        this.podSpec(
          {
            sessionId: annotations[ANNOTATIONS.sessionId] ?? config.sessionId,
            sandboxId: config.sandboxId,
            timeoutSeconds: config.timeoutSeconds,
            sandboxSettings: config.sandboxSettings,
          },
          names,
          claim,
          generationCreatedAtMs,
          { RESTORED_FROM_SNAPSHOT: "true" }
        ),
        config.sandboxId,
        generationCreatedAtMs
      );
      podToClean = pod;
      await this.waitForRunning(pod);
      return {
        success: true,
        providerObjectId: names.base,
        lifetime: finiteLifetime(generationCreatedAtMs, config.timeoutSeconds),
      };
    } catch (error) {
      const classified = classifyKubernetesError("Failed to resume Kubernetes sandbox", error);
      // The volume stays: only the pod this call started is removed.
      if (podToClean && !this.isUnknownStartupError(classified)) {
        await this.bestEffort("resume_cleanup", () =>
          this.api.deletePod(podToClean!, { gracePeriodSeconds: 0 })
        );
      }
      throw classified;
    }
  }

  /**
   * Mark the volume active before starting anything on it. The
   * resourceVersion precondition fences out a garbage collector that read it
   * as idle: a conflict re-reads it once. Returns false when the volume went
   * away or was released in between, which is not resumed.
   */
  private async claimForResume(names: SandboxObjectNames, pvc: KubernetesPvc): Promise<boolean> {
    let current: KubernetesPvc | null = pvc;
    for (let attempt = 1; ; attempt++) {
      if (!current || isReleasedClaim(current.metadata)) return false;
      const nowMs = String(Date.now());
      try {
        await this.api.patchPvcMetadata(names.base, {
          resourceVersion: current.metadata.resourceVersion,
          annotations: {
            [ANNOTATIONS.stoppedAtMs]: null,
            [ANNOTATIONS.lastActiveAtMs]: nowMs,
            ...createCompleteStamp(current, nowMs),
          },
        });
        return true;
      } catch (error) {
        if (!(error instanceof KubernetesConflictError) || attempt >= 2) throw error;
      }
      current = await this.api.getPvc(names.base);
    }
  }

  // -----------------------------------------------------------------------
  // Stop
  // -----------------------------------------------------------------------

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    const names = parseSandboxObjectId(config.providerObjectId);
    if (!names) {
      return { success: false, error: "Provider object id is not a Kubernetes sandbox" };
    }
    const signal = signalUntilDeadline(config.deadlineAtMs, config.signal);
    try {
      return config.intent === "destroy"
        ? await this.destroy(names, signal)
        : await this.preserve(names, config, signal);
    } catch (error) {
      throw classifyKubernetesError(
        `Failed to ${config.intent === "destroy" ? "destroy" : "stop"} Kubernetes sandbox`,
        error
      );
    }
  }

  /**
   * Delete the generation's pod (and any older one) and verify the workspace
   * volume is still there. A pod of a newer generation is left alone, so a
   * late preserve for an old generation cannot stop a resumed sandbox.
   */
  private async preserve(
    names: SandboxObjectNames,
    config: StopConfig,
    signal: AbortSignal | undefined
  ): Promise<StopResult> {
    const deleted = await this.deleteSandboxPods(names, {
      upToGenerationMs: config.generationCreatedAtMs,
      signal,
    });
    const waitUntilMs = Math.min(
      config.deadlineAtMs ?? Infinity,
      Date.now() + PRESERVE_STOP_WAIT_MS
    );
    const remaining = await this.waitForPodsGone(names, waitUntilMs, deleted, signal);
    if (remaining) {
      return {
        success: false,
        error: `Sandbox pod was still ${remaining} when the preserve-stop deadline passed`,
      };
    }
    const pvc = await this.api.getPvc(names.base, signal);
    if (!pvc || pvc.metadata.deletionTimestamp) {
      return { success: false, error: "Workspace volume disappeared before preserve was verified" };
    }
    const nowMs = String(Date.now());
    await this.api.patchPvcMetadata(
      names.base,
      {
        annotations: {
          [ANNOTATIONS.stoppedAtMs]: nowMs,
          [ANNOTATIONS.lastActiveAtMs]: nowMs,
          ...createCompleteStamp(pvc, nowMs),
        },
      },
      signal
    );
    return { success: true };
  }

  /**
   * Returns once the deletes are accepted, without waiting for the pod to
   * terminate: the respawn path bounds a destroy to seconds. The workspace is
   * marked, not deleted; the GC deletes it after the destroy grace. The mark
   * comes first: a claim whose Secret is gone must already read as released,
   * or a later resume would start a pod that cannot find its env.
   */
  private async destroy(
    names: SandboxObjectNames,
    signal: AbortSignal | undefined
  ): Promise<StopResult> {
    try {
      await this.api.patchPvcMetadata(
        names.base,
        { annotations: { [ANNOTATIONS.destroyRequestedAtMs]: String(Date.now()) } },
        signal
      );
    } catch (error) {
      if (!(error instanceof KubernetesApiError && error.status === 404)) throw error;
    }
    await this.deleteSandboxPods(names, { gracePeriodSeconds: 0, signal });
    await this.api.deleteSecret(names.base, { signal });
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // Objects
  // -----------------------------------------------------------------------

  private async ensureWorkspaceClaim(
    config: CreateSandboxConfig,
    names: SandboxObjectNames
  ): Promise<OwnerClaim> {
    const body = buildWorkspaceClaim({
      names,
      sessionId: config.sessionId,
      sandboxId: config.sandboxId,
      repo: config.repoOwner && config.repoName ? `${config.repoOwner}/${config.repoName}` : null,
      storageClassName: this.config.storageClassName,
      size: this.config.workspaceSize,
      nowMs: Date.now(),
    });
    try {
      return claimRef(await this.api.createPvc(body));
    } catch (error) {
      if (!(error instanceof KubernetesConflictError)) throw error;
    }
    // A retried create of this very sandbox: adopt the volume only if it is
    // provably this session's and this sandbox's, and not on its way out.
    const existing = await this.api.getPvc(names.base);
    const annotations = existing?.metadata.annotations ?? {};
    if (
      !existing ||
      isReleasedClaim(existing.metadata) ||
      annotations[ANNOTATIONS.sessionId] !== config.sessionId ||
      annotations[ANNOTATIONS.sandboxId] !== config.sandboxId
    ) {
      throw new SandboxProviderError(
        `Kubernetes workspace volume ${names.base} exists for another sandbox`,
        "permanent"
      );
    }
    return claimRef(existing);
  }

  /**
   * The Secret is never adopted: it is unreadable to the provider by design,
   * and this call's env carries the current auth token. An existing one is a
   * leftover of an earlier attempt and is replaced.
   */
  private async replaceEnvSecret(
    names: SandboxObjectNames,
    claim: OwnerClaim,
    env: Record<string, string>
  ): Promise<void> {
    const body = buildEnvSecret(names, claim, env);
    try {
      await this.api.createSecret(body);
      return;
    } catch (error) {
      if (!(error instanceof KubernetesConflictError)) throw error;
    }
    await this.api.deleteSecret(names.base);
    await this.api.createSecret(body);
  }

  private async ensurePod(
    body: Record<string, unknown>,
    sandboxId: string,
    generationCreatedAtMs: number
  ): Promise<string> {
    const name = (body.metadata as { name: string }).name;
    try {
      await this.api.createPod(body);
      return name;
    } catch (error) {
      if (!(error instanceof KubernetesConflictError)) throw error;
    }
    const existing = await this.api.getPod(name);
    if (
      !existing ||
      existing.metadata.deletionTimestamp ||
      existing.metadata.annotations?.[ANNOTATIONS.sandboxId] !== sandboxId ||
      existing.metadata.annotations?.[ANNOTATIONS.generationCreatedAtMs] !==
        String(generationCreatedAtMs)
    ) {
      throw new SandboxProviderError(
        `Kubernetes sandbox pod ${name} exists for another generation`,
        "permanent"
      );
    }
    return name;
  }

  private async markCreateComplete(names: SandboxObjectNames): Promise<void> {
    // Best effort: without it the GC treats the volume as a partial create
    // only once it has no pod, which a running sandbox always has. Every
    // later resume and preserve-stop stamps it again if it is missing.
    await this.bestEffort("mark_create_complete", () =>
      this.api.patchPvcMetadata(names.base, {
        annotations: { [ANNOTATIONS.createCompleteAtMs]: String(Date.now()) },
      })
    );
  }

  private podSpec(
    config: Pick<
      CreateSandboxConfig,
      "sessionId" | "sandboxId" | "timeoutSeconds" | "sandboxSettings"
    >,
    names: SandboxObjectNames,
    claim: OwnerClaim,
    generationCreatedAtMs: number,
    extraEnv: Record<string, string>
  ): Record<string, unknown> {
    const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;
    return buildSandboxPod({
      names,
      claim,
      sessionId: config.sessionId,
      sandboxId: config.sandboxId,
      generationCreatedAtMs,
      image: this.config.sandboxImage,
      runtimeClassName: this.config.runtimeClassName,
      nodeSelector: this.config.nodeSelector,
      timeoutSeconds,
      resources: resolveResources(config.sandboxSettings),
      // The Secret is frozen at create; the lifetime is this generation's.
      generationEnv: { SANDBOX_TIMEOUT_SECONDS: String(timeoutSeconds), ...extraEnv },
      caCert: this.config.sandboxCaCert,
      dnsless: this.dnsless(),
      verifyEgressDenied: this.config.requireNetworkPolicy,
      egressProbeHost: this.config.egressProbeHost,
    });
  }

  private buildEnv(config: CreateSandboxConfig): Record<string, string> {
    // No code-server, terminal or VNC: each needs ingress into the pod, which
    // this provider does not create. The runtime is told they are off.
    const portPlan = resolveSandboxPortPlan(
      { codeServer: false, terminal: false, vnc: false },
      config.sandboxSettings
    );
    const controlPlaneUrl = this.config.sandboxControlPlaneUrl ?? config.controlPlaneUrl;
    const env = buildSandboxEnvVars(
      { ...config, controlPlaneUrl },
      {
        scmIdentity: scmCloneIdentity(this.config.scmProvider),
        portPlan,
        emitDisabledTerminalEnv: true,
        baseEnvVars: { ...this.config.sandboxEnv, ...config.userEnvVars },
      }
    );
    // Every boot marker is stated (Daytona parity): the runtime reads each as
    // `=== "true"`. A resume overrides RESTORED_FROM_SNAPSHOT in the pod env.
    Object.assign(env, {
      [DEFERRED_START_ENV_VAR]: "false",
      [IMAGE_BUILD_MODE_ENV_VAR]: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
    });
    if (this.config.egressProxyUrl) {
      const noProxy = ["localhost", "127.0.0.1", "::1"];
      const controlPlaneHost = hostOf(controlPlaneUrl);
      if (this.config.sandboxControlPlaneUrl && controlPlaneHost) noProxy.push(controlPlaneHost);
      Object.assign(env, {
        HTTPS_PROXY: this.config.egressProxyUrl,
        HTTP_PROXY: this.config.egressProxyUrl,
        https_proxy: this.config.egressProxyUrl,
        http_proxy: this.config.egressProxyUrl,
        NO_PROXY: noProxy.join(","),
        no_proxy: noProxy.join(","),
        NODE_USE_ENV_PROXY: "1",
      });
    }
    return env;
  }

  private dnsless(): boolean {
    const host = this.config.egressProxyUrl ? hostOf(this.config.egressProxyUrl) : null;
    return !!host && isIpLiteral(host);
  }

  // -----------------------------------------------------------------------
  // Pods
  // -----------------------------------------------------------------------

  /** Delete the sandbox's pods (optionally only up to a generation); returns the names deleted. */
  private async deleteSandboxPods(
    names: SandboxObjectNames,
    options: { upToGenerationMs?: number; gracePeriodSeconds?: number; signal?: AbortSignal }
  ): Promise<string[]> {
    const pods = await this.api.listPods(sandboxLabelSelector(names), options.signal);
    const targets = pods.filter((pod) => {
      if (options.upToGenerationMs === undefined) return true;
      const generation = Number(pod.metadata.annotations?.[ANNOTATIONS.generationCreatedAtMs]);
      return !Number.isFinite(generation) || generation <= options.upToGenerationMs;
    });
    for (const pod of targets) {
      try {
        await this.api.deletePod(pod.metadata.name, {
          gracePeriodSeconds: options.gracePeriodSeconds,
          uid: pod.metadata.uid,
          signal: options.signal,
        });
      } catch (error) {
        // The uid precondition failed: the name now holds a pod this call
        // did not list, which it leaves to whoever made it.
        if (!(error instanceof KubernetesConflictError)) throw error;
      }
    }
    return targets.map((pod) => pod.metadata.name);
  }

  /** Poll until the named pods (or all of the sandbox's) are gone; returns a lingering phase. */
  private async waitForPodsGone(
    names: SandboxObjectNames,
    untilMs: number,
    only?: string[],
    signal?: AbortSignal
  ): Promise<string | null> {
    for (;;) {
      const pods = (await this.api.listPods(sandboxLabelSelector(names), signal)).filter(
        (pod) => !only || only.includes(pod.metadata.name)
      );
      if (pods.length === 0) return null;
      if (Date.now() >= untilMs || signal?.aborted) {
        const pod = pods[0]!;
        return pod.metadata.deletionTimestamp ? "terminating" : (pod.status?.phase ?? "present");
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * Wait for the sandbox container to run. Readiness itself is the runtime's
   * `ready` event over the bridge; this only turns a pod that cannot start
   * into a classified error instead of a connect timeout.
   */
  private async waitForRunning(name: string): Promise<void> {
    const deadline = Date.now() + this.config.podStartTimeoutMs;
    let lastState = "Pending";
    for (;;) {
      const pod = await this.api.getPod(name);
      if (!pod) {
        throw new SandboxProviderError("Sandbox pod was deleted while starting", "transient");
      }
      const verdict = podStartVerdict(pod);
      if (verdict.kind === "running") return;
      if (verdict.kind === "failed") {
        throw new SandboxProviderError(verdict.message, verdict.errorType);
      }
      lastState = verdict.state;
      if (Date.now() >= deadline) {
        throw new SandboxProviderError(
          `Sandbox pod did not start within ${this.config.podStartTimeoutMs}ms (${lastState})`,
          "transient"
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  // -----------------------------------------------------------------------
  // Preflight and cleanup
  // -----------------------------------------------------------------------

  /**
   * Fail closed unless the namespace denies all egress by default and every
   * policy that selects sandbox pods allows only in-cluster peers (no ipBlock).
   * The provider cannot prove the deployment safe, but it can refuse one that
   * obviously is not.
   */
  private async ensureEgressPolicy(): Promise<void> {
    if (!this.config.requireNetworkPolicy) return;
    const cached = passedPreflights.get(this.api.namespace);
    if (cached && Date.now() - cached.checkedAtMs < NETWORK_POLICY_PREFLIGHT_TTL_MS) return;
    const problem = evaluateEgressPolicies(await this.api.listNetworkPolicies());
    if (problem) {
      throw new SandboxProviderError(
        `Refusing to start sandboxes in namespace ${this.api.namespace}: ${problem}`,
        "permanent"
      );
    }
    passedPreflights.set(this.api.namespace, { checkedAtMs: Date.now() });
  }

  private async cleanupFailedCreate(
    names: SandboxObjectNames,
    created: { claim?: OwnerClaim; pod?: string }
  ): Promise<void> {
    if (!created.claim) return;
    const signal = AbortSignal.timeout(FAILED_START_CLEANUP_MS);
    await this.bestEffort("create_cleanup", async () => {
      if (created.pod) {
        await this.api.deletePod(created.pod, { gracePeriodSeconds: 0, signal });
      }
      await this.api.deleteSecret(names.base, { signal });
      await this.api.deletePvc(names.base, {
        propagationPolicy: "Foreground",
        uid: created.claim!.uid,
        signal,
      });
    });
  }

  private async bestEffort(operation: string, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      log.warn("kubernetes.best_effort_failed", {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The create-complete mark for a claim that lacks it, as part of a later write. */
function createCompleteStamp(pvc: KubernetesPvc, nowMs: string): Record<string, string> {
  return pvc.metadata.annotations?.[ANNOTATIONS.createCompleteAtMs]
    ? {}
    : { [ANNOTATIONS.createCompleteAtMs]: nowMs };
}

function claimRef(pvc: KubernetesPvc): OwnerClaim {
  if (!pvc.metadata.uid) {
    throw new SandboxProviderError("Workspace volume has no uid", "transient");
  }
  return { name: pvc.metadata.name, uid: pvc.metadata.uid };
}

function finiteLifetime(
  startAtMs: number,
  timeoutSeconds: number | undefined
): Extract<SandboxLifetime, { kind: "finite" }> {
  // activeDeadlineSeconds counts from the pod's start, which is never earlier
  // than the generation's reservation, so this bound is conservative.
  return {
    kind: "finite",
    expiresAtMs: startAtMs + (timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS) * 1000,
    observedAtMs: startAtMs,
    source: "conservative_start_bound",
  };
}

export function resolveResources(settings: SandboxSettings | undefined): SandboxResourceSpec {
  const cpuCores = settings?.cpuCores ?? DEFAULT_KUBERNETES_CPU_CORES;
  const memoryMib = settings?.memoryMib ?? DEFAULT_KUBERNETES_MEMORY_MIB;
  return {
    cpuCores,
    memoryMib,
    // A request above the default cap raises the cap with it; an explicit
    // cap below the request is rejected by settings validation first.
    cpuLimitCores:
      settings?.cpuLimitCores ?? Math.max(DEFAULT_KUBERNETES_CPU_LIMIT_CORES, cpuCores),
    memoryLimitMib:
      settings?.memoryLimitMib ?? Math.max(DEFAULT_KUBERNETES_MEMORY_LIMIT_MIB, memoryMib),
    ephemeralStorageLimit: DEFAULT_KUBERNETES_EPHEMERAL_STORAGE_LIMIT,
  };
}

function isTerminal(pod: KubernetesPod): boolean {
  return pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded";
}

type PodStartVerdict =
  | { kind: "running" }
  | { kind: "waiting"; state: string }
  | { kind: "failed"; message: string; errorType: "transient" | "permanent" };

/** Classify a starting pod from its status alone. */
export function podStartVerdict(pod: KubernetesPod): PodStartVerdict {
  if (pod.metadata.deletionTimestamp) {
    return { kind: "failed", message: "Sandbox pod is being deleted", errorType: "transient" };
  }
  const status = pod.status ?? {};
  if (isTerminal(pod)) {
    // Only the reason and exit code: a termination message falls back to the
    // container's log tail, which can echo session secrets.
    const terminated = [
      ...(status.initContainerStatuses ?? []),
      ...(status.containerStatuses ?? []),
    ]
      .map((container) => ({ name: container.name, state: container.state?.terminated }))
      .find(({ state }) => state && state.exitCode !== 0);
    // Node shutdown and eviction are capacity events, not configuration errors.
    const evicted = status.reason === "Evicted" || status.reason === "Terminated";
    const detail = terminated?.state
      ? `: ${terminated.name} exited ${terminated.state.exitCode ?? "?"}${
          terminated.state.reason ? ` (${terminated.state.reason})` : ""
        }`
      : "";
    return {
      kind: "failed",
      message: `Sandbox pod ${status.phase}${status.reason ? ` (${status.reason})` : ""}${detail}`,
      errorType: evicted ? "transient" : "permanent",
    };
  }
  for (const container of [
    ...(status.initContainerStatuses ?? []),
    ...(status.containerStatuses ?? []),
  ]) {
    const waiting = container.state?.waiting;
    const terminated = container.state?.terminated;
    if (container.name === PREPARE_CONTAINER_NAME && terminated && terminated.exitCode !== 0) {
      return {
        kind: "failed",
        message: `Sandbox preparation failed${
          terminated.message ? `: ${diagnostic(terminated.message)}` : ""
        }`,
        errorType: "permanent",
      };
    }
    if (!waiting?.reason) continue;
    if (PERMANENT_WAIT_REASONS.has(waiting.reason)) {
      return {
        kind: "failed",
        message: `Sandbox container ${container.name} cannot start: ${waiting.reason}${
          waiting.message ? `: ${diagnostic(waiting.message)}` : ""
        }`,
        errorType: "permanent",
      };
    }
    if (
      IMAGE_PULL_WAIT_REASONS.has(waiting.reason) &&
      MISSING_IMAGE_PATTERN.test(waiting.message ?? "")
    ) {
      return {
        kind: "failed",
        message: `Sandbox image cannot be pulled: ${diagnostic(waiting.message ?? waiting.reason)}`,
        errorType: "permanent",
      };
    }
  }
  const sandbox = status.containerStatuses?.find((c) => c.name === SANDBOX_CONTAINER_NAME);
  if (status.phase === "Running" && sandbox?.state?.running) return { kind: "running" };
  const unschedulable = status.conditions?.find(
    (condition) => condition.type === "PodScheduled" && condition.status === "False"
  );
  if (unschedulable) {
    return { kind: "waiting", state: `unschedulable: ${diagnostic(unschedulable.message ?? "")}` };
  }
  const waitingReason = [
    ...(status.initContainerStatuses ?? []),
    ...(status.containerStatuses ?? []),
  ]
    .map((container) => container.state?.waiting?.reason)
    .find(Boolean);
  return { kind: "waiting", state: waitingReason ?? status.phase ?? "Pending" };
}

/**
 * Why the namespace's policies do not confine sandbox egress, or null.
 * Requires a pure default-deny (`podSelector: {}`, Egress, no rules) and that
 * every peer of a policy selecting sandbox pods names specific pods, never an
 * ipBlock: sandbox egress must go to in-cluster peers (the proxy, the control
 * plane), never to addresses or whole namespaces.
 */
export function evaluateEgressPolicies(
  policies: Awaited<ReturnType<KubernetesApi["listNetworkPolicies"]>>
): string | null {
  const denyAll = policies.some(
    (policy) =>
      isEmptySelector(policy.spec.podSelector) &&
      (policy.spec.policyTypes ?? []).includes("Egress") &&
      (policy.spec.egress ?? []).length === 0
  );
  if (!denyAll) return "no default-deny egress NetworkPolicy (podSelector {}, no egress rules)";

  for (const policy of policies) {
    if (!(policy.spec.policyTypes ?? []).includes("Egress")) continue;
    if (!mayMatchSandboxPods(policy.spec.podSelector)) continue;
    for (const rule of policy.spec.egress ?? []) {
      const peers = rule.to ?? [];
      if (peers.length === 0) {
        return `NetworkPolicy ${policy.metadata.name} allows sandbox egress to any destination`;
      }
      if (peers.some((peer) => peer.ipBlock)) {
        return `NetworkPolicy ${policy.metadata.name} allows sandbox egress to an ipBlock`;
      }
      // A peer must name pods: without a pod selector it opens a whole
      // namespace (or all of them), and `podSelector: {}` opens every pod in
      // the sandbox namespace, other sandboxes included.
      if (peers.some((peer) => !peer.podSelector || isEmptySelector(peer.podSelector))) {
        return `NetworkPolicy ${policy.metadata.name} allows sandbox egress to every pod of a namespace`;
      }
    }
  }
  return null;
}

interface LabelSelector {
  matchLabels?: Record<string, string> | null;
  matchExpressions?: unknown[] | null;
}

function isEmptySelector(selector: LabelSelector): boolean {
  return (
    Object.keys(selector.matchLabels ?? {}).length === 0 &&
    (selector.matchExpressions ?? []).length === 0
  );
}

/**
 * Whether a selector could match a sandbox pod, whose labels are exactly the
 * managed-by, role and sandbox labels (the admission policy refuses a sandbox
 * pod with any other). Expressions are not evaluated: a selector with any is
 * assumed to match, which only makes the check stricter.
 */
function mayMatchSandboxPods(selector: LabelSelector): boolean {
  return Object.entries(selector.matchLabels ?? {}).every(([key, value]) => {
    if (key === LABELS.managedBy) return value === MANAGED_BY;
    if (key === LABELS.role) return value === SANDBOX_ROLE;
    return key === LABELS.sandbox;
  });
}

/** Map any provider-path failure to a SandboxProviderError with a transient/permanent verdict. */
export function classifyKubernetesError(context: string, error: unknown): SandboxProviderError {
  if (error instanceof SandboxProviderError) return error;
  if (error instanceof KubernetesTransportError) {
    return new SandboxProviderError(`${context}: ${error.message}`, "transient", error);
  }
  if (error instanceof KubernetesApiError) {
    const quota = error.status === 403 && /exceeded quota/i.test(error.apiMessage);
    const transient = quota || error.status === 429 || error.status >= 500;
    return new SandboxProviderError(
      `${context}: ${error.message}`,
      transient ? "transient" : "permanent",
      error
    );
  }
  return SandboxProviderError.fromFetchError(`${context}: ${errorMessage(error)}`, error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Termination messages can echo what a boot printed; keep them short. */
function diagnostic(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DIAGNOSTIC_LENGTH
    ? `${oneLine.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : oneLine;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "") || null;
  } catch {
    return null;
  }
}

/** An IPv4 dotted quad or an IPv6 address (any host with a colon). */
export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

export function createKubernetesProvider(
  api: KubernetesApi,
  config: KubernetesProviderConfig
): KubernetesSandboxProvider {
  return new KubernetesSandboxProvider(api, config);
}
