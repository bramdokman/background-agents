import { describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { Logger } from "../logger";
import { projectSandboxLiveness } from "./sandbox-liveness-projection";

function build(sessionId: string | null = "session-1") {
  const inner = { broadcast: vi.fn(), sendToSandbox: vi.fn(async () => {}) };
  const sink = { live: vi.fn(async () => {}), dead: vi.fn(async () => {}) };
  const backgroundTasks = createTestBackgroundTasks();
  const messenger = projectSandboxLiveness(inner, {
    sink,
    getSessionId: () => sessionId,
    backgroundTasks,
    log: { warn: vi.fn(), error: vi.fn() } as unknown as Logger,
  });
  return { inner, sink, messenger, backgroundTasks };
}

describe("projectSandboxLiveness", () => {
  it("forwards every message and projects live and dead sandbox statuses", async () => {
    const { inner, sink, messenger, backgroundTasks } = build();
    messenger.broadcast({ type: "sandbox_status", status: "spawning" });
    messenger.broadcast({ type: "sandbox_status", status: "ready" });
    messenger.broadcast({ type: "processing_status", isProcessing: false });
    messenger.broadcast({ type: "sandbox_status", status: "stopped" });
    await backgroundTasks.settle();

    expect(inner.broadcast).toHaveBeenCalledTimes(4);
    expect(sink.live.mock.calls).toEqual([["session-1"], ["session-1"]]);
    expect(sink.dead.mock.calls).toEqual([["session-1"]]);
  });

  it("ignores the pending status and sessions without a public id", async () => {
    const { sink, messenger, backgroundTasks } = build();
    messenger.broadcast({ type: "sandbox_status", status: "pending" });
    const unnamed = build(null);
    unnamed.messenger.broadcast({ type: "sandbox_status", status: "ready" });
    await backgroundTasks.settle();
    await unnamed.backgroundTasks.settle();

    expect(sink.live).not.toHaveBeenCalled();
    expect(unnamed.sink.live).not.toHaveBeenCalled();
  });
});
