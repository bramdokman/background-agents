import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOTATIONS, LABELS, podName, sandboxObjectNames } from "../kubernetes-manifests";
import {
  KubernetesApiError,
  KubernetesTransportError,
  type KubernetesNetworkPolicy,
} from "../kubernetes-rest-client";
import {
  PrebuiltImageUnavailableError,
  SandboxProviderError,
  providerResumesAfterStop,
} from "../provider";
import {
  classifyKubernetesError,
  evaluateEgressPolicies,
  KubernetesSandboxProvider,
  podStartVerdict,
  resetKubernetesPreflightCache,
  resolveResources,
} from "./kubernetes-provider";
import {
  baseCreateConfig,
  defaultNetworkPolicies,
  FakeKubernetesApi,
  providerConfig,
  RUNNING_STATUS,
} from "./kubernetes-provider.test-helpers";

const names = await sandboxObjectNames(baseCreateConfig.sessionId, baseCreateConfig.sandboxId);
const G1 = baseCreateConfig.generationCreatedAtMs;
const G2 = G1 + 60_000;

function setup(overrides: Partial<typeof providerConfig> = {}) {
  const api = new FakeKubernetesApi();
  const provider = new KubernetesSandboxProvider(api, { ...providerConfig, ...overrides });
  return { api, provider };
}

type PodSpec = {
  containers: Array<{ env: Array<{ name: string; value: string }> }>;
};

function secretEnv(api: FakeKubernetesApi): Record<string, string> {
  return api.secrets.get(names.base)!.stringData as Record<string, string>;
}

function podEnv(api: FakeKubernetesApi, generation: number): Record<string, string> {
  const pod = api.pods.get(podName(names, generation))!;
  return Object.fromEntries(
    (pod.spec as unknown as PodSpec).containers[0]!.env.map((e) => [e.name, e.value])
  );
}

beforeEach(() => resetKubernetesPreflightCache());
afterEach(() => vi.restoreAllMocks());

const preserveG1 = {
  providerObjectId: names.base,
  sessionId: "sess-1",
  reason: "inactivity",
  intent: "preserve" as const,
  generationCreatedAtMs: G1,
};

function annotation(api: FakeKubernetesApi, key: string): string | undefined {
  return api.pvcs.get(names.base)!.metadata.annotations?.[key];
}

