import { describe, expect, it } from "vitest";
import { createLogger } from "../logger";
import { WORKING_TEXT } from "../teams/reply-sink";
import { createProgressRenderer, renderProgressText } from "./progress";

const silent = createLogger("test", {}, "error");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function recordingPort(options: { failUpdate?: () => boolean } = {}) {
  const posts: string[] = [];
  const edits: Array<{ id: string; text: string }> = [];
  let gate: ReturnType<typeof deferred> | undefined;
  return {
    posts,
    edits,
    /** Hold the next edit until `release()` is called. */
    hold() {
      gate = deferred();
    },
    release() {
      gate?.resolve();
      gate = undefined;
    },
    port: {
      async post(text: string) {
        posts.push(text);
        return { id: `post-${posts.length}` };
      },
      async update(id: string, text: string) {
        if (options.failUpdate?.()) {
          // The connector's 4xx: the activity cannot be edited, post instead.
          throw Object.assign(new Error("update refused"), { status: 404, refused: true });
        }
        edits.push({ id, text });
        if (gate) await gate.promise;
      },
    },
  };
}

describe("renderProgressText", () => {
  it("lists the latest lines under the placeholder", () => {
    expect(renderProgressText([])).toBe(WORKING_TEXT);
    expect(renderProgressText(["a", "b"])).toBe(`${WORKING_TEXT}\n\n- a\n- b`);
    const many = ["1", "2", "3", "4", "5", "6", "7", "8"];
    expect(renderProgressText(many)).toBe(`${WORKING_TEXT}\n\n- 3\n- 4\n- 5\n- 6\n- 7\n- 8`);
  });
});

describe("progress renderer", () => {
  it("merges lines that arrive while an edit is in flight into one further edit", async () => {
    const { port, edits, posts, hold, release } = recordingPort();
    const progress = createProgressRenderer(silent);
    const target = { port, progressActivityId: "working-1" };

    hold();
    progress.note("thread", target, "Ran: npm test");
    await waitFor(() => edits.length === 1, "first edit");
    progress.note("thread", target, "Edited src/a.ts");
    progress.note("thread", target, "Edited src/b.ts");
    progress.note("thread", target, "Ran: npm run lint");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(edits).toHaveLength(1);
    release();

    await expect(progress.finish("thread")).resolves.toBe("working-1");
    expect(posts).toEqual([]);
    expect(edits).toEqual([
      { id: "working-1", text: `${WORKING_TEXT}\n\n- Ran: npm test` },
      {
        id: "working-1",
        text: `${WORKING_TEXT}\n\n- Ran: npm test\n- Edited src/a.ts\n- Edited src/b.ts\n- Ran: npm run lint`,
      },
    ]);
  });

  it("resolves finish to the activity that holds the text after a fallback post", async () => {
    let refuse = true;
    const { port, edits, posts } = recordingPort({ failUpdate: () => refuse });
    const progress = createProgressRenderer(silent);
    progress.note("thread", { port, progressActivityId: "gone" }, "Read README.md");
    await waitFor(() => posts.length === 1, "fallback post");
    refuse = false;
    progress.note("thread", { port, progressActivityId: "gone" }, "Edited README.md");
    await expect(progress.finish("thread")).resolves.toBe("post-1");
    expect(posts).toEqual([`${WORKING_TEXT}\n\n- Read README.md`]);
    expect(edits).toEqual([
      { id: "post-1", text: `${WORKING_TEXT}\n\n- Read README.md\n- Edited README.md` },
    ]);
  });

  it("posts a placeholder first when the turn recorded none, and finishes idle threads as undefined", async () => {
    const { port, edits, posts } = recordingPort();
    const progress = createProgressRenderer(silent);
    await expect(progress.finish("nothing")).resolves.toBeUndefined();
    progress.note("thread", { port, progressActivityId: null }, "Ran: ls");
    await expect(progress.finish("thread")).resolves.toBe("post-1");
    expect(posts).toEqual([WORKING_TEXT]);
    expect(edits).toEqual([{ id: "post-1", text: `${WORKING_TEXT}\n\n- Ran: ls` }]);
  });

  it("starts over when a note targets a different placeholder (a new turn)", async () => {
    const { port, edits } = recordingPort();
    const progress = createProgressRenderer(silent);
    progress.note("thread", { port, progressActivityId: "turn-1" }, "Ran: a");
    await waitFor(() => edits.length === 1, "first turn edit");
    progress.note("thread", { port, progressActivityId: "turn-2" }, "Ran: b");
    await expect(progress.finish("thread")).resolves.toBe("turn-2");
    expect(edits).toEqual([
      { id: "turn-1", text: `${WORKING_TEXT}\n\n- Ran: a` },
      { id: "turn-2", text: `${WORKING_TEXT}\n\n- Ran: b` },
    ]);
  });

  it("leaves a stream that belongs to another placeholder alone when asked to finish a specific one", async () => {
    const { port, edits } = recordingPort();
    const progress = createProgressRenderer(silent);
    progress.note("thread", { port, progressActivityId: "turn-2" }, "Ran: b");
    await waitFor(() => edits.length === 1, "turn-2 edit");
    await expect(progress.finish("thread", "turn-1")).resolves.toBeUndefined();
    progress.note("thread", { port, progressActivityId: "turn-2" }, "Ran: c");
    await expect(progress.finish("thread", "turn-2")).resolves.toBe("turn-2");
    expect(edits).toEqual([
      { id: "turn-2", text: `${WORKING_TEXT}\n\n- Ran: b` },
      { id: "turn-2", text: `${WORKING_TEXT}\n\n- Ran: b\n- Ran: c` },
    ]);
    await expect(progress.finish("thread", "turn-2")).resolves.toBeUndefined();
  });

  it("clips long lines and keeps rendering when an edit is refused and its fallback fails", async () => {
    const posts: string[] = [];
    const port = {
      async post(text: string) {
        posts.push(text);
        throw new Error("connector down");
      },
      async update() {
        throw Object.assign(new Error("update refused"), { status: 404, refused: true });
      },
    };
    const progress = createProgressRenderer(silent);
    progress.note("thread", { port, progressActivityId: "w" }, `x${"y".repeat(200)}`);
    await expect(progress.finish("thread")).resolves.toBe("w");
    expect(posts).toHaveLength(1);
    expect(posts[0].length).toBeLessThan(140);
    expect(posts[0].endsWith("…")).toBe(true);
  });
});
