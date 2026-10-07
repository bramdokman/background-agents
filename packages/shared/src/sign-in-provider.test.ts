import { describe, expect, it } from "vitest";
import {
  getSignInProviderIssuer,
  isSignInProvider,
  parseEnabledSignInProviders,
} from "./sign-in-provider";

describe("isSignInProvider", () => {
  it.each(["github", "google", "microsoft"])("recognizes %s", (provider) => {
    expect(isSignInProvider(provider)).toBe(true);
  });

  it.each(["slack", "linear"])("rejects %s", (provider) => {
    expect(isSignInProvider(provider)).toBe(false);
  });
});

describe("getSignInProviderIssuer", () => {
  it.each([
    ["github", "https://github.com"],
    ["google", "https://accounts.google.com"],
    ["microsoft", "https://login.microsoftonline.com"],
    ["slack", null],
    ["linear", null],
  ])("maps %s to its canonical issuer", (provider, expectedIssuer) => {
    expect(getSignInProviderIssuer(provider)).toBe(expectedIssuer);
  });
});

describe("parseEnabledSignInProviders", () => {
  it("accepts the compiled providers in canonical order", () => {
    expect(parseEnabledSignInProviders({ providers: ["github", "google", "microsoft"] })).toEqual({
      providers: ["github", "google", "microsoft"],
    });
  });

  it.each(["github", "google", "microsoft"] as const)(
    "accepts the single enabled provider %s",
    (provider) => {
      expect(parseEnabledSignInProviders({ providers: [provider] })).toEqual({
        providers: [provider],
      });
    }
  );

  it.each([
    [{ providers: [] }, "empty"],
    [{ providers: ["github", "github"] }, "duplicate"],
    [{ providers: ["google", "github"] }, "out of order"],
    [{ providers: ["microsoft", "google"] }, "out of order"],
    [{ providers: ["github", "saml"] }, "unknown"],
    [{ providers: ["github"], label: "GitHub" }, "extra metadata"],
  ])("rejects a non-canonical provider response: %s (%s)", (value) => {
    expect(() => parseEnabledSignInProviders(value)).toThrow();
  });
});
