/**
 * A small Kubernetes REST client over `fetch`, covering exactly the calls the
 * Kubernetes sandbox provider makes in its own namespace.
 *
 * Hand-written rather than `@kubernetes/client-node`: the sandbox tree is also
 * bundled for Workers (`--platform=browser`), where the official client's Node
 * transports (fs, net, tls, child_process exec auth) do not belong, and the
 * provider needs about a dozen endpoints. Error messages carry the API's
 * `Status.reason` and `Status.message` only, never a request or response body:
 * a Secret create carries every session secret.
 */

import { z } from "zod";
import type { KubernetesCredentials } from "../platform-ports";
import { createLogger } from "../logger";
import { withRequestDeadline } from "./request-deadline";

const log = createLogger("kubernetes-rest-client");

/** Default per-request budget; a request that hangs past it is a transport failure. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Attempts for a request answered with 429 or 5xx, or not answered at all. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const MAX_RETRY_AFTER_MS = 2_000;
/** API messages are kept short: they end up in logs and user-visible failure reasons. */
const MAX_STATUS_MESSAGE_LENGTH = 300;

// ---------------------------------------------------------------------------
// Object shapes (only the fields the provider reads; the rest pass through)
// ---------------------------------------------------------------------------

const objectMetaSchema = z
  .object({
    name: z.string(),
    namespace: z.string().optional(),
    uid: z.string().optional(),
    resourceVersion: z.string().optional(),
    creationTimestamp: z.string().optional(),
    deletionTimestamp: z.string().nullable().optional(),
    labels: z.record(z.string(), z.string()).nullable().optional(),
    annotations: z.record(z.string(), z.string()).nullable().optional(),
  })
  .passthrough();

