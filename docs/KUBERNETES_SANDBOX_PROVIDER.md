# Kubernetes Sandbox Provider

Open-Inspect can run sandboxes as pods on a Kubernetes cluster you operate. The control plane runs
in the same cluster as the Node host ([CONTROL_PLANE_CONTAINER.md](./CONTROL_PLANE_CONTAINER.md))
and creates sandboxes through the Kubernetes API with its own ServiceAccount. Nothing is hosted by a
third party.

Kubernetes was not built to run untrusted code, and a compromised pod or control plane must not
become a compromised cluster. The provider therefore refuses to run without a sandboxing runtime,
and the manifests in [`deploy/kubernetes`](../deploy/kubernetes) put several independent limits
around every sandbox. [Security model](#security-model) says what they do and do not cover.

> **Node host only.** The provider needs the pod's ServiceAccount token, which only the Node host
> reads
> ([`src/node/kubernetes-credentials.ts`](../packages/control-plane/src/node/kubernetes-credentials.ts)).
> The code compiles into the Workers bundle, but a Worker would need a publicly reachable API server
> and a long-lived token, which is not a configuration to run.

## How a sandbox maps to Kubernetes

| Open-Inspect               | Kubernetes                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox (provider object)  | A **PersistentVolumeClaim** `oi-<hash>`, the durable unit. `<hash>` is 20 hex characters of sha256(session id, sandbox id).                                                                                                                                                                                                                                                                                                                        |
| Session env                | An immutable **Secret** `oi-<hash>`, owned by the claim, read through `envFrom`. Holds `buildSandboxEnvVars()` output and the boot markers, so resume needs no env of its own.                                                                                                                                                                                                                                                                     |
| One execution (generation) | A **Pod** `oi-<hash>-<generation>`, `restartPolicy: Never`, `activeDeadlineSeconds` = the session timeout. One pod per generation, so a late stop for an old generation cannot name a new one.                                                                                                                                                                                                                                                     |
| Create                     | Claim, then Secret, then Pod; waits until the sandbox container runs (`KUBERNETES_POD_START_TIMEOUT_MS`). Readiness stays the runtime's `ready` event.                                                                                                                                                                                                                                                                                             |
| Preserve-stop              | Deletes the pod (and any older one), keeps the claim and Secret, stamps the claim `stopped-at` (and `create-complete-at` if a lost create never did).                                                                                                                                                                                                                                                                                              |
| Resume                     | Runs the egress preflight, deletes any previous pod (never adopts one) and waits for it to go, then starts a new pod on the same claim with `RESTORED_FROM_SNAPSHOT=true`: the runtime keeps the working tree and skips setup. A previous pod that will not go fails the resume transiently rather than share the volume. A claim that was destroyed or claimed by the garbage collector, before or during the resume, answers `shouldSpawnFresh`. |
| Destroy-stop               | Marks the claim `destroy-requested-at`, then deletes the pod and the Secret, so a claim without its Secret always reads as released. The garbage collector deletes the claim after a grace period, so a mistaken destroy is recoverable.                                                                                                                                                                                                           |
| Lost create response       | `pendingSandboxAllocation` records the deterministic claim name before the launch; `resolveSandbox` looks up the generation's pod and marks the claim complete; `isUnknownStartupError` flags unanswered requests and 5xx.                                                                                                                                                                                                                         |

The provider has the same capability shape as Daytona and E2B: `supportsPersistentResume` and
`supportsExplicitStop`, no snapshots. Stopping and resuming a sandbox keeps its volume, which is the
documented equivalent of a filesystem snapshot.

### What survives a stop

One volume, mounted at several subPaths:

| Path                      | Why                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/workspace`              | The repositories and everything installed into them.                                                            |
| `/tmp`                    | The bridge's agent session-id file and the runtime's handoff files: a resumed agent continues its conversation. |
| `~/.local/share/opencode` | OpenCode's conversation store.                                                                                  |
| `~/.openinspect`          | The Claude harness directory.                                                                                   |

The rest of `$HOME` stays image-owned, so an image upgrade reaches resumed sessions. An init
container, running as the sandbox user, creates the subPaths and copies image-owned files under them
(for example OpenCode's model catalog) without overwriting what the session wrote. System packages
are not persisted; the runtime user cannot install them anyway, so system dependencies belong in the
image.

### Not supported

- **code-server, the web terminal and VNC.** Each needs ingress into the pod; the provider returns
  no access URLs and tells the runtime they are off.
- **Docker inside the sandbox.** It would need a privileged pod.
- **Prebuilt (repository and environment) images.** Planned as a follow-up: a build pod fills a
  volume that new sessions start from (a CSI VolumeSnapshot where the storage supports one, a copy
  otherwise). Until then, image builds report the provider as unsupported.

## Requirements

- Kubernetes 1.30 or later (ValidatingAdmissionPolicy is GA from 1.30).
- A sandboxing runtime on the nodes that run sandboxes, exposed as a RuntimeClass: gVisor (`runsc`)
  or Kata.
  [`deploy/kubernetes/components/runtimeclass-gvisor`](../deploy/kubernetes/components/runtimeclass-gvisor)
  has a RuntimeClass for gVisor.
- A NetworkPolicy implementation that enforces egress rules.
- A StorageClass for workspace claims (`ReadWriteOnce`). `ReadWriteOncePod` would let the kubelet
  itself keep a second pod off a workspace, but Kubernetes supports it only for CSI volumes, and
  common single-node provisioners (k3s `local-path`) are not CSI. The provider therefore never
  starts a pod while a previous one on the same claim still exists: a resume deletes the earlier pod
  with a short positive grace period (never a force delete, which drops the Pod object before the
  kubelet has stopped its containers) and waits until the Pod object is gone. A previous pod on a
  node that does not answer stays terminating, and the resume then fails as transient instead of
  starting beside it.
- The sandbox image: `npm run sandbox:images -- build --provider kubernetes` builds it from the
  shared installation ([`packages/kubernetes-infra`](../packages/kubernetes-infra/build-image.py)),
  verifies it, and with `KUBERNETES_IMAGE_PUSH=true` pushes it and returns the digest reference.
  `KUBERNETES_VERIFY_RUNTIME=runsc` runs the verification under gVisor.

## Deploying

1. **Sandbox namespace.** Edit the image references in
   [`deploy/kubernetes/sandboxes/admission-policy.yaml`](../deploy/kubernetes/sandboxes/admission-policy.yaml)
   (the `sandboxImages` variable) and the allowlist in `allowlist.txt`, then
   `kubectl apply -k deploy/kubernetes/sandboxes`. Use an overlay to pin the proxy Service's
   ClusterIP and to add your nodes' own addresses to the proxy's NetworkPolicy and
   `blocked-destinations.txt`. The proxy resolves allowlisted names through public resolvers
   (`1.1.1.1` and `9.9.9.9`, marked `RESOLVERS` in `squid.conf` and `network-policies.yaml`); on a
   cluster that cannot reach them, change both places together
   (`npm run test:kubernetes-egress-proxy` checks that they agree) and set
   `KUBERNETES_EGRESS_PROBE_HOST` to an address your nodes can reach.
2. **Sandbox gateway certificate.** Sandboxes reach the control plane in-cluster, over TLS, through
   the gateway sidecar in
   [`control-plane.yaml`](../deploy/kubernetes/control-plane/control-plane.yaml). Create a CA and a
   server certificate for the Service's ClusterIP (pin it in an overlay) and store it as the Secret
   `open-inspect-sandbox-gateway-tls` in the control plane's namespace.
3. **Control plane.** Create the Secret `open-inspect-control-plane-env` with the settings from
   `.env.example`, including the ones below, then
   `kubectl apply -k deploy/kubernetes/control-plane`. The host's data volume must be writable by
   uid 1000: the Deployment sets `fsGroup: 1000`, which CSI drivers honour, but `hostPath`-backed
   provisioners (k3s `local-path` among them) ignore `fsGroup`, so the host's startup `chmod 700` of
   `DATA_DIR` fails with `EPERM` and the pod crash-loops. On such storage, add an init container in
   an overlay that mounts the volume as root with only the `CHOWN` and `FOWNER` capabilities and
   runs `chown 1000:1000 /data && chmod 700 /data`. Sandbox volumes are not affected: `local-path`
   creates them world-writable and the pod's `prepare` step creates the subPaths as the sandbox
   user. Once the host is up, bootstrap the first workspace Owner with the one-shot Job described in
   [CONTROL_PLANE_CONTAINER.md](./CONTROL_PLANE_CONTAINER.md#bootstrapping-the-workspace-owner).
4. **Check the cluster.** Nothing in the provider can verify these, so check them once per cluster:
   - Secrets are encrypted at rest. Each session's Secret holds its sandbox token and the user's and
     repository's secrets. On k3s, `k3s secrets-encrypt status` must report `Enabled`; enabling it
     restarts the server, then `k3s secrets-encrypt reencrypt` rewrites existing Secrets.
   - The sandboxing RuntimeClass declares its `overhead` (the component in
     [`runtimeclass-gvisor`](../deploy/kubernetes/components/runtimeclass-gvisor) does), so the
     ResourceQuota and the scheduler count gVisor's own memory.
     `kubectl get runtimeclass gvisor -o jsonpath='{.overhead}'` must not be empty.

```bash
SANDBOX_PROVIDER=kubernetes                       # set by the Deployment
KUBERNETES_NAMESPACE=open-inspect-sandboxes       # set by the Deployment
KUBERNETES_SANDBOX_IMAGE=registry.example.com/open-inspect-sandbox@sha256:...
KUBERNETES_EGRESS_PROXY_URL=http://<proxy-cluster-ip>:3128              # the proxy's pinned ClusterIP
KUBERNETES_SANDBOX_CONTROL_PLANE_URL=https://<gateway-cluster-ip>:8443   # the gateway's pinned ClusterIP
KUBERNETES_SANDBOX_CA_CERT="-----BEGIN CERTIFICATE-----..."   # the gateway's CA
KUBERNETES_NODE_SELECTOR=openinspect.dev/sandbox-node=true    # optional
```

The browser-facing control plane (`WORKER_URL`) and the web app are exposed however the cluster
exposes services; sandboxes never use that URL when `KUBERNETES_SANDBOX_CONTROL_PLANE_URL` is set.

### Configuration

| Variable                               | Default                          | Notes                                                                                                                         |
| -------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `KUBERNETES_NAMESPACE`                 | required                         | The sandbox namespace. Must not be the control plane's own (refused at startup).                                              |
| `KUBERNETES_SANDBOX_IMAGE`             | required                         | Pin a digest; the admission policy compares it exactly.                                                                       |
| `KUBERNETES_RUNTIME_CLASS`             | `gvisor`                         | `kata` (or your Kata class) works the same way.                                                                               |
| `KUBERNETES_ALLOW_UNSANDBOXED_RUNTIME` | `false`                          | `true` permits an empty runtime class. Throwaway test clusters only.                                                          |
| `KUBERNETES_STORAGE_CLASS`             | cluster default                  |                                                                                                                               |
| `KUBERNETES_WORKSPACE_SIZE`            | `20Gi`                           | A request: see [Disk](#disk).                                                                                                 |
| `KUBERNETES_NODE_SELECTOR`             | none                             | `key=value,key=value`.                                                                                                        |
| `KUBERNETES_POD_START_TIMEOUT_MS`      | 120000                           | How long create and resume wait for the container to run. Must stay inside the control plane's connect watchdog.              |
| `KUBERNETES_EGRESS_PROXY_URL`          | none                             | Injected as `HTTPS_PROXY`/`HTTP_PROXY`. An IP-literal host makes sandboxes DNS-less.                                          |
| `KUBERNETES_REQUIRE_NETWORK_POLICY`    | `true`                           | The egress preflight below.                                                                                                   |
| `KUBERNETES_EGRESS_PROBE_HOST`         | `1.1.1.1`                        | An IP address a pod must fail to reach directly before its sandbox starts (see Egress below).                                 |
| `KUBERNETES_SANDBOX_CONTROL_PLANE_URL` | `WORKER_URL`                     | An in-cluster `https` URL for sandboxes; added to `NO_PROXY`.                                                                 |
| `KUBERNETES_SANDBOX_CA_CERT`           | none                             | PEM appended to the sandbox's trust store (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`).                         |
| `KUBERNETES_SANDBOX_ENV`               | none                             | A JSON object of env every sandbox gets (a deployment-wide model key); user secrets override it. Readable inside the sandbox. |
| `KUBERNETES_API_URL`                   | `https://kubernetes.default.svc` |                                                                                                                               |
| `KUBERNETES_API_TOKEN`                 | none                             | A static token, for running the provider outside a pod (tests). The pod's own token is used otherwise.                        |

