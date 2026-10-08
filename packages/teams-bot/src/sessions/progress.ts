/**
 * Progress in the thread: tool-call callbacks become lines under the
 * "Working..." reply, edited in place. One stream per thread feeds the ported
 * conflater, so a burst of callbacks that arrives while an edit is in flight
 * becomes one further edit, not one per callback; the streaming reply sink
 * does the edits and falls back to a fresh post when the connector refuses
 * one. The completion drains the stream before it writes the final text, so
 * no progress edit can land after the answer.
 *
 * In memory on purpose: after a restart the lines of the turn so far are
 * gone, and the next callback starts again from "Working..." on the activity
 * the SQLite record names.
 */

import { asError, type Logger } from "../logger";
import { conflateTeamsRenderStream, type TeamsRenderChunk } from "../teams/conflate";
import {
  createStreamingEditReplySink,
  WORKING_TEXT,
  type ReplySinkPort,
} from "../teams/reply-sink";

/** Lines shown under "Working..."; older ones scroll off. */
const MAX_PROGRESS_LINES = 6;
const MAX_LINE_LENGTH = 120;

interface ProgressTarget {
  port: ReplySinkPort;
  /** The "Working..." reply to edit; `null` when its id was not recorded, in which case one is posted. */
  progressActivityId: string | null;
}

export interface ProgressRenderer {
  /** Add a line to the thread's progress; the edit happens in the background. */
  note(threadKey: string, target: ProgressTarget, line: string): void;
  /**
   * End the thread's progress stream and wait for its last edit. Resolves to
   * the activity that holds the progress text (it moves when an edit had to
   * fall back to a post), or `undefined` when no progress was rendered.
   */
  finish(threadKey: string): Promise<string | undefined>;
}

interface ChunkSource {
  iterable: AsyncIterable<TeamsRenderChunk>;
  push(chunk: TeamsRenderChunk): void;
}

/** A push-fed async iterable; `done`/`error` chunks end it after they are consumed. */
function createChunkSource(): ChunkSource {
  const queue: TeamsRenderChunk[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const iterable: AsyncIterable<TeamsRenderChunk> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<TeamsRenderChunk>> {
          while (queue.length === 0) {
            if (ended) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const chunk = queue.shift()!;
          if (chunk.type !== "text_delta") ended = true;
          return { done: false, value: chunk };
        },
        async return(): Promise<IteratorResult<TeamsRenderChunk>> {
          ended = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return {
    iterable,
    push(chunk) {
      queue.push(chunk);
      const resume = wake;
      wake = undefined;
      resume?.();
    },
  };
}

export function renderProgressText(lines: readonly string[]): string {
  const shown = lines.slice(-MAX_PROGRESS_LINES).map((line) => `- ${line}`);
  return shown.length === 0 ? WORKING_TEXT : `${WORKING_TEXT}\n\n${shown.join("\n")}`;
}

function clipLine(line: string): string {
  const single = line.replace(/\s+/g, " ").trim();
  return single.length > MAX_LINE_LENGTH ? `${single.slice(0, MAX_LINE_LENGTH - 1)}…` : single;
}

interface ThreadProgress {
  /** The activity the stream was started for; a different one means a new turn. */
  forActivityId: string | null;
  source: ChunkSource;
  lines: string[];
  settled: Promise<string | undefined>;
}

export function createProgressRenderer(log: Logger): ProgressRenderer {
  const threads = new Map<string, ThreadProgress>();

  async function run(threadKey: string, state: ThreadProgress, target: ProgressTarget) {
    const sink = createStreamingEditReplySink(target.port, target.progressActivityId ?? undefined);
    let activityId = target.progressActivityId ?? undefined;
    try {
      activityId = (await sink.begin()).progressActivityId ?? activityId;
    } catch (error) {
      log.warn("progress.begin_failed", { thread_key: threadKey, error: asError(error) });
    }
    for await (const chunk of conflateTeamsRenderStream(state.source.iterable)) {
      if (chunk.type !== "text_delta") break;
      state.lines.push(...chunk.text.split("\n").filter((line) => line !== ""));
      try {
        const result = await sink.emit(chunk.text, renderProgressText(state.lines));
        if (result?.progressActivityId) activityId = result.progressActivityId;
      } catch (error) {
        log.warn("progress.edit_failed", { thread_key: threadKey, error: asError(error) });
      }
    }
    return activityId;
  }

  function start(threadKey: string, target: ProgressTarget): ThreadProgress {
    const state: ThreadProgress = {
      forActivityId: target.progressActivityId,
      source: createChunkSource(),
      lines: [],
      settled: Promise.resolve(undefined),
    };
    state.settled = run(threadKey, state, target);
    threads.set(threadKey, state);
    return state;
  }

  return {
    note(threadKey, target, line) {
      let state = threads.get(threadKey);
      if (state && state.forActivityId !== target.progressActivityId) {
        state.source.push({ type: "done" });
        state = undefined;
      }
      state ??= start(threadKey, target);
      state.source.push({ type: "text_delta", text: `\n${clipLine(line)}` });
    },
    async finish(threadKey) {
      const state = threads.get(threadKey);
      if (!state) return undefined;
      threads.delete(threadKey);
      state.source.push({ type: "done" });
      return state.settled;
    },
  };
}