describe("KubernetesSandboxProvider capabilities", () => {
  it("preserve-stops and resumes like Daytona", () => {
    const { provider } = setup();
    expect(provider.capabilities).toEqual({
      supportsSandboxTimeout: true,
      supportsSnapshots: false,
      supportsRestore: false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
    expect(providerResumesAfterStop(provider)).toBe(true);
  });
});

describe("createSandbox", () => {
  it("creates the claim, the env Secret and the generation's pod, in that order", async () => {
    const { api, provider } = setup();
    const result = await provider.createSandbox(baseCreateConfig);

    expect(result).toMatchObject({
      sandboxId: baseCreateConfig.sandboxId,
      providerObjectId: names.base,
      lifetime: {
        kind: "finite",
        expiresAtMs: G1 + 3600 * 1000,
        source: "conservative_start_bound",
      },
    });
    expect(api.calls.filter((c) => c.startsWith("create"))).toEqual([
      `createPvc ${names.base}`,
      `createSecret ${names.base}`,
      `createPod ${podName(names, G1)}`,
    ]);
    const pvc = api.pvcs.get(names.base)!;
    expect(pvc.metadata.annotations).toMatchObject({
      [ANNOTATIONS.sessionId]: "sess-1",
      [ANNOTATIONS.sandboxId]: baseCreateConfig.sandboxId,
      [ANNOTATIONS.repo]: "octo/repo",
    });
    expect(pvc.metadata.annotations?.[ANNOTATIONS.createCompleteAtMs]).toBeDefined();
    const secret = api.secrets.get(names.base)!;
    expect(secret).toMatchObject({
      immutable: true,
      metadata: { ownerReferences: [{ uid: pvc.metadata.uid }] },
    });
  });

  it("states every boot marker and strips user overrides of them", async () => {
    const { api, provider } = setup();
    await provider.createSandbox(baseCreateConfig);
    const env = secretEnv(api);
    expect(env).toMatchObject({
      SANDBOX_ID: baseCreateConfig.sandboxId,
      SANDBOX_AUTH_TOKEN: "sandbox-token",
      CONTROL_PLANE_URL: "https://cp.test",
      USER_SECRET: "u1",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      IMAGE_BUILD_MODE: "false",
      OI_DEFERRED_START: "false",
      TERMINAL_ENABLED: "",
    });
    expect(env.CODE_SERVER_PORT).toBeUndefined();
    expect(podEnv(api, G1)).toEqual({ SANDBOX_TIMEOUT_SECONDS: "3600" });
  });

  it("probes the configured egress address before the sandbox starts", async () => {
    const { api, provider } = setup({ egressProbeHost: "203.0.113.9" });
    await provider.createSandbox(baseCreateConfig);
    const spec = api.pods.get(podName(names, G1))!.spec as {
      initContainers: Array<{ command: string[] }>;
    };
    expect(spec.initContainers[0]!.command[2]).toContain(
      `socket.create_connection(("203.0.113.9", 443)`
    );
  });

  it("adds the deployment-wide sandbox env under user secrets", async () => {
    const { api, provider } = setup({
      sandboxEnv: { ZHIPU_API_KEY: "deployment-key", USER_SECRET: "deployment" },
    });
    await provider.createSandbox(baseCreateConfig);
    expect(secretEnv(api)).toMatchObject({ ZHIPU_API_KEY: "deployment-key", USER_SECRET: "u1" });
  });

  it("points sandboxes at the in-cluster control plane through the proxy exemption", async () => {
    const { api, provider } = setup({
      sandboxControlPlaneUrl: "https://10.43.250.21:8443",
      egressProxyUrl: "http://10.43.250.30:3128",
      sandboxCaCert: "-----BEGIN CERTIFICATE-----",
    });
    await provider.createSandbox(baseCreateConfig);
    const env = secretEnv(api);
    expect(env).toMatchObject({
      CONTROL_PLANE_URL: "https://10.43.250.21:8443",
      HTTPS_PROXY: "http://10.43.250.30:3128",
      https_proxy: "http://10.43.250.30:3128",
      NO_PROXY: "localhost,127.0.0.1,::1,10.43.250.21",
      NODE_USE_ENV_PROXY: "1",
    });
    const spec = api.pods.get(podName(names, G1))!.spec as Record<string, unknown>;
    // An IP-literal proxy makes the pod DNS-less.
    expect(spec.dnsPolicy).toBe("None");
    expect(podEnv(api, G1).SSL_CERT_FILE).toBe("/opt/openinspect-trust/ca-bundle.crt");
  });

  it("keeps cluster DNS when the proxy is named by hostname", async () => {
    const { api, provider } = setup({ egressProxyUrl: "http://egress-proxy:3128" });
    await provider.createSandbox(baseCreateConfig);
    expect((api.pods.get(podName(names, G1))!.spec as Record<string, unknown>).dnsPolicy).toBe(
      undefined
    );
  });

  it("adopts its own claim and pod on a retried create, and replaces the Secret", async () => {
    const { api, provider } = setup();
    await provider.createSandbox(baseCreateConfig);
    const pvcUid = api.pvcs.get(names.base)!.metadata.uid;
    await provider.createSandbox({ ...baseCreateConfig, sandboxAuthToken: "rotated" });
    expect(api.pvcs.get(names.base)!.metadata.uid).toBe(pvcUid);
    expect(secretEnv(api).SANDBOX_AUTH_TOKEN).toBe("rotated");
    expect(api.calls).toContain(`deleteSecret ${names.base}`);
  });

  it("refuses a claim that belongs to another session", async () => {
    const { api, provider } = setup();
    await provider.createSandbox(baseCreateConfig);
    api.pvcs.get(names.base)!.metadata.annotations![ANNOTATIONS.sessionId] = "other";
    const error = await provider.createSandbox(baseCreateConfig).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxProviderError);
    expect(error).toMatchObject({ errorType: "permanent" });
    expect((error as Error).message).toMatch(/exists for another sandbox/);
  });

  it("refuses a pod name taken by another generation", async () => {
    const { api, provider } = setup();
    api.seedPod(
      podName(names, G1),
      {},
      { [ANNOTATIONS.sandboxId]: "someone-else", [ANNOTATIONS.generationCreatedAtMs]: String(G1) }
    );
    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "permanent",
      message: expect.stringMatching(/another generation/),
    });
  });

  it.each([
    [
      "an unpullable image",
      {
        phase: "Pending",
        containerStatuses: [
          {
            name: "sandbox",
            state: { waiting: { reason: "ErrImagePull", message: "manifest unknown" } },
          },
        ],
      },
      /cannot be pulled/,
    ],
    [
      "a missing Secret",
      {
        phase: "Pending",
        containerStatuses: [
          {
            name: "sandbox",
            state: {
              waiting: { reason: "CreateContainerConfigError", message: 'secret "x" not found' },
            },
          },
        ],
      },
      /CreateContainerConfigError/,
    ],
    [
      "a failed preparation",
      {
        phase: "Pending",
        initContainerStatuses: [
          { name: "prepare", state: { terminated: { exitCode: 1, message: "mkdir failed" } } },
        ],
      },
      /preparation failed/,
    ],
  ])("fails permanently on %s and removes what it made", async (_label, status, message) => {
    const { api, provider } = setup();
    api.nextPodStatus = status;
    const error = await provider.createSandbox(baseCreateConfig).catch((e: unknown) => e);
    expect(error).toMatchObject({
      errorType: "permanent",
      message: expect.stringMatching(message),
    });
    expect(api.pods.size).toBe(0);
    expect(api.secrets.size).toBe(0);
    expect(api.pvcs.size).toBe(0);
  });

  it("times out transiently on an unschedulable pod and cleans up", async () => {
    const { api, provider } = setup();
    api.nextPodStatus = {
      phase: "Pending",
      conditions: [
        {
          type: "PodScheduled",
          status: "False",
          reason: "Unschedulable",
          message: "0/3 nodes are available: 1 node(s) were unschedulable",
        },
      ],
    };
    const error = await provider.createSandbox(baseCreateConfig).catch((e: unknown) => e);
    expect(error).toMatchObject({
      errorType: "transient",
      message: expect.stringMatching(/did not start within .*unschedulable/),
    });
    expect(api.pvcs.size).toBe(0);
  });

  it("never surfaces a crashed container's log tail", async () => {
    const { api, provider } = setup();
    api.nextPodStatus = {
      phase: "Failed",
      containerStatuses: [
        {
          name: "sandbox",
          state: {
            terminated: { exitCode: 2, reason: "Error", message: "SANDBOX_AUTH_TOKEN=leak" },
          },
        },
      ],
    };
    const error = (await provider
      .createSandbox(baseCreateConfig)
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/sandbox exited 2 \(Error\)/);
    expect(error.message).not.toContain("leak");
  });

  it("keeps objects on an unanswered request so lost-response recovery can find them", async () => {
    const { api, provider } = setup();
    const transport = new KubernetesTransportError("get pod", new TypeError("fetch failed"));
    api.getPod.mockRejectedValueOnce(transport);
    const error = await provider.createSandbox(baseCreateConfig).catch((e: unknown) => e);
    expect(error).toMatchObject({ errorType: "transient" });
    expect(provider.isUnknownStartupError(error)).toBe(true);
    expect(api.pods.has(podName(names, G1))).toBe(true);
    expect(api.pvcs.has(names.base)).toBe(true);
  });

  it.each([
    ["createPvc", "the claim"],
    ["createSecret", "the Secret"],
    ["createPod", "the pod"],
  ] as const)("fails on a rejected %s (%s) and leaves nothing behind", async (method, _object) => {
    const { api, provider } = setup();
    api[method].mockRejectedValueOnce(
      new KubernetesApiError(422, "Invalid", "denied by ValidatingAdmissionPolicy", method)
    );
    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "permanent",
      message: expect.stringMatching(/ValidatingAdmissionPolicy/),
    });
    expect(api.pods.size + api.secrets.size + api.pvcs.size).toBe(0);
  });

  it("fails transiently when the pod is deleted while it starts", async () => {
    const { api, provider } = setup();
    api.getPod.mockResolvedValueOnce(null);
    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "transient",
      message: expect.stringMatching(/deleted while starting/),
    });
  });

  it("retires a prebuilt image it cannot boot", async () => {
    const { provider } = setup();
    await expect(
      provider.createSandbox({ ...baseCreateConfig, prebuiltImageId: "img" })
    ).rejects.toBeInstanceOf(PrebuiltImageUnavailableError);
  });

  it("refuses to start without a default-deny egress policy", async () => {
    const { api, provider } = setup();
    api.networkPolicies = defaultNetworkPolicies().slice(1);
    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "permanent",
      message: expect.stringMatching(/no default-deny egress/),
    });
    expect(api.pvcs.size).toBe(0);
  });

  it("caches a passing preflight", async () => {
    const { api, provider } = setup();
    await provider.createSandbox(baseCreateConfig);
    await provider.createSandbox({ ...baseCreateConfig, sandboxId: "sandbox-2" });
    expect(api.listNetworkPolicies).toHaveBeenCalledTimes(1);
  });

  it("holds the sandbox until direct egress is blocked, unless the preflight is off", async () => {
    const prepare = (api: FakeKubernetesApi) =>
      (
        api.pods.get(podName(names, G1))!.spec as {
          initContainers: Array<{ command: string[] }>;
        }
      ).initContainers[0]!.command.join(" ");
    const strict = setup();
    await strict.provider.createSandbox(baseCreateConfig);
    expect(prepare(strict.api)).toContain("egress is not confined");
    const lax = setup({ requireNetworkPolicy: false });
    await lax.provider.createSandbox(baseCreateConfig);
    expect(prepare(lax.api)).not.toContain("egress is not confined");
  });

  it("skips the preflight when told to", async () => {
    const { api, provider } = setup({ requireNetworkPolicy: false });
    api.networkPolicies = [];
    await expect(provider.createSandbox(baseCreateConfig)).resolves.toBeDefined();
    expect(api.listNetworkPolicies).not.toHaveBeenCalled();
  });
});

