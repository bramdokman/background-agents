import { describe, expect, it } from "vitest";
import { ASSERTION_RIGHTS, actorEnrollment, isActorNamespace } from "./principal";

describe("actor namespaces", () => {
  it("accepts exactly the namespaces a bot may assert", () => {
    for (const namespace of ["slack", "github", "linear", "microsoft"]) {
      expect(isActorNamespace(namespace)).toBe(true);
    }
    for (const namespace of ["", "google", "msteams", "Microsoft", "web"]) {
      expect(isActorNamespace(namespace)).toBe(false);
    }
  });

  it("enrolls first-party bot actors on first contact and only resolves microsoft actors", () => {
    expect(actorEnrollment("microsoft")).toBe("existing-only");
    for (const provider of ["slack", "github", "linear", "google"] as const) {
      expect(actorEnrollment(provider)).toBe("resolve-or-create");
    }
  });

  it("grants each bot its own namespace and the web none", () => {
    expect(ASSERTION_RIGHTS).toEqual({
      web: null,
      "slack-bot": "slack",
      "github-bot": "github",
      "linear-bot": "linear",
      "teams-bot": "microsoft",
    });
  });
});
