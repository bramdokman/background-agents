import { describe, expect, it } from "vitest";
import {
  ANNOTATIONS,
  buildEnvSecret,
  buildSandboxPod,
  buildWorkspaceClaim,
  DEFAULT_EGRESS_PROBE_HOST,
  LABELS,
  parseSandboxObjectId,
  PERSISTED_PATHS,
  podName,
  prepareScript,
  SANDBOX_UID,
  sandboxObjectNames,
  type SandboxPodInput,
} from "./kubernetes-manifests";

async function webCryptoSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("sandbox object names", () => {
  it("is a stable DNS-1123 name from the session and sandbox ids", async () => {
    const names = await sandboxObjectNames("sess-1", "sandbox-octo/sub-repo-1700000000000");
    expect(names).toEqual(
      await sandboxObjectNames("sess-1", "sandbox-octo/sub-repo-1700000000000")
    );
    expect(names.base).toMatch(/^oi-[0-9a-f]{20}$/);
    expect(names.base).toBe(`oi-${names.hash}`);
  });

  it("is the first 20 hex characters of sha256(sessionId NUL sandboxId)", async () => {
    // printf 'sess-1\0sandbox-1' | sha256sum
    expect(await sandboxObjectNames("sess-1", "sandbox-1")).toEqual({
      hash: "142a4bb3ce78218f3d69",
      base: "oi-142a4bb3ce78218f3d69",
    });
    const text = "héllo\0wörld".repeat(30);
    expect((await sandboxObjectNames(text, text)).hash).toBe(
      (await webCryptoSha256(`${text}\0${text}`)).slice(0, 20)
    );
  });

  it("differs for two sessions that share a sandbox id (same-millisecond spawns)", async () => {
    const sandboxId = "sandbox-octo-repo-1700000000000";
    expect((await sandboxObjectNames("sess-a", sandboxId)).base).not.toBe(
      (await sandboxObjectNames("sess-b", sandboxId)).base
    );
  });

  it("parses only its own provider object ids", async () => {
    const names = await sandboxObjectNames("s", "x");
    expect(parseSandboxObjectId(names.base)).toEqual(names);
    expect(parseSandboxObjectId("modal-vm-session:[]")).toBeNull();
    expect(parseSandboxObjectId(`${names.base}-x`)).toBeNull();
  });

  it("names one pod per generation, within 63 characters", async () => {
    const names = await sandboxObjectNames("s", "x");
    const name = podName(names, 1_791_234_567_890);
    expect(name).toBe(`${names.base}-${(1_791_234_567_890).toString(36)}`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(podName(names, 1)).not.toBe(podName(names, 2));
  });
});

const names = await sandboxObjectNames("sess-1", "sandbox-1");
const claim = { name: names.base, uid: "pvc-uid" };

function podInput(overrides: Partial<SandboxPodInput> = {}): SandboxPodInput {
  return {
    names,
    claim,
    sessionId: "sess-1",
    sandboxId: "sandbox-1",
    generationCreatedAtMs: 1_700_000_000_000,
    image: "registry.test/sandbox@sha256:abc",
    runtimeClassName: "gvisor",
    nodeSelector: {},
    timeoutSeconds: 3600,
    resources: {
      cpuCores: 1,
      memoryMib: 2048,
      cpuLimitCores: 4,
      memoryLimitMib: 8192,
      ephemeralStorageLimit: "10Gi",
    },
    generationEnv: { SANDBOX_TIMEOUT_SECONDS: "3600" },
    dnsless: false,
    ...overrides,
  };
}

type PodLike = {
  metadata: { name: string; labels: Record<string, string>; annotations: Record<string, string> };
  spec: Record<string, unknown> & {
    securityContext: Record<string, unknown>;
    initContainers: Array<Record<string, unknown>>;
    containers: Array<Record<string, unknown>>;
    volumes: Array<Record<string, unknown>>;
  };
};

describe("buildSandboxPod", () => {
  const pod = buildSandboxPod(podInput()) as unknown as PodLike;

  it("meets Pod Security restricted and carries no credentials", () => {
    expect(pod.spec).toMatchObject({
      runtimeClassName: "gvisor",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: "Never",
      activeDeadlineSeconds: 3600,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: SANDBOX_UID,
        runAsGroup: SANDBOX_UID,
        seccompProfile: { type: "RuntimeDefault" },
      },
    });
    expect(pod.spec.hostNetwork).toBeUndefined();
    expect(pod.spec.serviceAccountName).toBeUndefined();
    for (const container of [...pod.spec.initContainers, ...pod.spec.containers]) {
      expect(container.securityContext).toEqual({
        allowPrivilegeEscalation: false,
        capabilities: { drop: ["ALL"] },
        runAsNonRoot: true,
      });
      expect(container.terminationMessagePolicy).toBe("FallbackToLogsOnError");
      expect(container.image).toBe("registry.test/sandbox@sha256:abc");
    }
    // Only the workspace claim: no secret, projected, hostPath or configMap volumes.
    expect(pod.spec.volumes).toEqual([
      { name: "workspace", persistentVolumeClaim: { claimName: names.base } },
    ]);
  });

  it("reads env from its Secret and lets per-generation values override it", () => {
    const sandbox = pod.spec.containers[0]!;
    expect(sandbox.envFrom).toEqual([{ secretRef: { name: names.base } }]);
    expect(sandbox.env).toEqual([{ name: "SANDBOX_TIMEOUT_SECONDS", value: "3600" }]);
  });

  it("labels and annotates the generation, owned by the workspace claim", () => {
    expect(pod.metadata.name).toBe(podName(names, 1_700_000_000_000));
    expect(pod.metadata.labels).toEqual({
      [LABELS.managedBy]: "open-inspect",
      [LABELS.role]: "sandbox",
      [LABELS.sandbox]: names.hash,
    });
    expect(pod.metadata.annotations[ANNOTATIONS.generationCreatedAtMs]).toBe("1700000000000");
    expect(pod.metadata).toMatchObject({
      ownerReferences: [{ kind: "PersistentVolumeClaim", name: names.base, uid: "pvc-uid" }],
    });
  });

  it("mounts every persisted path from the one volume, and the whole volume for preparation", () => {
    expect(pod.spec.containers[0]!.volumeMounts).toEqual(
      PERSISTED_PATHS.map((path) => ({
        name: "workspace",
        mountPath: path.mountPath,
        subPath: path.subPath,
      }))
    );
    expect(pod.spec.initContainers[0]!.volumeMounts).toEqual([
      { name: "workspace", mountPath: "/oi-volume" },
    ]);
    expect(PERSISTED_PATHS.map((path) => path.mountPath)).toEqual(
      expect.arrayContaining(["/workspace", "/tmp"])
    );
  });

  it("maps resources to requests and limits", () => {
    expect(pod.spec.containers[0]!.resources).toEqual({
      requests: { cpu: "1000m", memory: "2048Mi" },
      limits: { cpu: "4000m", memory: "8192Mi", "ephemeral-storage": "10Gi" },
    });
  });

  it("omits the runtime class only when unsandboxed pods were allowed", () => {
    const spec = (buildSandboxPod(podInput({ runtimeClassName: null })) as unknown as PodLike).spec;
    expect(spec.runtimeClassName).toBeUndefined();
  });

  it("gives a DNS-less pod a resolver that fails at once", () => {
    const spec = (buildSandboxPod(podInput({ dnsless: true })) as unknown as PodLike).spec;
    expect(spec.dnsPolicy).toBe("None");
    expect(spec.dnsConfig).toMatchObject({ nameservers: ["127.0.0.1"] });
    expect(pod.spec.dnsPolicy).toBeUndefined();
  });

  it("assembles an extra CA into an emptyDir trust bundle", () => {
    const spec = (
      buildSandboxPod(podInput({ caCert: "-----BEGIN CERTIFICATE-----" })) as unknown as PodLike
    ).spec;
    expect(spec.volumes).toContainEqual({ name: "trust", emptyDir: { sizeLimit: "1Mi" } });
    expect(spec.initContainers[0]!.env).toEqual([
      { name: "OI_EXTRA_CA_CERT", value: "-----BEGIN CERTIFICATE-----" },
    ]);
    const env = spec.containers[0]!.env as Array<{ name: string; value: string }>;
    expect(env).toContainEqual({
      name: "SSL_CERT_FILE",
      value: "/opt/openinspect-trust/ca-bundle.crt",
    });
    expect(env).toContainEqual({
      name: "NODE_EXTRA_CA_CERTS",
      value: "/opt/openinspect-trust/extra-ca.crt",
    });
  });

  it("hands the probe host to the prepare step", () => {
    const spec = (
      buildSandboxPod(
        podInput({ verifyEgressDenied: true, egressProbeHost: "203.0.113.9" })
      ) as unknown as PodLike
    ).spec;
    const command = spec.initContainers[0]!.command as string[];
    expect(command[2]).toContain(`socket.create_connection(("203.0.113.9", 443)`);
  });

  it("applies a node selector", () => {
    const spec = (
      buildSandboxPod(
        podInput({ nodeSelector: { "kubernetes.io/hostname": "n1" } })
      ) as unknown as PodLike
    ).spec;
    expect(spec.nodeSelector).toEqual({ "kubernetes.io/hostname": "n1" });
  });
});