describe("lost-response recovery", () => {
  it("names the pending allocation by the provider object id", async () => {
    const { provider } = setup();
    expect(await provider.pendingSandboxAllocation(baseCreateConfig)).toEqual({
      reference: names.base,
      lifetime: {
        kind: "finite",
        expiresAtMs: G1 + 3600 * 1000,
        observedAtMs: G1,
        source: "conservative_start_bound",
      },
    });
    expect(
      await provider.pendingSandboxAllocation({
        ...baseCreateConfig,
        generationCreatedAtMs: undefined,
      })
    ).toBeUndefined();
  });

  it("resolves the generation's pod and nothing else", async () => {
    const { provider } = setup();
    await provider.createSandbox(baseCreateConfig);
    const lookup = {
      sessionId: baseCreateConfig.sessionId,
      sandboxId: baseCreateConfig.sandboxId,
      generationCreatedAtMs: G1,
      timeoutSeconds: 3600,
    };
    await expect(provider.resolveSandbox(lookup)).resolves.toMatchObject({
      providerObjectId: names.base,
    });
    await expect(
      provider.resolveSandbox({ ...lookup, generationCreatedAtMs: G2 })
    ).rejects.toMatchObject({ errorType: "transient" });
  });

  it("marks an adopted create complete, so the GC keeps its workspace", async () => {
    const { api, provider } = setup();
    api.patchPvcMetadata.mockRejectedValueOnce(new KubernetesTransportError("patch", "lost"));
    await provider.createSandbox(baseCreateConfig);
    expect(annotation(api, ANNOTATIONS.createCompleteAtMs)).toBeUndefined();
    await provider.resolveSandbox({
      sessionId: baseCreateConfig.sessionId,
      sandboxId: baseCreateConfig.sandboxId,
      generationCreatedAtMs: G1,
      timeoutSeconds: 3600,
    });
    expect(annotation(api, ANNOTATIONS.createCompleteAtMs)).toBeDefined();
  });

  it("treats only unanswered requests and 5xx as unknown", () => {
    const { provider } = setup();
    const wrap = (cause: Error) => new SandboxProviderError("x", "transient", cause);
    expect(provider.isUnknownStartupError(wrap(new KubernetesTransportError("x", "y")))).toBe(true);
    expect(provider.isUnknownStartupError(wrap(new KubernetesApiError(503, "", "", "x")))).toBe(
      true
    );
    expect(provider.isUnknownStartupError(wrap(new KubernetesApiError(403, "", "", "x")))).toBe(
      false
    );
    expect(provider.isUnknownStartupError(new SandboxProviderError("timeout", "transient"))).toBe(
      false
    );
  });
});

