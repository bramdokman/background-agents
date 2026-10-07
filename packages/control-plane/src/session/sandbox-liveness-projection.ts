import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import type { SessionMessenger } from "./messenger";

const LIVE_SANDBOX_STATUSES: ReadonlySet<SandboxStatus> = new Set([
  "spawning",
  "connecting",
  "warming",
  "ready",
  "snapshotting",
]);
const DEAD_SANDBOX_STATUSES: ReadonlySet<SandboxStatus> = new Set(["stopped", "failed", "stale"]);

export interface SandboxLivenessSink {
  /** The session's sandbox is live; keep its running-sandbox slot. */
  live(sessionId: string): Promise<void>;
  /** The session's sandbox is gone; free its slot. */
  dead(sessionId: string): Promise<void>;
}

/**
 * Keeps the global running-sandbox register in step with the session's
 * sandbox status. Every lifecycle collaborator — the manager, its watchdogs
 * and the shutdown coordinator — announces a status change to clients through
 * the one messenger, so observing `sandbox_status` there is the single seam
 * that sees them all; the register is a projection of what clients are told.
 * Each projection runs in the background and never affects delivery.
 */
export function projectSandboxLiveness(
  messenger: SessionMessenger,
  deps: {
    sink: SandboxLivenessSink;
    getSessionId: () => string | null;
    backgroundTasks: BackgroundTasks;
    log: Logger;
  }
): SessionMessenger {
  return {
    broadcast(message: ServerMessage): void {
      messenger.broadcast(message);
      if (message.type !== "sandbox_status") return;
      const sessionId = deps.getSessionId();
      if (!sessionId) return;
      const live = LIVE_SANDBOX_STATUSES.has(message.status);
      if (!live && !DEAD_SANDBOX_STATUSES.has(message.status)) return;
      deps.backgroundTasks.submit(
        () => (live ? deps.sink.live(sessionId) : deps.sink.dead(sessionId)),
        {
          name: "running_sandboxes.project",
          context: { session_id: sessionId, sandbox_status: message.status },
        }
      );
    },
    sendToSandbox: (command) => messenger.sendToSandbox(command),
  };
}