describe("prepareScript", () => {
  const script = prepareScript();

  it("creates every persisted subPath and seeds image files without clobbering", () => {
    for (const path of PERSISTED_PATHS) {
      expect(script).toContain(`mkdir -p "$v/${path.subPath}"`);
    }
    expect(script).toContain(
      `if [ -d "/tmp/opencode" ]; then mkdir -p "$v/tmp/opencode" && cp -an "/tmp/opencode/." "$v/tmp/opencode/"; fi`
    );
    expect(script).not.toContain(`cp -an "/tmp/."`);
    expect(script).toContain(`chmod 1777 "$v/tmp"`);
    expect(script.startsWith("set -eu")).toBe(true);
  });

  it("waits for default-deny egress last, and only when asked to", () => {
    expect(script).not.toContain(DEFAULT_EGRESS_PROBE_HOST);
    const verified = prepareScript({ verifyEgressDenied: true });
    expect(verified.startsWith(script)).toBe(true);
    expect(verified).toContain(`socket.create_connection(("${DEFAULT_EGRESS_PROBE_HOST}", 443)`);
    expect(verified).toMatch(/sys\.exit\("egress is not confined/);
  });

  it("probes the configured address instead of the default", () => {
    const verified = prepareScript({ verifyEgressDenied: true, egressProbeHost: "203.0.113.9" });
    expect(verified).toContain(`socket.create_connection(("203.0.113.9", 443)`);
    expect(verified).toContain("203.0.113.9:443 still succeeds");
    expect(verified).not.toContain(DEFAULT_EGRESS_PROBE_HOST);
    // The probe host is only ever used with the egress check.
    expect(prepareScript({ egressProbeHost: "203.0.113.9" })).toBe(script);
  });
});

describe("workspace claim and env secret", () => {
  it("builds an RWO claim with the identity annotations", () => {
    const pvc = buildWorkspaceClaim({
      names,
      sessionId: "sess-1",
      sandboxId: "sandbox-1",
      repo: "octo/repo",
      storageClassName: "local-path",
      size: "20Gi",
      nowMs: 5,
    }) as { metadata: { annotations: Record<string, string> }; spec: Record<string, unknown> };
    expect(pvc.metadata.annotations).toEqual({
      [ANNOTATIONS.sessionId]: "sess-1",
      [ANNOTATIONS.sandboxId]: "sandbox-1",
      [ANNOTATIONS.lastActiveAtMs]: "5",
      [ANNOTATIONS.repo]: "octo/repo",
    });
    expect(pvc.spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "20Gi" } },
      storageClassName: "local-path",
    });
  });

  it("builds an immutable Opaque Secret owned by the claim", () => {
    const secret = buildEnvSecret(names, claim, { A: "1" });
    expect(secret).toMatchObject({
      type: "Opaque",
      immutable: true,
      stringData: { A: "1" },
      metadata: {
        name: names.base,
        ownerReferences: [{ kind: "PersistentVolumeClaim", uid: "pvc-uid" }],
      },
    });
  });
});
