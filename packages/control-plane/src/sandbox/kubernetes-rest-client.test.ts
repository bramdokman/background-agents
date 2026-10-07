import { describe, expect, it, vi } from "vitest";
import {
  KubernetesApiError,
  KubernetesConflictError,
  KubernetesRestClient,
  KubernetesTransportError,
  isDnsLabel,
  staticKubernetesCredentials,
} from "./kubernetes-rest-client";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(responses: Array<Response | Error>, tokens = ["token-1"]) {
  const calls: Call[] = [];
  let tokenIndex = 0;
  const credentials = {
    token: vi.fn(async (options?: { refresh?: boolean }) => {
      if (options?.refresh) tokenIndex = Math.min(tokenIndex + 1, tokens.length - 1);
      return tokens[tokenIndex]!;
    }),
  };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  return {
    api: new KubernetesRestClient({
      apiUrl: "https://k8s.test/",
      namespace: "oi-sandboxes",
      credentials,
      fetch: fetchImpl as unknown as typeof fetch,
      sleep,
    }),
    calls,
    credentials,
    sleep,
  };
}

const pod = (name: string) => ({ metadata: { name, uid: `uid-${name}` }, status: {} });

describe("KubernetesRestClient", () => {
  it("rejects an invalid namespace", () => {
    expect(
      () =>
        new KubernetesRestClient({
          apiUrl: "https://k8s.test",
          namespace: "Bad_NS",
          credentials: staticKubernetesCredentials("t"),
        })
    ).toThrow(/Invalid Kubernetes namespace/);
  });

  it("creates objects in its namespace with a bearer token", async () => {
    const { api, calls } = client([jsonResponse(201, pod("oi-a-1"))]);
    const created = await api.createPod({ metadata: { name: "oi-a-1" } });
    expect(created.metadata.name).toBe("oi-a-1");
    expect(calls[0]).toMatchObject({
      url: "https://k8s.test/api/v1/namespaces/oi-sandboxes/pods",
      method: "POST",
      body: { metadata: { name: "oi-a-1" } },
    });
    expect(calls[0]!.headers.Authorization).toBe("Bearer token-1");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
  });

  it("patches PVC metadata with a merge patch", async () => {
    const { api, calls } = client([jsonResponse(200, { metadata: { name: "oi-a" } })]);
    await api.patchPvcMetadata("oi-a", { resourceVersion: "7", annotations: { a: null } });
    expect(calls[0]).toMatchObject({
      url: "https://k8s.test/api/v1/namespaces/oi-sandboxes/persistentvolumeclaims/oi-a",
      method: "PATCH",
      body: { metadata: { resourceVersion: "7", annotations: { a: null } } },
    });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/merge-patch+json");
  });

  it("lists pods by label selector and network policies by API group", async () => {
    const { api, calls } = client([
      jsonResponse(200, { items: [pod("a"), pod("b")] }),
      jsonResponse(200, { items: null }),
    ]);
    expect((await api.listPods("x=y,z=w")).map((p) => p.metadata.name)).toEqual(["a", "b"]);
    expect(await api.listNetworkPolicies()).toEqual([]);
    expect(calls[0]!.url).toBe(
      "https://k8s.test/api/v1/namespaces/oi-sandboxes/pods?labelSelector=x%3Dy%2Cz%3Dw"
    );
    expect(calls[1]!.url).toBe(
      "https://k8s.test/apis/networking.k8s.io/v1/namespaces/oi-sandboxes/networkpolicies"
    );
  });

  it("answers null for a missing object and treats a missing delete as done", async () => {
    const { api } = client([
      jsonResponse(404, { reason: "NotFound", message: "pods not found" }),
      jsonResponse(404, { reason: "NotFound", message: "secrets not found" }),
    ]);
    expect(await api.getPod("gone")).toBeNull();
    await expect(api.deleteSecret("gone")).resolves.toBeUndefined();
  });

  it("sends delete options with a uid precondition", async () => {
    const { api, calls } = client([jsonResponse(200, {})]);
    await api.deletePvc("oi-a", {
      propagationPolicy: "Foreground",
      uid: "u1",
      gracePeriodSeconds: 0,
    });
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      body: {
        kind: "DeleteOptions",
        apiVersion: "v1",
        gracePeriodSeconds: 0,
        propagationPolicy: "Foreground",
        preconditions: { uid: "u1" },
      },
    });
  });

  it("releases every body it does not read", async () => {
    const answers = [
      jsonResponse(200, { kind: "Status" }),
      jsonResponse(404, { reason: "NotFound" }),
      jsonResponse(401, { message: "Unauthorized" }),
      jsonResponse(200, pod("p")),
    ];
    const { api } = client([...answers], ["stale", "fresh"]);
    await api.deletePod("p");
    await api.deleteSecret("gone");
    await api.getPod("p");
    expect(answers.map((response) => response.bodyUsed)).toEqual([true, true, true, true]);
  });

  it("raises a conflict error for 409", async () => {
    const { api } = client([jsonResponse(409, { reason: "AlreadyExists", message: "exists" })]);
    const error = await api.createPvc({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubernetesConflictError);
    expect(error).toMatchObject({ status: 409, reason: "AlreadyExists" });
  });

  it("re-reads the token once on 401", async () => {
    const { api, calls, credentials } = client(
      [jsonResponse(401, { message: "Unauthorized" }), jsonResponse(200, pod("p"))],
      ["stale", "fresh"]
    );
    await api.getPod("p");
    expect(credentials.token).toHaveBeenLastCalledWith({ refresh: true });
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("gives up on a second 401", async () => {
    const { api } = client(
      [
        jsonResponse(401, { message: "Unauthorized" }),
        jsonResponse(401, { message: "Unauthorized" }),
      ],
      ["stale", "still-stale"]
    );
    await expect(api.getPod("p")).rejects.toMatchObject({ status: 401 });
  });

  it("retries 429 and 5xx answers, then reports the last one", async () => {
    const { api, sleep } = client([
      jsonResponse(429, { message: "slow down" }, { "retry-after": "1" }),
      jsonResponse(503, { message: "unavailable" }),
      jsonResponse(503, { message: "still unavailable" }),
    ]);
    const error = await api.listPods("a=b").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubernetesApiError);
    expect(error).toMatchObject({ status: 503, apiMessage: "still unavailable" });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
  });

  it("retries transport failures and wraps the last one", async () => {
    const { api } = client([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    const error = await api.getPvc("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubernetesTransportError);
  });

  it("succeeds after a transient failure", async () => {
    const { api } = client([new TypeError("fetch failed"), jsonResponse(200, pod("p"))]);
    await expect(api.getPod("p")).resolves.toMatchObject({ metadata: { name: "p" } });
  });

  it("keeps only the Status reason and a truncated message, never the request", async () => {
    const { api } = client([
      jsonResponse(422, { reason: "Invalid", message: `bad ${"x".repeat(1000)}` }),
    ]);
    const error = (await api
      .createSecret({ stringData: { SANDBOX_AUTH_TOKEN: "super-secret" } })
      .catch((e: unknown) => e)) as KubernetesApiError;
    expect(error.status).toBe(422);
    expect(error.message).not.toContain("super-secret");
    expect(error.apiMessage.length).toBeLessThanOrEqual(301);
  });
});

describe("isDnsLabel", () => {
  it.each([
    ["open-inspect-sandboxes", true],
    ["a", true],
    ["-a", false],
    ["A", false],
    ["a".repeat(64), false],
  ])("%s → %s", (value, expected) => {
    expect(isDnsLabel(value)).toBe(expected);
  });
});
