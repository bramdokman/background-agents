#!/usr/bin/env bash
# Opt-in live test of the Kubernetes sandbox provider (not run in CI).
#
# Needs a cluster with deploy/kubernetes/sandboxes applied, the
# open-inspect-control-plane ServiceAccount in the control plane's namespace,
# the sandbox image available to the nodes, and an admin kubeconfig (used to
# mint the ServiceAccount's token and to look inside the pods). It drives the
# provider as the control plane would, with the control plane's identity:
# create, preserve-stop, resume, a forced pod kill and resume, destroy; and
# checks isolation, egress and that the workspace survives. Removes what it
# created, including the workspace claim a destroy leaves for the GC.
#
#   KUBERNETES_SANDBOX_IMAGE=registry/sandbox@sha256:... scripts/kubernetes-smoke.sh
#
# Direct-egress targets are derived from the cluster: the API server's
# endpoints and Service IP, the kubeconfig's server address, and the kubelet
# on each address of the sandbox's node. Optional:
#   KUBERNETES_RUNTIME_CLASS     expected runtime class (default gvisor; the
#                                gVisor kernel check runs only for gvisor)
#   SMOKE_EXTRA_BLOCKED_TARGETS  more URLs a sandbox must not reach directly,
#                                space-separated (e.g. a VPN or metadata address)
#   SMOKE_NODE_SHELL             a command that runs its argument as a shell
#                                script, as root, on the egress proxy's node
#                                (e.g. "ssh root@node"). Enables the check that
#                                the proxy never resolves a name off its
#                                allowlist (needs tcpdump on the node).
set -euo pipefail

: "${KUBERNETES_SANDBOX_IMAGE:?KUBERNETES_SANDBOX_IMAGE is required}"
export KUBERNETES_NAMESPACE="${KUBERNETES_NAMESPACE:-open-inspect-sandboxes}"
export KUBERNETES_RUNTIME_CLASS="${KUBERNETES_RUNTIME_CLASS-gvisor}"
control_plane_namespace="${CONTROL_PLANE_NAMESPACE:-open-inspect}"
service_account=open-inspect-control-plane
control_plane_user="system:serviceaccount:${control_plane_namespace}:${service_account}"
ns="$KUBERNETES_NAMESPACE"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
failures=0
claim=""

cleanup() {
  if [[ -n "$claim" ]]; then
    kubectl -n "$ns" delete pods -l "openinspect.dev/sandbox=${claim#oi-}" --grace-period=0 --ignore-not-found >/dev/null 2>&1 || true
    kubectl -n "$ns" delete secret "$claim" --ignore-not-found >/dev/null 2>&1 || true
    kubectl -n "$ns" delete pvc "$claim" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
check() { # check <description> <command...>
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi
}
refuse() { # refuse <description> <command...>: passes when the command fails
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then fail "$description"; else pass "$description"; fi
}
now_ms() { date +%s%3N; }

npx --no-install esbuild "$root/packages/control-plane/scripts/kubernetes-provider-smoke.ts" \
  --bundle --platform=node --format=esm --log-level=warning --outfile="$work/smoke.mjs"
export KUBERNETES_API_URL="${KUBERNETES_API_URL:-$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')}"
kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' |
  base64 -d >"$work/ca.crt"
export NODE_EXTRA_CA_CERTS="$work/ca.crt"
KUBERNETES_API_TOKEN="$(kubectl create token "$service_account" -n "$control_plane_namespace" --duration=1h)"
export KUBERNETES_API_TOKEN
smoke() { node "$work/smoke.mjs" "$@"; }

# URLs a sandbox must not reach without the proxy. IPv6 addresses get brackets.
url_host() { if [[ "$1" == *:* ]]; then printf '[%s]' "$1"; else printf '%s' "$1"; fi; }
blocked_targets() {
  local node address port
  printf '%s\n' https://1.1.1.1 http://169.254.169.254
  printf 'https://%s\n' "$(url_host "$(kubectl get service kubernetes -n default -o jsonpath='{.spec.clusterIP}')")"
  # The API server's own addresses, which the Service forwards to.
  kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes -o json |
    jq -r '.items[] | .ports[0].port as $p | .endpoints[].addresses[] | "\(.) \($p)"' |
    while read -r address port; do printf 'https://%s:%s\n' "$(url_host "$address")" "$port"; done
  # The address this kubeconfig reaches the API server on, unless it is local.
  case "$KUBERNETES_API_URL" in
    https://127.* | https://localhost* | https://\[::1\]*) ;;
    *) printf '%s\n' "$KUBERNETES_API_URL" ;;
  esac
  # The kubelet on every address of the sandbox's node.
  node="$(kubectl -n "$ns" get pod "$1" -o jsonpath='{.spec.nodeName}')"
  kubectl get node "$node" -o json |
    jq -r '.status.addresses[] | select(.type == "InternalIP" or .type == "ExternalIP") | .address' |
    while read -r address; do printf 'https://%s:10250\n' "$(url_host "$address")"; done
  for address in ${SMOKE_EXTRA_BLOCKED_TARGETS:-}; do printf '%s\n' "$address"; done
}

