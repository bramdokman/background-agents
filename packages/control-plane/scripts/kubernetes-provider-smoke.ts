/**
 * Drive the Kubernetes sandbox provider against a real cluster, one
 * lifecycle call per invocation, for scripts/kubernetes-smoke.sh.
 *
 *   KUBERNETES_API_URL, KUBERNETES_API_TOKEN, KUBERNETES_NAMESPACE,
 *   KUBERNETES_SANDBOX_IMAGE (and the other KUBERNETES_* settings) as for the
 *   control plane; NODE_EXTRA_CA_CERTS for the API server's CA.
 *
 *   kubernetes-provider-smoke create  <sessionId> <sandboxId> <generationMs>
 *   kubernetes-provider-smoke preserve <providerObjectId> <generationMs>
 *   kubernetes-provider-smoke resume  <providerObjectId> <sessionId> <sandboxId> <generationMs>
 *   kubernetes-provider-smoke destroy <providerObjectId>
 *
 * Prints the provider's result as JSON. Not part of the control plane.
 */

import { createSandboxProviderFromEnv } from "../src/sandbox/provider-factory";
import type { Env } from "../src/types";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const provider = createSandboxProviderFromEnv(process.env as unknown as Env, "kubernetes");
  const timeoutSeconds = Number(process.env.SMOKE_TIMEOUT_SECONDS ?? "1800");
  let result: unknown;
  switch (command) {
    case "create": {
      const [sessionId, sandboxId, generation] = args;
      result = await provider.createSandbox({
        sessionId: sessionId!,
        sandboxId: sandboxId!,
        generationCreatedAtMs: Number(generation),
        repoOwner: null,
        repoName: null,
        controlPlaneUrl: process.env.SMOKE_CONTROL_PLANE_URL ?? "https://control-plane.invalid",
        sandboxAuthToken: "smoke-token",
        harness: "opencode",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        timeoutSeconds,
        userEnvVars: { SMOKE_USER_SECRET: "visible-to-the-sandbox-only" },
      });
      break;
    }
    case "preserve":
    case "destroy": {
      const [providerObjectId, generation] = args;
      result = await provider.stopSandbox({
        providerObjectId: providerObjectId!,
        sessionId: "smoke",
        reason: "smoke",
        intent: command,
        generationCreatedAtMs: generation ? Number(generation) : undefined,
      });
      break;
    }
    case "resume": {
      const [providerObjectId, sessionId, sandboxId, generation] = args;
      result = await provider.resumeSandbox({
        providerObjectId: providerObjectId!,
        sessionId: sessionId!,
        sandboxId: sandboxId!,
        generationCreatedAtMs: Number(generation),
        timeoutSeconds,
      });
      break;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      errorType: (error as { errorType?: string }).errorType,
    })
  );
  process.exit(1);
});