describe("stopSandbox", () => {
  async function started() {
    const context = setup();
    await context.provider.createSandbox(baseCreateConfig);
    return context;
  }

  it("preserve deletes the pod, keeps the volume and stamps it stopped", async () => {
    const { api, provider } = await started();
    const result = await provider.stopSandbox({
      providerObjectId: names.base,
      sessionId: "sess-1",
      reason: "inactivity",
      intent: "preserve",
      generationCreatedAtMs: G1,
    });
    expect(result).toEqual({ success: true });
    expect(api.pods.size).toBe(0);
    expect(api.secrets.has(names.base)).toBe(true);
    expect(api.pvcs.get(names.base)!.metadata.annotations?.[ANNOTATIONS.stoppedAtMs]).toBeDefined();
  });

  it("a late preserve for an old generation leaves a newer generation's pod alone", async () => {
    const { api, provider } = await started();
    api.seedPod(podName(names, G2), api.pods.get(podName(names, G1))!.metadata.labels!, {
      [ANNOTATIONS.generationCreatedAtMs]: String(G2),
    });
    await provider.stopSandbox({
      providerObjectId: names.base,
      sessionId: "sess-1",
      reason: "late",
      intent: "preserve",
      generationCreatedAtMs: G1,
    });
    expect([...api.pods.keys()]).toEqual([podName(names, G2)]);
  });

  it("preserve without a generation stops every pod of the sandbox", async () => {
    const { api, provider } = await started();
    await provider.stopSandbox({
      providerObjectId: names.base,
      sessionId: "sess-1",
      reason: "coordinator",
      intent: "preserve",
    });
    expect(api.pods.size).toBe(0);
  });

  it("preserve reports a pod that outlives the deadline", async () => {
    const { api, provider } = await started();
    api.podsLinger = true;
    const result = await provider.stopSandbox({
      providerObjectId: names.base,
      sessionId: "sess-1",
      reason: "x",
      intent: "preserve",
      deadlineAtMs: Date.now() - 1,
    });
    expect(result).toEqual({
      success: false,
      error: expect.stringMatching(/still terminating/),
    });
  });

  it("preserve waits out a pod that takes a few polls to go", async () => {
    const { api, provider } = await started();
    api.podsLingerForListings = 3;
    await expect(provider.stopSandbox(preserveG1)).resolves.toEqual({ success: true });
    expect(api.pods.size).toBe(0);
    expect(api.listPods.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("preserve marks a create complete whose own mark was lost", async () => {
    const { api, provider } = setup();
    api.patchPvcMetadata.mockRejectedValueOnce(new KubernetesTransportError("patch", "lost"));
    await provider.createSandbox(baseCreateConfig);
    expect(annotation(api, ANNOTATIONS.createCompleteAtMs)).toBeUndefined();
    await provider.stopSandbox(preserveG1);
    expect(annotation(api, ANNOTATIONS.createCompleteAtMs)).toBeDefined();
  });

  it("leaves a pod alone that replaced the one it listed", async () => {
    const { api, provider } = await started();
    const original = api.listPods.getMockImplementation()!;
    api.listPods.mockImplementationOnce(async (selector) => {
      const listed = await original(selector);
      // Between the listing and the delete, the name gets a new pod.
      api.pods.get(podName(names, G1))!.metadata.uid = "uid-replacement";
      return listed;
    });
    api.podsLinger = true;
    const result = await provider.stopSandbox({ ...preserveG1, deadlineAtMs: Date.now() - 1 });
    expect(result).toMatchObject({ success: false });
    expect(api.pods.get(podName(names, G1))!.metadata.deletionTimestamp).toBeUndefined();
  });

  it("preserve fails when the workspace volume is gone", async () => {
    const { api, provider } = await started();
    api.pvcs.clear();
    const result = await provider.stopSandbox({
      providerObjectId: names.base,
      sessionId: "sess-1",
      reason: "x",
      intent: "preserve",
    });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/disappeared/) });
  });

  it("destroy deletes the pod and Secret and marks the volume for GC, without waiting", async () => {
    const { api, provider } = await started();
    api.podsLinger = true;
    const result = await provider.stopSandbox({
      providerObjectId: names.base,
      sessionId: "sess-1",
      reason: "respawn",
      intent: "destroy",
    });
    expect(result).toEqual({ success: true });
    expect(api.secrets.size).toBe(0);
    expect(
      api.pvcs.get(names.base)!.metadata.annotations?.[ANNOTATIONS.destroyRequestedAtMs]
    ).toBeDefined();
  });

  it("destroy marks the volume before it removes the Secret", async () => {
    const { api, provider } = await started();
    api.patchPvcMetadata.mockRejectedValueOnce(new KubernetesApiError(503, "", "unavailable", "x"));
    await expect(
      provider.stopSandbox({
        providerObjectId: names.base,
        sessionId: "sess-1",
        reason: "respawn",
        intent: "destroy",
      })
    ).rejects.toMatchObject({ errorType: "transient" });
    // Not released, so its Secret and pod must still be there for a resume.
    expect(api.secrets.has(names.base)).toBe(true);
    expect(api.pods.size).toBe(1);
  });

  it("destroy fails on a refused mark", async () => {
    const { api, provider } = await started();
    api.patchPvcMetadata.mockRejectedValueOnce(new KubernetesApiError(403, "Forbidden", "no", "x"));
    await expect(
      provider.stopSandbox({
        providerObjectId: names.base,
        sessionId: "sess-1",
        reason: "x",
        intent: "destroy",
      })
    ).rejects.toMatchObject({ errorType: "permanent" });
  });

  it("destroy of a sandbox that is already gone succeeds", async () => {
    const { provider } = setup();
    await expect(
      provider.stopSandbox({
        providerObjectId: names.base,
        sessionId: "sess-1",
        reason: "x",
        intent: "destroy",
      })
    ).resolves.toEqual({ success: true });
  });

  it("refuses an object id that is not its own", async () => {
    const { provider } = setup();
    await expect(
      provider.stopSandbox({
        providerObjectId: "sb-123",
        sessionId: "s",
        reason: "x",
        intent: "destroy",
      })
    ).resolves.toMatchObject({ success: false });
  });

  it("classifies API failures", async () => {
    const { api, provider } = await started();
    api.listPods.mockRejectedValueOnce(
      new KubernetesApiError(403, "Forbidden", "nope", "list pods")
    );
    await expect(
      provider.stopSandbox({
        providerObjectId: names.base,
        sessionId: "s",
        reason: "x",
        intent: "preserve",
      })
    ).rejects.toMatchObject({ errorType: "permanent" });
  });
});

