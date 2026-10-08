import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_ALLOWED_SERVICE_URL_HOSTS, loadConfig } from "./config";

const APP_ID = "0b4f1c2d-8e3a-4f5b-9c6d-7e8f9a0b1c2d";
const TENANT_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

const complete = {
  TEAMS_BOT_APP_ID: APP_ID,
  TEAMS_BOT_APP_SECRET: "placeholder-app-secret",
  TEAMS_BOT_TENANT_ID: TENANT_ID,
  CONTROL_PLANE_URL: "http://open-inspect-control-plane:8787/",
  SERVICE_AUTH_SECRET_TEAMS_BOT: "placeholder-service-secret",
  WEB_APP_URL: "https://web.example.test/",
};

describe("loadConfig", () => {
  it("reads the fixed names and applies the defaults", () => {
    const config = loadConfig(complete);
    expect(config).toEqual({
      appId: APP_ID,
      appSecret: "placeholder-app-secret",
      tenantId: TENANT_ID,
      host: "0.0.0.0",
      port: 3100,
      controlPlaneUrl: "http://open-inspect-control-plane:8787",
      serviceAuthSecret: "placeholder-service-secret",
      webAppUrl: "https://web.example.test",
      stateDir: "/state",
      allowedServiceUrlHosts: ["*.botframework.com", "smba.trafficmanager.net"],
      logLevel: "info",
    });
    expect(DEFAULT_ALLOWED_SERVICE_URL_HOSTS).toBe("*.botframework.com,smba.trafficmanager.net");
  });

  it("names missing variables without echoing any value", () => {
    const { TEAMS_BOT_APP_SECRET: _secret, ...withoutSecret } = complete;
    expect(() => loadConfig({ ...withoutSecret, SERVICE_AUTH_SECRET_TEAMS_BOT: "   " })).toThrow(
      new ConfigError([
        "TEAMS_BOT_APP_SECRET is required",
        "SERVICE_AUTH_SECRET_TEAMS_BOT is required",
      ])
    );
  });

  it("rejects a relative control-plane URL and a non-GUID app id", () => {
    expect(() =>
      loadConfig({ ...complete, CONTROL_PLANE_URL: "control-plane:8787", TEAMS_BOT_APP_ID: "bot" })
    ).toThrow(
      new ConfigError([
        "TEAMS_BOT_APP_ID must be a GUID",
        "CONTROL_PLANE_URL must be an absolute http(s) URL",
      ])
    );
  });

  it("parses the port and the serviceUrl allowlist", () => {
    const config = loadConfig({
      ...complete,
      TEAMS_BOT_PORT: "4000",
      TEAMS_BOT_ALLOWED_SERVICE_URL_HOSTS: " Smba.Trafficmanager.Net , *.example.test ",
      LOG_LEVEL: "debug",
    });
    expect(config.port).toBe(4000);
    expect(config.allowedServiceUrlHosts).toEqual(["smba.trafficmanager.net", "*.example.test"]);
    expect(config.logLevel).toBe("debug");
  });
});
