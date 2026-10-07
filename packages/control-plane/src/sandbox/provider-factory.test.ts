import { describe, expect, it } from "vitest";
import { createTestEnv } from "../router.test-support";
import type { Env } from "../types";
import { createSandboxProviderFromEnv, parseSandboxEnv } from "./provider-factory";

function createEnv(overrides: Partial<Env>): Env {
  return createTestEnv({ TOKEN_ENCRYPTION_KEY: "test-token-key", ...overrides });
}

describe("createSandboxProviderFromEnv", () => {
  it("rejects malformed Vercel numeric configuration", () => {
    const env = createEnv({
      VERCEL_TOKEN: "vercel-token",
      VERCEL_PROJECT_ID: "project-id",
      VERCEL_SNAPSHOT_EXPIRATION_MS: "10m",
    });

    expect(() => createSandboxProviderFromEnv(env, "vercel")).toThrow(
      "VERCEL_SNAPSHOT_EXPIRATION_MS must be a valid number"
    );
  });

  it("rejects malformed Daytona auto-stop configuration", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
      DAYTONA_AUTO_STOP_INTERVAL_MINUTES: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_AUTO_STOP_INTERVAL_MINUTES must be a valid number"
    );
  });

  it("rejects malformed Daytona auto-archive configuration", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
      DAYTONA_BASE_SNAPSHOT: "base",
      DAYTONA_AUTO_STOP_INTERVAL_MINUTES: "30",
      DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES: "abc",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES must be a valid number"
    );
  });

  it("needs a base snapshot to create Daytona sandboxes", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
    });

    expect(() => createSandboxProviderFromEnv(env, "daytona")).toThrow(
      "DAYTONA_BASE_SNAPSHOT is required to create Daytona sandboxes"
    );
  });

  it("still requires Daytona credentials", () => {
    expect(() =>
      createSandboxProviderFromEnv(
        createEnv({ DAYTONA_API_URL: "https://daytona.test" }),
        "daytona"
      )
    ).toThrow("DAYTONA_API_URL and DAYTONA_API_KEY are required");
  });

  it("rejects malformed E2B auto-pause configuration", () => {
    const env = createEnv({
      E2B_API_KEY: "e2b-key",
      E2B_TEMPLATE_ID: "tmpl",
      E2B_AUTO_PAUSE: "tru",
    });

    expect(() => createSandboxProviderFromEnv(env, "e2b")).toThrow(
      "E2B_AUTO_PAUSE must be a valid boolean"
    );
  });

  it("requires an OpenComputer template for starts but not existing-session cleanup", () => {
    const env = createEnv({
      OPENCOMPUTER_API_URL: "https://opencomputer.test",
      OPENCOMPUTER_API_KEY: "opencomputer-key",
    });

    expect(() => createSandboxProviderFromEnv(env, "opencomputer")).toThrow(
      "OPENCOMPUTER_TEMPLATE"
    );
    expect(() =>
      createSandboxProviderFromEnv(env, "opencomputer", {
        requireOpenComputerTemplate: false,
      })
    ).not.toThrow();
  });

  describe("kubernetes", () => {
    const kubernetes = {
      KUBERNETES_NAMESPACE: "open-inspect-sandboxes",
      KUBERNETES_SANDBOX_IMAGE: "registry.test/sandbox@sha256:abc",
      KUBERNETES_API_TOKEN: "test-token",
    };

    it("parses KUBERNETES_SANDBOX_ENV and rejects bad names without echoing values", () => {
      expect(parseSandboxEnv(undefined)).toEqual({});
      expect(parseSandboxEnv('{"ZHIPU_API_KEY":"k"}')).toEqual({ ZHIPU_API_KEY: "k" });
      expect(() => parseSandboxEnv("ZHIPU_API_KEY=k")).toThrow("must be a JSON object");
      expect(() => parseSandboxEnv('["k"]')).toThrow("must be a JSON object");
      expect(() => parseSandboxEnv('{"SANDBOX_AUTH_TOKEN":"secret-value"}')).toThrow("reserved");
      expect(() => parseSandboxEnv('{"KEY":1}')).toThrow("must be a string");
      expect(() => parseSandboxEnv('{"bad-name":"v"}')).toThrow("must match");
      expect(() =>
        createSandboxProviderFromEnv(
          createEnv({ ...kubernetes, KUBERNETES_SANDBOX_ENV: "not json" }),
          "kubernetes"
        )
      ).toThrow("KUBERNETES_SANDBOX_ENV");
    });

    it("builds the provider with the sandboxing runtime by default", () => {
      const provider = createSandboxProviderFromEnv(createEnv(kubernetes), "kubernetes");
      expect(provider.name).toBe("kubernetes");
      expect(provider.capabilities.supportsPersistentResume).toBe(true);
    });

    it("requires a namespace and an image", () => {
      expect(() =>
        createSandboxProviderFromEnv(
          createEnv({ ...kubernetes, KUBERNETES_SANDBOX_IMAGE: undefined }),
          "kubernetes"
        )
      ).toThrow("KUBERNETES_NAMESPACE and KUBERNETES_SANDBOX_IMAGE are required");
      expect(() =>
        createSandboxProviderFromEnv(
          createEnv({ ...kubernetes, KUBERNETES_NAMESPACE: "Not_A_Namespace" }),
          "kubernetes"
        )
      ).toThrow("not a valid namespace name");
    });

    it("requires credentials", () => {
      expect(() =>
        createSandboxProviderFromEnv(
          createEnv({ ...kubernetes, KUBERNETES_API_TOKEN: undefined }),
          "kubernetes"
        )
      ).toThrow(/ServiceAccount token/);
    });

    it("refuses the control plane's own namespace", () => {
      const env = createEnv({
        ...kubernetes,
        KUBERNETES_CREDENTIALS: { token: async () => "t", ownNamespace: "open-inspect-sandboxes" },
      });
      expect(() => createSandboxProviderFromEnv(env, "kubernetes")).toThrow(
        "must not be the control plane's own namespace"
      );
    });

    it("refuses an empty runtime class unless unsandboxed pods are allowed", () => {
      const unsandboxed = { ...kubernetes, KUBERNETES_RUNTIME_CLASS: "" };
      expect(() => createSandboxProviderFromEnv(createEnv(unsandboxed), "kubernetes")).toThrow(
        /sandboxing runtime/
      );
      expect(
        createSandboxProviderFromEnv(
          createEnv({ ...unsandboxed, KUBERNETES_ALLOW_UNSANDBOXED_RUNTIME: "true" }),
          "kubernetes"
        ).name
      ).toBe("kubernetes");
    });

    it("rejects malformed settings", () => {
      expect(() =>
        createSandboxProviderFromEnv(
          createEnv({ ...kubernetes, KUBERNETES_NODE_SELECTOR: "no-equals-sign" }),
          "kubernetes"
        )
      ).toThrow("KUBERNETES_NODE_SELECTOR entries must be key=value");
      expect(() =>
        createSandboxProviderFromEnv(
          createEnv({ ...kubernetes, KUBERNETES_POD_START_TIMEOUT_MS: "2m" }),
          "kubernetes"
        )
      ).toThrow("KUBERNETES_POD_START_TIMEOUT_MS must be a valid number");
      expect(() =>
        createSandboxProviderFromEnv(
          createEnv({ ...kubernetes, KUBERNETES_SANDBOX_CONTROL_PLANE_URL: "http://cp:8787" }),
          "kubernetes"
        )
      ).toThrow("must be an https URL");
      expect(() =>
        createSandboxProviderFromEnv(
          createEnv({ ...kubernetes, KUBERNETES_REQUIRE_NETWORK_POLICY: "maybe" }),
          "kubernetes"
        )
      ).toThrow("KUBERNETES_REQUIRE_NETWORK_POLICY must be a valid boolean");
      for (const host of ["probe.example.com", "1.1.1.1; true", "2001:db8::1 x"]) {
        expect(() =>
          createSandboxProviderFromEnv(
            createEnv({ ...kubernetes, KUBERNETES_EGRESS_PROBE_HOST: host }),
            "kubernetes"
          )
        ).toThrow("KUBERNETES_EGRESS_PROBE_HOST must be an IP address");
      }
      for (const host of ["203.0.113.9", "2001:db8::1"]) {
        expect(
          createSandboxProviderFromEnv(
            createEnv({ ...kubernetes, KUBERNETES_EGRESS_PROBE_HOST: host }),
            "kubernetes"
          ).name
        ).toBe("kubernetes");
      }
    });
  });
});
