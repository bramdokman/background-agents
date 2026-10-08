import { describe, expect, it } from "vitest";
import {
  isAllowedServiceUrl,
  normalizeServiceUrl,
  parseAllowedServiceUrlHosts,
} from "./service-url";

const allowed = parseAllowedServiceUrlHosts("*.botframework.com,smba.trafficmanager.net");

describe("serviceUrl allowlist", () => {
  it("accepts the Teams connector hosts over https", () => {
    expect(isAllowedServiceUrl("https://smba.trafficmanager.net/emea/", allowed)).toBe(true);
    expect(isAllowedServiceUrl("https://SMBA.trafficmanager.net/amer", allowed)).toBe(true);
    expect(isAllowedServiceUrl("https://europe.botframework.com/", allowed)).toBe(true);
  });

  it("rejects forged, plain-http, credentialed and non-string serviceUrls", () => {
    expect(isAllowedServiceUrl("https://attacker.example/", allowed)).toBe(false);
    expect(isAllowedServiceUrl("https://smba.trafficmanager.net.attacker.example/", allowed)).toBe(
      false
    );
    expect(isAllowedServiceUrl("https://botframework.com/", allowed)).toBe(false);
    expect(isAllowedServiceUrl("http://smba.trafficmanager.net/emea/", allowed)).toBe(false);
    expect(isAllowedServiceUrl("https://user:pw@smba.trafficmanager.net/", allowed)).toBe(false);
    expect(isAllowedServiceUrl("smba.trafficmanager.net", allowed)).toBe(false);
    expect(isAllowedServiceUrl(undefined, allowed)).toBe(false);
    expect(isAllowedServiceUrl(42, allowed)).toBe(false);
  });

  it("normalizes to exactly one trailing slash", () => {
    expect(normalizeServiceUrl("https://smba.trafficmanager.net/emea")).toBe(
      "https://smba.trafficmanager.net/emea/"
    );
    expect(normalizeServiceUrl("https://smba.trafficmanager.net/emea//")).toBe(
      "https://smba.trafficmanager.net/emea/"
    );
  });
});
