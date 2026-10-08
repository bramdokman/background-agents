// SPDX-License-Identifier: MIT
// Ported from Centaur (https://github.com/paradigmxyz/centaur, services/teamsbot);
// copyright and licence in ../../LICENSE-centaur, adaptations listed in ../../PORTED.md.
import { describe, expect, it } from "vitest";
import { conflateTeamsRenderStream, type TeamsRenderChunk } from "./conflate";

type ManualSource = {
  iterable: AsyncIterable<TeamsRenderChunk>;
  push(chunk: TeamsRenderChunk): void;
  end(): void;
  readonly returnCalled: boolean;
};

describe("conflateTeamsRenderStream (ported from Centaur)", () => {
  it("concatenates text while the consumer is busy", async () => {
    const source = manualSource();
    const stream = conflateTeamsRenderStream(source.iterable)[Symbol.asyncIterator]();

    source.push({ type: "text_delta", text: "Hello " });
    expect((await stream.next()).value).toEqual({ type: "text_delta", text: "Hello " });

    source.push({ type: "text_delta", text: "from " });
    source.push({ type: "text_delta", text: "Teams" });
    await settle();

    expect((await stream.next()).value).toEqual({ type: "text_delta", text: "from Teams" });
    source.end();
    expect((await stream.next()).done).toBe(true);
  });

  it("yields pending text before terminal chunks", async () => {
    const source = manualSource();
    const stream = conflateTeamsRenderStream(source.iterable)[Symbol.asyncIterator]();

    source.push({ type: "text_delta", text: "final text" });
    source.push({ type: "done" });
    await settle();

    expect((await stream.next()).value).toEqual({ type: "text_delta", text: "final text" });
    expect((await stream.next()).value).toEqual({ type: "done" });
    source.end();
    expect((await stream.next()).done).toBe(true);
  });

  it("cancels the source when abandoned", async () => {
    const source = manualSource();
    const stream = conflateTeamsRenderStream(source.iterable)[Symbol.asyncIterator]();

    source.push({ type: "text_delta", text: "start" });
    await stream.next();
    await stream.return?.(undefined);
    await settle();

    expect(source.returnCalled).toBe(true);
  });

  it("rethrows a source failure after the pending text", async () => {
    const failing: AsyncIterable<TeamsRenderChunk> = {
      [Symbol.asyncIterator]() {
        let step = 0;
        return {
          async next() {
            step += 1;
            if (step === 1) return { done: false, value: { type: "text_delta", text: "partial" } };
            throw new Error("source broke");
          },
        };
      },
    };
    const stream = conflateTeamsRenderStream(failing)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toEqual({ type: "text_delta", text: "partial" });
    await expect(stream.next()).rejects.toThrow("source broke");
  });
});

function manualSource(): ManualSource {
  const queue: TeamsRenderChunk[] = [];
  let closed = false;
  let notify: (() => void) | undefined;
  let returnCalled = false;

  const iterator: AsyncIterator<TeamsRenderChunk> = {
    async next() {
      while (true) {
        const chunk = queue.shift();
        if (chunk) {
          return { done: false, value: chunk };
        }
        if (closed) {
          return { done: true, value: undefined };
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
      }
    },
    async return() {
      returnCalled = true;
      closed = true;
      notify?.();
      return { done: true, value: undefined };
    },
  };

  return {
    iterable: { [Symbol.asyncIterator]: () => iterator },
    push(chunk) {
      queue.push(chunk);
      notify?.();
    },
    end() {
      closed = true;
      notify?.();
    },
    get returnCalled() {
      return returnCalled;
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