Per-session CPU and memory (Settings > Sandbox) map to pod requests and limits; the defaults are
`DEFAULT_KUBERNETES_*` in `packages/shared/src/types/integrations.ts`.

## Security model

Layers, from the inside out:

1. **Runtime.** Every pod in the sandbox namespace runs under the sandboxing RuntimeClass, as uid
   1000, with no capabilities, no privilege escalation, a RuntimeDefault seccomp profile and Pod
   Security `restricted` enforced on the namespace.
2. **No credentials.** No ServiceAccount token, no service links, no access to the control plane's
   namespace. The only secrets in a sandbox are its own session's, which the agent already holds by
   design.
3. **Egress.** A default-deny NetworkPolicy, then exactly two openings: an allowlisting CONNECT
   proxy (Squid, port 443, host names from `allowlist.txt`, private and tailnet ranges denied after
   resolution, resolving through public DNS) and the control plane's sandbox gateway. With an
   IP-literal proxy URL, sandboxes have no resolver at all. Before a create or resume, the provider
   refuses to start sandboxes unless the namespace has a pure default-deny egress policy and every
   peer of every policy that selects sandbox pods names specific pods: no `ipBlock`, no empty `to`,
   and no peer without a pod selector (a whole namespace) or with an empty one (every pod in a
   namespace, other sandboxes included). A passing check is cached for five minutes per namespace (a
   failing one never is), so a policy edit that opens the namespace is noticed by the next create or
   resume after at most five minutes. NetworkPolicy takes effect a moment after a pod starts (100 to
   300 ms on k3s with kube-router, measured), so the pod's `prepare` init container finishes only
   once a direct connection to an address outside the cluster (`KUBERNETES_EGRESS_PROBE_HOST`,
   `1.1.1.1` by default) fails, and fails the pod if that never happens within
   `EGRESS_ENFORCEMENT_WAIT_SECONDS`. The sandbox container never runs in that window.
