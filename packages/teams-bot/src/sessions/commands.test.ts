import { describe, expect, it } from "vitest";
import { parseCommand, parseRepositoryToken } from "./commands";
import { MISSING_PROMPT_MESSAGE } from "./messages";

describe("parseCommand", () => {
  it("recognises help, status and stop regardless of case", () => {
    expect(parseCommand("", { inThread: false })).toEqual({ kind: "help" });
    expect(parseCommand("  Help ", { inThread: false })).toEqual({ kind: "help" });
    expect(parseCommand("STATUS", { inThread: true })).toEqual({ kind: "status" });
    expect(parseCommand("stop", { inThread: true })).toEqual({ kind: "stop" });
    expect(parseCommand("cancel", { inThread: true })).toEqual({ kind: "stop" });
  });

  it("reads the repository from the first token in a channel", () => {
    expect(parseCommand("ProvidenceIT/playground add a README badge", { inThread: false })).toEqual(
      {
        kind: "prompt",
        repo: { owner: "ProvidenceIT", name: "playground", fullName: "ProvidenceIT/playground" },
        text: "add a README badge",
        options: {},
      }
    );
    expect(parseCommand("repo:ProvidenceIT/playground fix CI", { inThread: false })).toEqual({
      kind: "prompt",
      repo: { owner: "ProvidenceIT", name: "playground", fullName: "ProvidenceIT/playground" },
      text: "fix CI",
      options: {},
    });
  });

  it("treats text without a repository as a bare prompt", () => {
    expect(parseCommand("add a README badge", { inThread: false })).toEqual({
      kind: "prompt",
      repo: null,
      text: "add a README badge",
      options: {},
    });
  });

  it("requires a prompt after the repository", () => {
    expect(parseCommand("ProvidenceIT/playground", { inThread: false })).toEqual({
      kind: "error",
      message: MISSING_PROMPT_MESSAGE,
    });
  });

  it("never reads a repository from a follow-up inside a thread", () => {
    expect(parseCommand("ProvidenceIT/playground also update docs", { inThread: true })).toEqual({
      kind: "prompt",
      repo: null,
      text: "ProvidenceIT/playground also update docs",
      options: {},
    });
  });

  it("parses the shared inline flags ahead of the repository", () => {
    expect(
      parseCommand("!model gpt-5 !reasoning high ProvidenceIT/playground do it", {
        inThread: false,
      })
    ).toEqual({
      kind: "prompt",
      repo: { owner: "ProvidenceIT", name: "playground", fullName: "ProvidenceIT/playground" },
      text: "do it",
      options: { model: "gpt-5", reasoningEffort: "high" },
    });
    expect(parseCommand("!model", { inThread: false })).toEqual({
      kind: "error",
      message: "The !model flag requires a value.",
    });
    expect(parseCommand("!model gpt-5", { inThread: false })).toEqual({ kind: "help" });
    expect(parseCommand("!model gpt-5", { inThread: true })).toEqual({
      kind: "error",
      message: MISSING_PROMPT_MESSAGE,
    });
  });

  it("rejects tokens that only look like repositories", () => {
    expect(parseRepositoryToken("../etc")).toBeNull();
    expect(parseRepositoryToken("owner/name/extra")).toBeNull();
    expect(parseRepositoryToken("https://github.com/o/r")).toBeNull();
    expect(parseRepositoryToken("o/r")).toEqual({ owner: "o", name: "r", fullName: "o/r" });
  });
});