sandbox_pods() { kubectl -n "$ns" get pods -l "openinspect.dev/sandbox=${claim#oi-}" -o jsonpath='{.items[*].metadata.name}'; }
in_sandbox() { kubectl -n "$ns" exec "$1" -c sandbox -- sh -c "$2"; }

session="smoke-$(date +%s)"
sandbox="sandbox-smoke-$(now_ms)"
marker="smoke-$(now_ms)"

echo "== create"
g1="$(now_ms)"
created="$(smoke create "$session" "$sandbox" "$g1")"
echo "$created"
claim="$(jq -r .providerObjectId <<<"$created")"
pod="$(sandbox_pods)"
check "pod runs under the ${KUBERNETES_RUNTIME_CLASS:-default} runtime class" \
  test "$(kubectl -n "$ns" get pod "$pod" -o jsonpath='{.spec.runtimeClassName}')" = "$KUBERNETES_RUNTIME_CLASS"
check "the prepare step waited for default-deny egress before the sandbox started" \
  bash -c "kubectl -n $ns get pod $pod -o json | jq -e '.spec.initContainers[0].command[2] | contains(\"egress is not confined\")'"
if [[ "$KUBERNETES_RUNTIME_CLASS" == gvisor ]]; then
  check "kernel is gVisor" in_sandbox "$pod" 'dmesg 2>/dev/null | grep -qi gvisor || uname -r | grep -qi gvisor'
fi
check "runs as uid 1000" in_sandbox "$pod" 'test "$(id -u)" = 1000'
refuse "no ServiceAccount token in the pod" in_sandbox "$pod" 'ls /var/run/secrets/kubernetes.io/serviceaccount'
refuse "no service links beyond the API server's" \
  in_sandbox "$pod" 'env | grep _SERVICE_HOST= | grep -qv ^KUBERNETES_SERVICE_HOST='

check "session env arrives from the Secret" in_sandbox "$pod" 'test "$SMOKE_USER_SECRET" = visible-to-the-sandbox-only'
check "egress: allowlisted host through the proxy" \
  in_sandbox "$pod" 'curl -fsS -o /dev/null --max-time 20 https://api.github.com'
refuse "egress: other host through the proxy" \
  in_sandbox "$pod" 'curl -fsS -o /dev/null --max-time 10 https://example.com'
for target in $(blocked_targets "$pod"); do
  refuse "egress: direct $target is blocked" \
    in_sandbox "$pod" "curl -sk --noproxy '*' -o /dev/null --max-time 5 $target"