4. **RBAC.** A Role in the sandbox namespace only: pods create/get/list/delete, claims
   create/get/list/patch/delete, Secrets create/delete, NetworkPolicies list. No exec, attach,
   port-forward, ephemeral containers, ServiceAccounts or RBAC objects; nothing cluster-scoped. The
   missing `get` on Secrets keeps the control plane from reading them back through the API, but it
   is not a confidentiality boundary: anything that may create pods could mount a Secret, which is
   what the next layer prevents.
5. **Admission.** Two ValidatingAdmissionPolicies pin every pod and claim in the namespace: the
   runtime class, exact image references, no token, the default ServiceAccount, no host namespaces,
   `hostAliases`, `imagePullSecrets` or `nodeName`; no ephemeral containers; only claim and emptyDir
   volumes; claims start empty (no `dataSource` clones). A pod is either a sandbox or the egress
   proxy, and neither may wear the other's labels, since NetworkPolicies select by label and add up.
   A sandbox pod carries exactly the provider's three labels, may mount only its own claim and read
   only its own Secret, and only the control plane's ServiceAccount may create one. A proxy pod is
   created only by the ReplicaSet controller for a ReplicaSet it owns, runs the pinned command, and
   reads no Secret.

A fully compromised control plane can therefore create only unprivileged, sandboxed pods running the
pinned image, each reading one session's Secret and volume, with egress limited to the allowlist.

