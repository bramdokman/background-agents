import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { NO_AUTHORIZATION } from "../routes/shared";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { PersistedAlarmDeadlineStore } from "../session/alarm/scheduler";
import { CACHE_STORE_FILE } from "./cache-database";
import { DEFAULT_MIGRATIONS_DIR, GLOBAL_STORE_FILE, type NodeHostSettings } from "./config";
import { HOST_STATE_FILE } from "./crash-recovery";
import { openHostAlarmIndex } from "./host-alarm-index";
import { startNodeHost, type NodeHost, type NodeHostOptions } from "./host";
import { JOB_STORE_FILE } from "./job-store";
import type { HealthReport } from "./http-server";
import { openSessionStore } from "./session-store";

const KEY = Buffer.alloc(32, 7).toString("base64");

const CONFIG = {
  DEPLOYMENT_NAME: "test",
  GITHUB_BOT_USERNAME: "open-inspect[bot]",
  TOKEN_ENCRYPTION_KEY: KEY,
  PROVIDER_ACCOUNTS_ENCRYPTION_KEY: KEY,
  REPO_SECRETS_ENCRYPTION_KEY: KEY,
  LOG_LEVEL: "error",
};

const OBJECT_STORAGE = { bucket: "media", region: "us-east-1" };

/** A public route that writes to the cache, so the cache file has a WAL to close. */
function cacheWritingRoute(): Hono<ControlPlaneHonoEnv>[] {
  const routes = new Hono<ControlPlaneHonoEnv>();
  routes.get(
    "/cache-write",
    admit({
      authentication: { kind: "public" },
      supportedScmProviders: "all",
      authorization: NO_AUTHORIZATION,
    }),
    async (c) => {
      await c.env.REPOS_CACHE.put("host-test", "written");
      return Response.json({ written: true });
    }
  );
  return [routes];
}

/** A public route that reports which bot ports exist and posts one callback through TEAMS_BOT. */
function botProbeRoute(): Hono<ControlPlaneHonoEnv>[] {
  const routes = new Hono<ControlPlaneHonoEnv>();
  routes.get(
    "/bot-probe",
    admit({
      authentication: { kind: "public" },
      supportedScmProviders: "all",
      authorization: NO_AUTHORIZATION,
    }),
    async (c) => {
      const delivered = await c.env.TEAMS_BOT?.fetch(
        "https://internal/callbacks/complete?attempt=1",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
      );
      return Response.json({
        ports: {
          SLACK_BOT: c.env.SLACK_BOT !== undefined,
          LINEAR_BOT: c.env.LINEAR_BOT !== undefined,
          TEAMS_BOT: c.env.TEAMS_BOT !== undefined,
        },
        status: delivered?.status ?? null,
      });
    }
  );
  return [routes];
}

/** A public route that answers once `release` is called, for shutdown against work in flight. */
function blockingRoute(): {
  routes: Hono<ControlPlaneHonoEnv>[];
  entered: Promise<void>;
  release: () => void;
} {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const routes = new Hono<ControlPlaneHonoEnv>();
  routes.get(
    "/block",
    admit({
      authentication: { kind: "public" },
      supportedScmProviders: "all",
      authorization: NO_AUTHORIZATION,
    }),
    async () => {
      markEntered();
      await held;
      return Response.json({ released: true });
    }
  );
  return { routes: [routes], entered, release };
}