describe("resumeSandbox", () => {
  const resume = {
    providerObjectId: names.base,
    sessionId: "sess-1",
    sandboxId: baseCreateConfig.sandboxId,
    timeoutSeconds: 1800,
    generationCreatedAtMs: G2,
  };

  async function stopped() {
    const context = setup();
    await context.provider.createSandbox(baseCreateConfig);
    await context.provider.stopSandbox({
      providerObjectId: names.base,
      sessionId: "sess-1",
      reason: "inactivity",
      intent: "preserve",
      generationCreatedAtMs: G1,
    });
    return context;
  }

  it("starts a new generation's pod on the same volume as a restored sandbox", async () => {
    const { api, provider } = await stopped();
    const pvcUid = api.pvcs.get(names.base)!.metadata.uid;
    const result = await provider.resumeSandbox(resume);
    expect(result).toMatchObject({
      success: true,
      providerObjectId: names.base,
      lifetime: { kind: "finite", expiresAtMs: G2 + 1800 * 1000 },
    });
    expect([...api.pods.keys()]).toEqual([podName(names, G2)]);
    expect(podEnv(api, G2)).toEqual({
      SANDBOX_TIMEOUT_SECONDS: "1800",
      RESTORED_FROM_SNAPSHOT: "true",
    });
    const pvc = api.pvcs.get(names.base)!;
    expect(pvc.metadata.uid).toBe(pvcUid);
    expect(pvc.metadata.annotations?.[ANNOTATIONS.stoppedAtMs]).toBeUndefined();
  });

  it("never adopts a previous pod: a lingering one is deleted first", async () => {
    const { api, provider } = setup();
    await provider.createSandbox(baseCreateConfig);
    await provider.resumeSandbox(resume);
    const [, options] = api.deletePod.mock.calls.find(([name]) => name === podName(names, G1))!;
    // Never a force delete: that drops the object while the container runs.
    expect(options?.gracePeriodSeconds).toBeGreaterThan(0);
    expect([...api.pods.keys()]).toEqual([podName(names, G2)]);
  });

  it("does not create its pod while the previous one is still terminating", async () => {
    const { api, provider } = setup();
    await provider.createSandbox(baseCreateConfig);
    api.podsLingerForListings = 3;
    const original = api.createPod.getMockImplementation()!;
    const oldPodsAtCreate: number[] = [];
    api.createPod.mockImplementation(async (body) => {
      oldPodsAtCreate.push(api.pods.has(podName(names, G1)) ? 1 : 0);
      return original(body);
    });
    await expect(provider.resumeSandbox(resume)).resolves.toMatchObject({ success: true });
    expect(oldPodsAtCreate).toEqual([0]);
    expect(api.listPods.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect([...api.pods.keys()]).toEqual([podName(names, G2)]);
  });

  it("asks for a fresh spawn when the volume is gone or was released", async () => {
    const { api, provider } = await stopped();
    api.pvcs.get(names.base)!.metadata.annotations![ANNOTATIONS.destroyRequestedAtMs] = "1";
    await expect(provider.resumeSandbox(resume)).resolves.toMatchObject({
      success: false,
      shouldSpawnFresh: true,
    });
    api.pvcs.clear();
    await expect(provider.resumeSandbox(resume)).resolves.toMatchObject({
      success: false,
      shouldSpawnFresh: true,
    });
  });

  it("asks for a fresh spawn when the garbage collector claimed the volume", async () => {
    const { api, provider } = await stopped();
    api.pvcs.get(names.base)!.metadata.annotations![ANNOTATIONS.gcClaimedAtMs] = "1";
    await expect(provider.resumeSandbox(resume)).resolves.toMatchObject({
      success: false,
      shouldSpawnFresh: true,
    });
    expect(api.createPod).toHaveBeenCalledTimes(1);
  });

  it("asks for a fresh spawn for an id that is not its own", async () => {
    const { provider } = setup();
    await expect(
      provider.resumeSandbox({ ...resume, providerObjectId: "sb-1" })
    ).resolves.toMatchObject({ success: false, shouldSpawnFresh: true });
  });

  it("re-reads the volume once when a concurrent writer changed it", async () => {
    const { api, provider } = await stopped();
    const original = api.patchPvcMetadata.getMockImplementation()!;
    api.patchPvcMetadata.mockImplementationOnce(async (name, patch) => {
      // Someone (the GC) touched the claim between our read and our write.
      await original(name, { annotations: { "touched-by": "gc" } });
      return original(name, patch);
    });
    await expect(provider.resumeSandbox(resume)).resolves.toMatchObject({ success: true });
    expect(api.patchPvcMetadata).toHaveBeenCalledTimes(4);
  });

  it("refuses to resume once the egress policy is gone", async () => {
    const { api, provider } = await stopped();
    api.networkPolicies = [];
    resetKubernetesPreflightCache();
    await expect(provider.resumeSandbox(resume)).rejects.toMatchObject({
      errorType: "permanent",
      message: expect.stringMatching(/Refusing to start sandboxes/),
    });
    expect(api.createPod).toHaveBeenCalledTimes(1);
    expect(api.pods.size).toBe(0);
  });

  it("asks for a fresh spawn when the GC claims the volume during the resume", async () => {
    const { api, provider } = await stopped();
    const original = api.patchPvcMetadata.getMockImplementation()!;
    api.patchPvcMetadata.mockImplementationOnce(async (name, patch) => {
      // The GC's resourceVersion-guarded claim lands between our read and our write.
      await original(name, { annotations: { [ANNOTATIONS.gcClaimedAtMs]: "1" } });
      return original(name, patch);
    });
    await expect(provider.resumeSandbox(resume)).resolves.toMatchObject({
      success: false,
      shouldSpawnFresh: true,
    });
    expect(api.createPod).toHaveBeenCalledTimes(1);
  });

  it("does not start beside a previous pod that will not go", async () => {
    let nowMs = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const api = new FakeKubernetesApi();
    const provider = new KubernetesSandboxProvider(api, {
      ...providerConfig,
      sleep: async (ms) => {
        nowMs += ms * 10_000;
      },
    });
    await provider.createSandbox(baseCreateConfig);
    api.podsLinger = true;
    await expect(provider.resumeSandbox(resume)).rejects.toMatchObject({
      errorType: "transient",
      message: expect.stringMatching(/previous sandbox pod was still terminating/),
    });
    expect([...api.pods.keys()]).toEqual([podName(names, G1)]);
  });

  it("marks a create complete whose own mark was lost", async () => {
    const { api, provider } = setup();
    api.patchPvcMetadata.mockRejectedValueOnce(new KubernetesTransportError("patch", "lost"));
    await provider.createSandbox(baseCreateConfig);
    await provider.resumeSandbox(resume);
    expect(annotation(api, ANNOTATIONS.createCompleteAtMs)).toBeDefined();
  });

  it("removes only its own pod when the new pod cannot start, and keeps the volume", async () => {
    const { api, provider } = await stopped();
    api.nextPodStatus = {
      phase: "Pending",
      containerStatuses: [
        { name: "sandbox", state: { waiting: { reason: "CreateContainerConfigError" } } },
      ],
    };
    await expect(provider.resumeSandbox(resume)).rejects.toMatchObject({ errorType: "permanent" });
    expect(api.pods.size).toBe(0);
    expect(api.pvcs.has(names.base)).toBe(true);
    expect(api.secrets.has(names.base)).toBe(true);
  });

  it("refuses a volume that belongs to another sandbox", async () => {
    const { provider } = await stopped();
    await expect(provider.resumeSandbox({ ...resume, sandboxId: "another" })).rejects.toMatchObject(
      { errorType: "permanent" }
    );
  });

  it("survives a resume after a node drain removed the pod", async () => {
    const { api, provider } = setup();
    await provider.createSandbox(baseCreateConfig);
    api.pods.clear();
    await expect(provider.resumeSandbox(resume)).resolves.toMatchObject({ success: true });
    expect(api.pods.get(podName(names, G2))!.status).toEqual(RUNNING_STATUS);
  });
});

describe("podStartVerdict", () => {
  const pod = (status: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
    metadata: { name: "p", ...metadata },
    status,
  });

  it("is running only when the sandbox container runs", () => {
    expect(podStartVerdict(pod(RUNNING_STATUS))).toEqual({ kind: "running" });
    expect(podStartVerdict(pod({ phase: "Running", containerStatuses: [] }))).toMatchObject({
      kind: "waiting",
    });
  });

  it("treats an eviction as transient and a crash as permanent", () => {
    expect(podStartVerdict(pod({ phase: "Failed", reason: "Evicted" }))).toMatchObject({
      kind: "failed",
      errorType: "transient",
    });
    expect(podStartVerdict(pod({ phase: "Failed" }))).toMatchObject({
      kind: "failed",
      errorType: "permanent",
    });
  });

  it("waits out a pull that may still succeed", () => {
    expect(
      podStartVerdict(
        pod({
          phase: "Pending",
          containerStatuses: [
            {
              name: "sandbox",
              state: { waiting: { reason: "ImagePullBackOff", message: "i/o timeout" } },
            },
          ],
        })
      )
    ).toEqual({ kind: "waiting", state: "ImagePullBackOff" });
  });

  it("fails a pod that is being deleted", () => {
    expect(podStartVerdict(pod(RUNNING_STATUS, { deletionTimestamp: "now" }))).toMatchObject({
      kind: "failed",
      errorType: "transient",
    });
  });
});