done
if [[ -n "${SMOKE_NODE_SHELL:-}" ]]; then
  # A name off the allowlist must be refused before Squid resolves it: any
  # lookup would carry the name to its authoritative server (DNS exfiltration).
  exfil_name="smoke-exfil-$(now_ms).invalid-oi-smoke.dev"
  proxy_ip="$(kubectl -n "$ns" get pods -l app.kubernetes.io/name=egress-proxy -o jsonpath='{.items[0].status.podIP}')"
  $SMOKE_NODE_SHELL "timeout 12 tcpdump -nli any 'port 53 and host $proxy_ip' 2>/dev/null" >"$work/dns.log" &
  capture=$!
  sleep 3
  in_sandbox "$pod" "curl -s -o /dev/null --max-time 5 https://$exfil_name" 2>/dev/null || true
  capture_status=0
  wait "$capture" || capture_status=$?
  # 124: tcpdump ran for the whole window, so an empty capture means something.
  check "egress: DNS capture on the proxy's node ran" test "$capture_status" = 124
  refuse "egress: the proxy does not resolve a name off its allowlist" grep -qi "$exfil_name" "$work/dns.log"
fi
if [[ -n "${KUBERNETES_SANDBOX_CONTROL_PLANE_URL:-}" ]]; then
  # The in-cluster gateway, over TLS from the deployment's CA, for each client stack.
  probe="$KUBERNETES_SANDBOX_CONTROL_PLANE_URL/sessions/smoke"
  check "control plane gateway: curl trusts the CA" \
    in_sandbox "$pod" "test \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 $probe)\" != 000"
  check "control plane gateway: Python (httpx, as the runtime) trusts the CA" \
    in_sandbox "$pod" "/opt/openinspect/python/bin/python -c 'import httpx; httpx.get(\"$probe\", timeout=10)'"
  check "control plane gateway: Node trusts the CA" \
    in_sandbox "$pod" "node -e 'fetch(\"$probe\").then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })'"
fi
refuse "egress: no DNS resolution in the sandbox" \
  in_sandbox "$pod" 'python3 -c "import socket; socket.getaddrinfo(\"github.com\", 443)"'
in_sandbox "$pod" "echo $marker > /workspace/smoke-marker && echo $marker > /tmp/agent-session-id-smoke"

echo "== admission (as the control plane)"
template="$(kubectl -n "$ns" get pod "$pod" -o json |
  jq 'del(.status, .metadata.uid, .metadata.resourceVersion, .metadata.creationTimestamp,
          .metadata.managedFields, .metadata.ownerReferences, .spec.nodeName)
      | .metadata.name = (.metadata.name + "-probe")')"
admit() { kubectl create --dry-run=server --as="$control_plane_user" -f - <<<"$1"; }
check "the provider's own pod shape is admitted" admit "$template"
refuse "a pod without the runtime class is rejected" admit "$(jq 'del(.spec.runtimeClassName)' <<<"$template")"
refuse "a pod with runc's class is rejected" admit "$(jq '.spec.runtimeClassName = "crun"' <<<"$template")"
refuse "a foreign image is rejected" admit "$(jq '.spec.containers[0].image = "busybox:1.37"' <<<"$template")"
refuse "a ServiceAccount token is rejected" admit "$(jq '.spec.automountServiceAccountToken = true' <<<"$template")"
refuse "another session's Secret is rejected" \
  admit "$(jq '.spec.containers[0].envFrom[0].secretRef.name = "oi-00000000000000000000"' <<<"$template")"
refuse "a secret volume is rejected" \
  admit "$(jq '.spec.volumes += [{"name":"s","secret":{"secretName":"x"}}]' <<<"$template")"
refuse "a hostPath volume is rejected" \
  admit "$(jq '.spec.volumes += [{"name":"h","hostPath":{"path":"/"}}]' <<<"$template")"
refuse "hostNetwork is rejected" admit "$(jq '.spec.hostNetwork = true' <<<"$template")"
refuse "another identity cannot create sandbox pods" \
  kubectl create --dry-run=server -f - <<<"$template"