describe("startNodeHost", () => {
  let dataDir: string;
  let host: NodeHost | null = null;

  const settings = (overrides: Partial<NodeHostSettings> = {}): NodeHostSettings => ({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    shutdownTimeoutMs: 5_000,
    auditExportStdout: false,
    auditExportFile: undefined,
    ...overrides,
  });

  const start = (overrides: Partial<NodeHostOptions> = {}): Promise<NodeHost> => {
    dataDir ??= mkdtempSync(join(tmpdir(), "node-host-"));
    return startNodeHost({
      config: CONFIG,
      settings: settings(),
      objectStorage: OBJECT_STORAGE,
      ...overrides,
    });
  };

  const marker = (): { indexedThroughMs: number; cleanShutdown: boolean } =>
    JSON.parse(readFileSync(join(dataDir, HOST_STATE_FILE), "utf8")) as {
      indexedThroughMs: number;
      cleanShutdown: boolean;
    };

  afterEach(async () => {
    await host?.shutdown();
    host = null;
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined as unknown as string;
  });

  it("reaches a bot by its configured URL and supplies no port for an unconfigured one", async () => {
    const received: string[] = [];
    const bot = createServer((request, response) => {
      received.push(`${request.method} ${request.url}`);
      response.end("ok");
    });
    bot.listen(0, "127.0.0.1");
    await once(bot, "listening");
    const botPort = (bot.address() as AddressInfo).port;
    try {
      host = await start({
        routes: botProbeRoute(),
        botClients: { TEAMS_BOT: new URL(`http://127.0.0.1:${botPort}/teams`) },
      });
      const probe = await fetch(`http://127.0.0.1:${host.address.port}/bot-probe`);
      expect(await probe.json()).toEqual({
        ports: { SLACK_BOT: false, LINEAR_BOT: false, TEAMS_BOT: true },
        status: 200,
      });
      expect(received).toEqual(["POST /teams/callbacks/complete?attempt=1"]);
    } finally {
      bot.close();
    }
  });

  it("boots over the migrated global store and answers the health check and the route table", async () => {
    host = await start();
    const base = `http://127.0.0.1:${host.address.port}`;
    expect(existsSync(join(dataDir, GLOBAL_STORE_FILE))).toBe(true);

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    const report = (await health.json()) as HealthReport;
    expect(report).toMatchObject({
      status: "ok",
      sessions_resident: 0,
      alarm_clock: "running",
      cron: "running",
      jobs: { poller: "running", pending: 0, running: 0, dead: 0, oldestRunnableLagMs: null },
    });
    expect(report.migrations_applied).toBeGreaterThan(0);
    expect(existsSync(join(dataDir, JOB_STORE_FILE))).toBe(true);

    const missing = await fetch(`${base}/no-such-route`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });
    expect(missing.headers.get("x-request-id")).toBeTruthy();

    // A catalog route answers through admission: unauthenticated, not unknown.
    const listed = await fetch(`${base}/sessions`);
    expect(listed.status).toBe(401);
  });

  it("refuses a WebSocket upgrade for an unknown session and any other upgrade path", async () => {
    host = await start();
    const base = `ws://127.0.0.1:${host.address.port}`;
    const rejection = (path: string): Promise<string> =>
      new Promise((resolve) => {
        new NodeWebSocket(`${base}${path}`).once("error", (error) => resolve(error.message));
      });
    expect(await rejection("/sessions/unknown/ws")).toBe("Unexpected server response: 404");
    expect(await rejection("/sessions/unknown/events")).toBe("Unexpected server response: 400");
  });

  it("closes the cache database on a normal shutdown, not only on a failed boot", async () => {
    host = await start({ routes: cacheWritingRoute() });
    await fetch(`http://127.0.0.1:${host.address.port}/cache-write`);
    // An open connection holds its write-ahead log; a closed one checkpoints
    // and removes it, so the sidecar file is the observable for the close.
    expect(existsSync(join(dataDir, `${CACHE_STORE_FILE}-wal`))).toBe(true);

    await host.shutdown();
    host = null;

    expect(existsSync(join(dataDir, `${CACHE_STORE_FILE}-wal`))).toBe(false);
  });

  it("exports an audit row committed through the platform store to the export file", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    const exportFile = join(dataDir, "audit-export.jsonl");
    const written: string[] = [];
    const routes = new Hono<ControlPlaneHonoEnv>();
    routes.post(
      "/audit-write",
      admit({
        authentication: { kind: "public" },
        supportedScmProviders: "all",
        authorization: NO_AUTHORIZATION,
      }),
      async (c) => {
        const id = crypto.randomUUID();
        written.push(id);
        await c.env.DB.prepare(
          `INSERT INTO authorization_audit_events
             (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot, action,
              resource_type, resource_id, reason_code, operation_result, metadata_json)
           VALUES (?, ?, ?, 'user', ?, 'team.created', 'team', ?, 'team.created', 'applied',
                   '{"before":{},"requested":{},"after":{}}')`
        )
          .bind(id, Date.now(), "req-host-test", "user-1", "team-1")
          .run();
        return Response.json({ id });
      }
    );
    host = await start({ routes: [routes], settings: settings({ auditExportFile: exportFile }) });
    const base = `http://127.0.0.1:${host.address.port}`;

    expect(existsSync(exportFile)).toBe(true);
    await fetch(`${base}/audit-write`, { method: "POST" });
    await fetch(`${base}/audit-write`, { method: "POST" });

    const lines = readFileSync(exportFile, "utf8").split("\n");
    expect(lines.pop()).toBe("");
    expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(written);
  });

  it("reports draining once a shutdown begins and stops listening when it ends", async () => {
    host = await start();
    const base = `http://127.0.0.1:${host.address.port}`;

    const stopping = host.shutdown();
    expect(host.health().status).toBe("draining");
    expect(await stopping).toEqual({ clean: true, abandoned: [] });
    await expect(host.shutdown()).resolves.toEqual({ clean: true, abandoned: [] });
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    host = null;
  });

  it("waits for a request in flight before closing the stores, and answers it", async () => {
    const { routes, entered, release } = blockingRoute();
    host = await start({ routes });
    const base = `http://127.0.0.1:${host.address.port}`;

    const blocked = fetch(`${base}/block`);
    await entered;
    const stopping = host.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Not closed underneath the handler: the shutdown is still waiting.
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    expect(await stopping).toEqual({ clean: true, abandoned: [] });
    const response = await blocked;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ released: true });
    host = null;
  });

  it("gives up a request that outlives the budget and reports it", async () => {
    const { routes } = blockingRoute();
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    host = await startNodeHost({
      config: CONFIG,
      settings: settings({ shutdownTimeoutMs: 200 }),
      objectStorage: OBJECT_STORAGE,
      routes,
    });
    const base = `http://127.0.0.1:${host.address.port}`;

    const blocked = fetch(`${base}/block`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const startedAt = Date.now();
    const report = await host.shutdown();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(report).toEqual({ clean: false, abandoned: ["http_requests:1"] });
    // No clean marker: the handler that outlived the budget could still have
    // armed a deadline, so the next boot goes looking for it.
    expect(marker()).toMatchObject({ cleanShutdown: false });
    // The connection was cut at the end; the peer sees no answer.
    await expect(blocked).rejects.toThrow();
    host = null;
  });

  it("marks a stop that abandoned nothing as clean", async () => {
    host = await start();
    // Running, the marker says nothing about a clean stop.
    expect(marker()).toMatchObject({ cleanShutdown: false });

    await host.shutdown();
    host = null;

    expect(marker()).toEqual({ indexedThroughMs: expect.any(Number), cleanShutdown: true });
  });

  it("arms a deadline a previous process left only in the session file", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    // The session committed its deadline and the process died before the row
    // reached the index. Far enough out that the clock only arms a timer.
    const deadline = Date.now() + 60 * 60 * 1000;
    const session = openSessionStore({ dataDir, sessionId: "stranded" });
    new PersistedAlarmDeadlineStore(session.storage.sql).setPending(deadline);
    session.close();

    host = await start();
    await host.shutdown();
    host = null;

    const index = openHostAlarmIndex(dataDir);
    try {
      expect(index.get("stranded")).toBe(deadline);
    } finally {
      index.close();
    }
  });

  it("fails to boot on a malformed encryption key with the Worker's message, leaving nothing open", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    await expect(
      start({ config: { ...CONFIG, TOKEN_ENCRYPTION_KEY: "c2hvcnQ=" } })
    ).rejects.toThrow("TOKEN_ENCRYPTION_KEY must decode to 32 bytes for AES-256, got 5");
    expect(existsSync(join(dataDir, GLOBAL_STORE_FILE))).toBe(false);
    // A corrected boot over the same directory succeeds.
    host = await start();
    expect((await fetch(`http://127.0.0.1:${host.address.port}/healthz`)).status).toBe(200);
  });

  it("releases what it acquired when a later boot step fails", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    // Take the port first so listen fails after the stores were opened.
    const occupant = await start();
    await expect(
      startNodeHost({
        config: CONFIG,
        settings: settings({ port: occupant.address.port }),
        objectStorage: OBJECT_STORAGE,
      })
    ).rejects.toThrow(/EADDRINUSE/);
    await occupant.shutdown();
    // Both stores were closed by the rollback: a fresh boot opens them again.
    host = await start();
    expect((await fetch(`http://127.0.0.1:${host.address.port}/healthz`)).status).toBe(200);
  });
});