**What this does not cover.** These layers protect the cluster's API from sandboxes and from the
control plane. They do not protect a node from what else runs on it:

- A runtime escape lands on the node. Run sandboxes on nodes dedicated to them (taint them, and
  select them with `KUBERNETES_NODE_SELECTOR` and the RuntimeClass's scheduling), never on
  control-plane nodes and never next to privileged workloads (CI runners with Docker-in-Docker, for
  example), which can read every Secret and volume on the node.
- Secrets are stored in etcd/the datastore; enable encryption at rest.
- Allowlisted hosts are exfiltration channels (an agent can push to any repository its token allows,
  or call an LLM API with its own key). Keep the allowlist to what sessions need.
- The session env is frozen at create: a secret a user rotates or deletes still reaches a resumed
  sandbox until the sandbox is destroyed. This matches Daytona and E2B.
- A sandbox may print its env; the sandbox container's termination message is therefore never
  surfaced, only its exit code and reason. The `prepare` init container's message is, since it
  receives no session Secret and reports why a pod cannot start (for example unconfined egress).

### Disk

Claim sizes are requests. Storage without size enforcement (k3s `local-path`, `hostPath`-based
provisioners) lets a workspace fill the node's disk, and `requests.storage` in the ResourceQuota
counts requests, not use. Put sandbox volumes on their own filesystem, or use a provisioner that
enforces sizes.

### Garbage collection

[`gc-cronjob.yaml`](../deploy/kubernetes/control-plane/gc-cronjob.yaml) runs every 15 minutes in the
control plane's namespace with its own narrow Role. It deletes pods that ended (their last container
terminated) more than an hour ago or lost their claim; and claims with no pod that a destroy
released more than a day ago, that a create never completed (no create-complete mark and never
preserve-stopped, after an hour), or whose last create, resume or preserve is older than a week.
Every resume and preserve-stop re-stamps a missing create-complete mark, so a lost mark cannot
expose a preserved workspace to the partial-create rule. A drained node's sandboxes keep the full
retention. A claim is annotated with a resourceVersion precondition before it is deleted, and the
provider treats a claimed volume as gone, so a resume and the collector cannot both win.

## Operations

- **Node drains and reboots.** A drained pod is deleted; the claim survives. The next prompt resumes
  the sandbox on a new pod. Do not put a PodDisruptionBudget on sandboxes: it would block drains.
- **Image upgrades.** Change `KUBERNETES_SANDBOX_IMAGE` and the policy's `sandboxImages` together
  (list both while sessions on the old image may resume). Resumed sessions run the new image on
  their old volume.
- **Admission policy values** are policy variables, not a params ConfigMap: on k3s v1.36.5 the API
  server did not notice a params ConfigMap created or changed after its binding.

## Testing

- Unit tests: `npm test -w @open-inspect/control-plane` (the REST client, the manifests, the
  provider against an in-memory API, the factory, the token reader), and
  `npm run test:kubernetes-gc` (the garbage collector's script against fixtures and a fake
  `kubectl`).
- Live: [`scripts/kubernetes-smoke.sh`](../scripts/kubernetes-smoke.sh) drives the provider against
  a cluster with the control plane's own identity and checks isolation, egress, admission (including
  the label and ephemeral-container bypasses), and that the workspace survives preserve, resume and
  a forced pod loss. Point `KUBERNETES_SANDBOX_IMAGE` at an image whose runtime idles, since no
  control plane answers it.