const containerStateSchema = z
  .object({
    waiting: z.object({ reason: z.string().optional(), message: z.string().optional() }).optional(),
    running: z.object({ startedAt: z.string().optional() }).passthrough().optional(),
    terminated: z
      .object({
        exitCode: z.number().optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const containerStatusSchema = z
  .object({
    name: z.string(),
    ready: z.boolean().optional(),
    state: containerStateSchema.optional(),
  })
  .passthrough();

const podSchema = z
  .object({
    metadata: objectMetaSchema,
    spec: z.record(z.string(), z.unknown()).optional(),
    status: z
      .object({
        phase: z.string().optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
        conditions: z
          .array(
            z
              .object({
                type: z.string(),
                status: z.string(),
                reason: z.string().optional(),
                message: z.string().optional(),
              })
              .passthrough()
          )
          .optional(),
        initContainerStatuses: z.array(containerStatusSchema).optional(),
        containerStatuses: z.array(containerStatusSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type KubernetesPod = z.infer<typeof podSchema>;

const pvcSchema = z
  .object({
    metadata: objectMetaSchema,
    spec: z.record(z.string(), z.unknown()).optional(),
    status: z.object({ phase: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export type KubernetesPvc = z.infer<typeof pvcSchema>;

const labelSelectorSchema = z
  .object({
    matchLabels: z.record(z.string(), z.string()).nullable().optional(),
    matchExpressions: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();

const networkPolicyPeerSchema = z
  .object({
    podSelector: labelSelectorSchema.nullable().optional(),
    namespaceSelector: labelSelectorSchema.nullable().optional(),
    ipBlock: z.object({ cidr: z.string() }).passthrough().nullable().optional(),
  })
  .passthrough();

const networkPolicySchema = z
  .object({
    metadata: objectMetaSchema,
    spec: z
      .object({
        podSelector: labelSelectorSchema,
        policyTypes: z.array(z.string()).nullable().optional(),
        egress: z
          .array(
            z
              .object({
                to: z.array(networkPolicyPeerSchema).nullable().optional(),
                ports: z.array(z.unknown()).nullable().optional(),
              })
              .passthrough()
          )
          .nullable()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type KubernetesNetworkPolicy = z.infer<typeof networkPolicySchema>;

const listSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item).nullable().optional() }).passthrough();

const statusSchema = z
  .object({
    reason: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A non-2xx answer from the API server. Carries the Status reason and message only. */
export class KubernetesApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    readonly apiMessage: string,
    readonly operation: string
  ) {
    super(
      `Kubernetes ${operation} failed: HTTP ${status}${reason ? ` ${reason}` : ""}: ${apiMessage}`
    );
    this.name = "KubernetesApiError";
  }
}

/** 409: the object exists already, or a precondition (uid, resourceVersion) no longer holds. */
export class KubernetesConflictError extends KubernetesApiError {
  constructor(reason: string | undefined, apiMessage: string, operation: string) {
    super(409, reason, apiMessage, operation);
    this.name = "KubernetesConflictError";
  }
}

/** The request never got an answer: network failure, reset, or the per-request deadline. */
export class KubernetesTransportError extends Error {
  constructor(
    readonly operation: string,
    cause: unknown
  ) {
    super(
      `Kubernetes ${operation} did not complete: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = "KubernetesTransportError";
  }
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export interface DeleteOptions {
  gracePeriodSeconds?: number;
  propagationPolicy?: "Foreground" | "Background" | "Orphan";
  /** Delete only the object with this uid; a newer object of the same name is left alone. */
  uid?: string;
  signal?: AbortSignal;
}

/**
 * Everything the provider does to the cluster, in its one namespace. An
 * interface so provider tests run against an in-memory fake. `get*` returns
 * null for 404; `delete*` treats 404 as done.
 */
export interface KubernetesApi {
  readonly namespace: string;
  createPvc(body: Record<string, unknown>, signal?: AbortSignal): Promise<KubernetesPvc>;
  getPvc(name: string, signal?: AbortSignal): Promise<KubernetesPvc | null>;
  /** JSON merge patch of metadata. A `resourceVersion` in the patch is an optimistic-lock precondition. */
  patchPvcMetadata(
    name: string,
    metadata: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<KubernetesPvc>;
  deletePvc(name: string, options?: DeleteOptions): Promise<void>;
  createSecret(body: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  deleteSecret(name: string, options?: DeleteOptions): Promise<void>;
  createPod(body: Record<string, unknown>, signal?: AbortSignal): Promise<KubernetesPod>;
  getPod(name: string, signal?: AbortSignal): Promise<KubernetesPod | null>;
  listPods(labelSelector: string, signal?: AbortSignal): Promise<KubernetesPod[]>;
  deletePod(name: string, options?: DeleteOptions): Promise<void>;
  listNetworkPolicies(signal?: AbortSignal): Promise<KubernetesNetworkPolicy[]>;
}

export interface KubernetesRestConfig {
  apiUrl: string;
  namespace: string;
  credentials: KubernetesCredentials;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  /** Injected in tests to skip retry backoff. */
  sleep?: (ms: number) => Promise<void>;
}

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface RequestOptions {
  body?: unknown;
  contentType?: string;
  query?: Record<string, string>;
  signal?: AbortSignal;
  /** 404 resolves to null instead of throwing. */
  allowNotFound?: boolean;
}

/** A static token, for hosts without a credentials port (and tests). */
export function staticKubernetesCredentials(token: string): KubernetesCredentials {
  return { token: async () => token };
}

export class KubernetesRestClient implements KubernetesApi {
  readonly namespace: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: KubernetesRestConfig) {
    if (!config.apiUrl) throw new Error("KubernetesRestClient requires apiUrl");
    if (!isDnsLabel(config.namespace)) {
      throw new Error(`Invalid Kubernetes namespace: ${config.namespace}`);
    }
    this.namespace = config.namespace;
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private core(resource: string, name?: string): string {
    const base = `/api/v1/namespaces/${this.namespace}/${resource}`;
    return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
  }

  async createPvc(body: Record<string, unknown>, signal?: AbortSignal): Promise<KubernetesPvc> {
    return pvcSchema.parse(
      await this.request("POST", this.core("persistentvolumeclaims"), "create pvc", {
        body,
        signal,
      })
    );
  }

  async getPvc(name: string, signal?: AbortSignal): Promise<KubernetesPvc | null> {
    const raw = await this.request("GET", this.core("persistentvolumeclaims", name), "get pvc", {
      signal,
      allowNotFound: true,
    });
    return raw === null ? null : pvcSchema.parse(raw);
  }

  async patchPvcMetadata(
    name: string,
    metadata: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<KubernetesPvc> {
    return pvcSchema.parse(
      await this.request("PATCH", this.core("persistentvolumeclaims", name), "patch pvc", {
        body: { metadata },
        contentType: "application/merge-patch+json",
        signal,
      })
    );
  }

  async deletePvc(name: string, options: DeleteOptions = {}): Promise<void> {
    await this.delete(this.core("persistentvolumeclaims", name), "delete pvc", options);
  }

  async createSecret(body: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    // The response echoes the Secret's data; it is discarded unread.
    await this.request("POST", this.core("secrets"), "create secret", { body, signal });
  }

  async deleteSecret(name: string, options: DeleteOptions = {}): Promise<void> {
    await this.delete(this.core("secrets", name), "delete secret", options);
  }

  async createPod(body: Record<string, unknown>, signal?: AbortSignal): Promise<KubernetesPod> {
    return podSchema.parse(
      await this.request("POST", this.core("pods"), "create pod", { body, signal })
    );
  }

  async getPod(name: string, signal?: AbortSignal): Promise<KubernetesPod | null> {
    const raw = await this.request("GET", this.core("pods", name), "get pod", {
      signal,
      allowNotFound: true,
    });
    return raw === null ? null : podSchema.parse(raw);
  }

  async listPods(labelSelector: string, signal?: AbortSignal): Promise<KubernetesPod[]> {
    const raw = await this.request("GET", this.core("pods"), "list pods", {
      query: { labelSelector },
      signal,
    });
    return listSchema(podSchema).parse(raw).items ?? [];
  }

  async deletePod(name: string, options: DeleteOptions = {}): Promise<void> {
    await this.delete(this.core("pods", name), "delete pod", options);
  }

  async listNetworkPolicies(signal?: AbortSignal): Promise<KubernetesNetworkPolicy[]> {
    const raw = await this.request(
      "GET",
      `/apis/networking.k8s.io/v1/namespaces/${this.namespace}/networkpolicies`,
      "list networkpolicies",
      { signal }
    );
    return listSchema(networkPolicySchema).parse(raw).items ?? [];
  }

  private async delete(path: string, operation: string, options: DeleteOptions): Promise<void> {
    const body: Record<string, unknown> = { kind: "DeleteOptions", apiVersion: "v1" };
    if (options.gracePeriodSeconds !== undefined) {
      body.gracePeriodSeconds = options.gracePeriodSeconds;
    }
    if (options.propagationPolicy) body.propagationPolicy = options.propagationPolicy;
    if (options.uid) body.preconditions = { uid: options.uid };
    await this.request("DELETE", path, operation, {
      body,
      signal: options.signal,
      allowNotFound: true,
    });
  }

  /**
   * One API call with bounded retries. 429 and 5xx answers and transport
   * failures are retried: every write the provider makes is either keyed by a
   * deterministic name (a repeated create answers 409, which the provider
   * adopts or replaces) or carries a precondition, so a retry cannot double an
   * effect. A 401 re-reads the token once, since a rotated projected token is
   * the usual cause.
   */
  private async request(
    method: HttpMethod,
    path: string,
    operation: string,
    options: RequestOptions
  ): Promise<unknown> {
    let refreshedToken = false;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.send(method, path, operation, options, refreshedToken);
      } catch (error) {
        if (options.signal?.aborted || attempt >= MAX_ATTEMPTS) {
          throw new KubernetesTransportError(operation, error);
        }
        await this.sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }

      if (response.ok) {
        if (method === "DELETE") return await discardBody(response);
        return await response.json();
      }
      if (response.status === 404 && options.allowNotFound) return await discardBody(response);
      if (response.status === 401 && !refreshedToken) {
        await discardBody(response);
        refreshedToken = true;
        attempt--;
        continue;
      }
      const { reason, message } = await readStatus(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS && !options.signal?.aborted) {
        log.warn("kubernetes.request_retry", {
          operation,
          status: response.status,
          attempt,
        });
        await this.sleep(retryDelayMs(response, attempt));
        continue;
      }
      if (response.status === 409) throw new KubernetesConflictError(reason, message, operation);
      throw new KubernetesApiError(response.status, reason, message, operation);
    }
  }

  private async send(
    method: HttpMethod,
    path: string,
    operation: string,
    options: RequestOptions,
    refreshToken: boolean
  ): Promise<Response> {
    const token = await this.config.credentials.token(refreshToken ? { refresh: true } : undefined);
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = options.contentType ?? "application/json";
    }
    return withRequestDeadline(
      "kubernetes",
      operation,
      REQUEST_TIMEOUT_MS,
      options.signal,
      (signal) =>
        this.fetchImpl(`${this.baseUrl}${path}${query}`, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal,
        })
    );
  }
}

async function readStatus(response: Response): Promise<{ reason?: string; message: string }> {
  try {
    const parsed = statusSchema.safeParse(await response.json());
    if (parsed.success) {
      return {
        reason: parsed.data.reason,
        message: truncate(parsed.data.message ?? response.statusText ?? ""),
      };
    }
  } catch {
    // Not a Status object; fall through to the status line.
  }
  return { message: truncate(response.statusText ?? "") };
}

/** Release an unread body, so the connection can be reused instead of waiting for GC. */
async function discardBody(response: Response): Promise<null> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or errored; nothing is held.
  }
  return null;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
  }
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

function truncate(text: string): string {
  return text.length > MAX_STATUS_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_STATUS_MESSAGE_LENGTH)}…`
    : text;
}

/** RFC 1123 label: the shape of a namespace name. */
export function isDnsLabel(value: string): boolean {
  return /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(value);
}

export function createKubernetesRestClient(config: KubernetesRestConfig): KubernetesRestClient {
  return new KubernetesRestClient(config);
}