# NetworkPolicies select by label and add up: a sandbox wearing the proxy's
# label would get the proxy's direct egress, and a proxy-shaped pod could
# read any session's Secret.
refuse "a sandbox pod wearing the egress proxy's label is rejected" \
  admit "$(jq '.metadata.labels["app.kubernetes.io/name"] = "egress-proxy"' <<<"$template")"
proxy_template="$(kubectl -n "$ns" get pods -l app.kubernetes.io/name=egress-proxy -o json |
  jq '.items[0] | del(.status, .metadata.uid, .metadata.resourceVersion, .metadata.creationTimestamp,
          .metadata.managedFields, .metadata.ownerReferences, .metadata.generateName, .spec.nodeName)
      | .metadata.name = "proxy-probe"')"
refuse "a proxy pod not made by its ReplicaSet is rejected" admit "$proxy_template"
refuse "a proxy-shaped pod reading a session Secret is rejected" \
  admit "$(jq --arg s "$claim" '.spec.containers[0].envFrom = [{"secretRef":{"name":$s}}]
    | .spec.containers[0].command = ["/bin/sh", "-c", "env"]' <<<"$proxy_template")"
refuse "an ephemeral container is rejected" \
  kubectl -n "$ns" patch pod "$pod" --subresource=ephemeralcontainers --dry-run=server --type=strategic \
  -p "$(jq -c '{spec: {ephemeralContainers: [{name: "debug", image: .spec.containers[0].image,
    securityContext: .spec.containers[0].securityContext}]}}' <<<"$template")"

echo "== preserve-stop"
smoke preserve "$claim" "$g1"
check "the pod is gone" test -z "$(sandbox_pods)"
check "the workspace claim is kept and stamped" \
  test -n "$(kubectl -n "$ns" get pvc "$claim" -o jsonpath='{.metadata.annotations.openinspect\.dev/stopped-at-ms}')"

echo "== resume"
g2="$(now_ms)"
smoke resume "$claim" "$session" "$sandbox" "$g2"
pod="$(sandbox_pods)"
check "resumed on the same claim with the workspace intact" in_sandbox "$pod" "grep -qx $marker /workspace/smoke-marker"
check "/tmp survived (agent session-id file)" in_sandbox "$pod" "grep -qx $marker /tmp/agent-session-id-smoke"
check "resume boots as restored" in_sandbox "$pod" 'test "$RESTORED_FROM_SNAPSHOT" = true'

echo "== forced pod loss (drain), then resume"
kubectl -n "$ns" delete pod "$pod" --grace-period=0 --force >/dev/null 2>&1
g3="$(now_ms)"
smoke resume "$claim" "$session" "$sandbox" "$g3"
pod="$(sandbox_pods)"
check "workspace intact after a forced pod loss" in_sandbox "$pod" "grep -qx $marker /workspace/smoke-marker"

echo "== resume over a running pod"
old_pod="$pod"
g4="$(now_ms)"
smoke resume "$claim" "$session" "$sandbox" "$g4"
pod="$(sandbox_pods)"
check "only the new pod remains" test "$pod" != "$old_pod" -a "$(wc -w <<<"$pod")" = 1
check "workspace intact after replacing a running pod" in_sandbox "$pod" "grep -qx $marker /workspace/smoke-marker"

echo "== destroy"
smoke destroy "$claim"
sleep 2
check "the Secret is gone" bash -c "! kubectl -n $ns get secret $claim"
check "the claim is marked for the GC" \
  test -n "$(kubectl -n "$ns" get pvc "$claim" -o jsonpath='{.metadata.annotations.openinspect\.dev/destroy-requested-at-ms}')"
resumed="$(smoke resume "$claim" "$session" "$sandbox" "$(now_ms)")"
check "a destroyed sandbox asks for a fresh spawn" test "$(jq -r .shouldSpawnFresh <<<"$resumed")" = true

echo
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
