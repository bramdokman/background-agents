import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_ALLOWED_SERVICE_URL_HOSTS, loadConfig } from "./config";

const APP_ID = "cd86c3d8-53e2-4271-92b8-674063f8bb08";
const TENANT_ID = "b13a5250-6976-43e7-828e-523316139f08";

const complete = {
  TEAMS_BOT_APP_ID: APP_ID,
  TEAMS_BOT_APP_SECRET: "placeholder-app-secret",
  TEAMS_BOT_TENANT_ID: TENANT_ID,
  CONTROL_PLANE_URL: "http://10.43.250.21:8787/",
  SERVICE_AUTH_SECRET_TEAMS_BOT: "placeholder-service-secret",
  WEB_APP_URL: "https://agent-dokman.tailbd0db8.ts.net:10443/",
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
      controlPlaneUrl: "http://10.43.250.21:8787",
      serviceAuthSecret: "placeholder-service-secret",
      webAppUrl: "https://agent-dokman.tailbd0db8.ts.net:10443",
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