describe("evaluateEgressPolicies", () => {
  const deny = defaultNetworkPolicies()[0]!;
  const sandboxPolicy = (to: unknown[]): KubernetesNetworkPolicy =>
    ({
      metadata: { name: "sandbox-egress" },
      spec: {
        podSelector: { matchLabels: { [LABELS.role]: "sandbox" } },
        policyTypes: ["Egress"],
        egress: [{ to }],
      },
    }) as KubernetesNetworkPolicy;

  it("accepts default-deny plus in-cluster peers", () => {
    expect(evaluateEgressPolicies(defaultNetworkPolicies())).toBeNull();
  });

  it("rejects a default 'deny' that allows everything", () => {
    const allowAll = { ...deny, spec: { ...deny.spec, egress: [{}] } };
    expect(evaluateEgressPolicies([allowAll])).toMatch(/no default-deny/);
  });

  it("rejects sandbox egress to an ipBlock, to anywhere, or to every pod", () => {
    expect(
      evaluateEgressPolicies([deny, sandboxPolicy([{ ipBlock: { cidr: "0.0.0.0/0" } }])])
    ).toMatch(/ipBlock/);
    expect(evaluateEgressPolicies([deny, sandboxPolicy([])])).toMatch(/any destination/);
    expect(evaluateEgressPolicies([deny, sandboxPolicy([{ namespaceSelector: {} }])])).toMatch(
      /every pod/
    );
  });

  it("rejects sandbox egress to every pod of a namespace", () => {
    // Every pod in the sandbox namespace, other sandboxes included.
    expect(evaluateEgressPolicies([deny, sandboxPolicy([{ podSelector: {} }])])).toMatch(
      /every pod of a namespace/
    );
    // A whole other namespace.
    expect(
      evaluateEgressPolicies([
        deny,
        sandboxPolicy([
          { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } },
        ]),
      ])
    ).toMatch(/every pod of a namespace/);
    // Named pods in a named namespace pass.
    expect(
      evaluateEgressPolicies([
        deny,
        sandboxPolicy([
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "open-inspect" } },
            podSelector: { matchLabels: { app: "control-plane" } },
          },
        ]),
      ])
    ).toBeNull();
  });

  it("ignores policies that cannot select sandbox pods", () => {
    const proxyPolicy = {
      metadata: { name: "proxy" },
      spec: {
        podSelector: { matchLabels: { app: "egress-proxy" } },
        policyTypes: ["Egress"],
        egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }],
      },
    };
    expect(evaluateEgressPolicies([deny, proxyPolicy])).toBeNull();
  });
});

