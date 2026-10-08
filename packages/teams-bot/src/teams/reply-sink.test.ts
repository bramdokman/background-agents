import { describe, expect, it } from "vitest";
import {
  createBlockReplySink,
  createStreamingEditReplySink,
  updateOrPost,
  WORKING_TEXT,
} from "./reply-sink";

/** What the Bot Framework client throws for a 4xx: the connector refused this edit for good. */
function refusal(status = 404) {
  return Object.assign(new Error(`Bot Framework updateActivity failed with ${status}`), {
    status,
    refused: true,
  });
}

function recordingPort(options: { failUpdate?: () => unknown } = {}) {
  const posts: string[] = [];
  const edits: Array<{ id: string; text: string }> = [];
  return {
    posts,
    edits,
    port: {
      async post(text: string) {
        posts.push(text);
        return { id: `activity-${posts.length}` };
      },
      async update(id: string, text: string) {
        if (options.failUpdate) throw options.failUpdate();
        edits.push({ id, text });
      },
    },
  };
}

describe("reply sink (ported from Centaur)", () => {
  it("keeps channel block replies at Working... until completion", async () => {
    const { port, posts, edits } = recordingPort();
    const sink = createBlockReplySink(port);
    await expect(sink.begin()).resolves.toEqual({ progressActivityId: "activity-1" });
    await sink.emit("PO", "PO");
    await sink.emit("NG", "PONG");
    await sink.complete("PONG", "PONG");
    expect(posts).toEqual([WORKING_TEXT]);
    expect(edits).toEqual([{ id: "activity-1", text: "PONG" }]);
  });

  it("reuses an existing progress activity instead of posting a second placeholder", async () => {
    const { port, posts, edits } = recordingPort();
    const sink = createBlockReplySink(port, "existing");
    await expect(sink.begin()).resolves.toEqual({ progressActivityId: "existing" });
    await sink.complete(WORKING_TEXT, WORKING_TEXT);
    await sink.complete("Done", "Done");
    expect(posts).toEqual([]);
    expect(edits).toEqual([{ id: "existing", text: "Done" }]);
  });

  it("streams personal-chat replies after a visible placeholder", async () => {
    const { port, posts, edits } = recordingPort();
    const sink = createStreamingEditReplySink(port);
    await sink.begin();
    await sink.emit("P", "P");
    await sink.emit("O", "PO");
    await sink.emit("", "PO");
    await sink.complete("", "PONG");
    expect(posts).toEqual([WORKING_TEXT]);
    expect(edits).toEqual([
      { id: "activity-1", text: "P" },
      { id: "activity-1", text: "PO" },
      { id: "activity-1", text: "PONG" },
    ]);
  });

  it("posts a fresh message when the channel refuses the edit, and reports failures the same way", async () => {
    const { port, posts, edits } = recordingPort({ failUpdate: () => refusal(404) });
    const sink = createBlockReplySink(port);
    await sink.begin();
    await expect(sink.fail("Something went wrong", "")).resolves.toEqual({
      progressActivityId: "activity-2",
    });
    expect(posts).toEqual([WORKING_TEXT, "Something went wrong"]);
    expect(edits).toEqual([]);
    await expect(updateOrPost(port, undefined, "no id yet")).resolves.toBe("activity-3");
  });

  it("does not post a second copy when the edit merely failed (timeout, 5xx)", async () => {
    const timedOut = recordingPort({
      failUpdate: () =>
        Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }),
    });
    await expect(updateOrPost(timedOut.port, "activity-1", "final")).rejects.toThrow(
      "The operation was aborted"
    );
    expect(timedOut.posts).toEqual([]);
    const serverError = recordingPort({
      failUpdate: () =>
        Object.assign(new Error("Bot Framework updateActivity failed with 502"), {
          status: 502,
          refused: false,
        }),
    });
    await expect(updateOrPost(serverError.port, "activity-1", "final")).rejects.toThrow(
      "failed with 502"
    );
    expect(serverError.posts).toEqual([]);
    const sink = createStreamingEditReplySink(serverError.port, "activity-1");
    await expect(sink.complete("final", "final")).rejects.toThrow("failed with 502");
    expect(serverError.posts).toEqual([]);
  });
});