describe("resolveResources", () => {
  it("uses the shared defaults and raises a default cap to meet a larger request", () => {
    expect(resolveResources(undefined)).toMatchObject({
      cpuCores: 1,
      memoryMib: 2048,
      cpuLimitCores: 4,
      memoryLimitMib: 8192,
    });
    expect(resolveResources({ cpuCores: 8, memoryMib: 16384 })).toMatchObject({
      cpuLimitCores: 8,
      memoryLimitMib: 16384,
    });
    expect(resolveResources({ cpuCores: 2, cpuLimitCores: 3 })).toMatchObject({
      cpuLimitCores: 3,
    });
  });
});

describe("classifyKubernetesError", () => {
  it.each([
    [
      new KubernetesApiError(403, "Forbidden", "exceeded quota: sandbox-quota", "create pod"),
      "transient",
    ],
    [new KubernetesApiError(403, "Forbidden", "cannot create pods", "create pod"), "permanent"],
    [
      new KubernetesApiError(422, "Invalid", "denied by ValidatingAdmissionPolicy", "x"),
      "permanent",
    ],
    [new KubernetesApiError(429, "", "", "x"), "transient"],
    [new KubernetesApiError(500, "", "", "x"), "transient"],
    [new KubernetesTransportError("x", new TypeError("fetch failed")), "transient"],
  ])("%s is %s", (error, errorType) => {
    expect(classifyKubernetesError("ctx", error).errorType).toBe(errorType);
  });
});
