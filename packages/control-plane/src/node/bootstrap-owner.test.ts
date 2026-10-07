import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./bootstrap-owner";
import { GLOBAL_STORE_FILE } from "./config";
import { openNodeSqlDatabase } from "./sqlite-database";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);

const USER_ID = "11111111111111111111111111111111";
const OTHER_USER_ID = "22222222222222222222222222222222";

describe("parseArgs", () => {
  it("takes the data directory from --data-dir, else from DATA_DIR as the host does", () => {
    expect(parseArgs(["--user", USER_ID], { DATA_DIR: "/data" })).toEqual({
      dataDir: "/data",
      userId: USER_ID,
      execute: false,
    });
    expect(
      parseArgs(["--user", USER_ID, "--data-dir", "/srv/x/", "--execute"], { DATA_DIR: "/data" })
    ).toEqual({ dataDir: "/srv/x", userId: USER_ID, execute: true });
    expect(() => parseArgs(["--user", USER_ID], {})).toThrow("DATA_DIR is required");
  });

  it("rejects unknown, duplicate, missing and non-canonical arguments", () => {
    const env = { DATA_DIR: "/data" };
    expect(() => parseArgs(["--user", USER_ID, "--force"], env)).toThrow("Unknown option");
    expect(() => parseArgs(["--user", USER_ID, "--user", USER_ID], env)).toThrow("Duplicate");
    expect(() => parseArgs(["--data-dir", "--user", USER_ID], env)).toThrow("Missing value");
    expect(() => parseArgs(["--data-dir", "/data"], env)).toThrow("--user is required");
    expect(() => parseArgs(["--user", "owner@example.com"], env)).toThrow("canonical");
    expect(() => parseArgs([USER_ID], env)).toThrow("Unexpected argument");
  });
});

describe("run", () => {
  let dataDir: string;
  let path: string;
  let stderr: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "bootstrap-owner-"));
    path = join(dataDir, GLOBAL_STORE_FILE);
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void stderr.push(line));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The store as a booted host leaves it: created, private, and migrated. */
  const bootHost = (): void => openNodeSqlDatabase(path, { migrationsDir: MIGRATIONS_DIR }).close();

  /** What one sign-in leaves behind: a users row, which the schema's trigger makes a Member. */
  const signIn = (userId: string): void => {
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)").run(userId);
    db.close();
  };

  const query = <T>(sql: string): T[] => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };
  const assignments = () =>
    query<{ user_id: string; role_id: string }>(
      "SELECT user_id, role_id FROM user_role_assignments ORDER BY user_id"
    );
  /** The bootstrap's own audit rows; a sign-in's default-role trigger writes its own. */
  const audits = () =>
    query<Record<string, unknown>>(
      `SELECT id, request_id, principal_kind, actor_service_snapshot, action,
              target_user_id_snapshot, reason_code, operation_result, metadata_json
       FROM authorization_audit_events WHERE action = 'workspace.owner_bootstrapped'`
    );

  const bootstrap = (execute: boolean, auditId = "audit-1") =>
    run({ dataDir, userId: USER_ID, execute }, { randomUUID: () => auditId, now: () => 100 });

  it("makes the signed-in user the one Owner and writes exactly one audit event", async () => {
    bootHost();
    signIn(USER_ID);
    signIn(OTHER_USER_ID);

    await bootstrap(true);

    expect(assignments()).toEqual([
      { user_id: USER_ID, role_id: "role_builtin_owner" },
      { user_id: OTHER_USER_ID, role_id: "role_builtin_member" },
    ]);
    expect(audits()).toEqual([
      {
        id: "audit-1",
        request_id: "operator-cli:audit-1",
        principal_kind: "service",
        actor_service_snapshot: "operator-cli",
        action: "workspace.owner_bootstrapped",
        target_user_id_snapshot: USER_ID,
        reason_code: "operator_cli",
        operation_result: "applied",
        metadata_json: JSON.stringify({
          before: { roleId: "role_builtin_member" },
          requested: { roleId: "role_builtin_owner" },
          after: { roleId: "role_builtin_owner" },
        }),
      },
    ]);
    expect(stderr.at(-1)).toBe(
      "Owner bootstrap command completed; rerun the dry run and expect no-op."
    );
  });

  it("is a no-op the second time, with or without --execute", async () => {
    bootHost();
    signIn(USER_ID);
    await bootstrap(true);
    const before = { assignments: assignments(), audits: audits() };

    await bootstrap(true, "audit-2");
    await bootstrap(false, "audit-3");

    expect({ assignments: assignments(), audits: audits() }).toEqual(before);
    expect(before.audits).toHaveLength(1);
    expect(stderr.filter((line) => line.startsWith("Nothing to do"))).toEqual([
      "Nothing to do: selected user is already the current unsuspended Owner.",
      "Nothing to do: selected user is already the current unsuspended Owner.",
    ]);
  });

  it("changes nothing on a dry run", async () => {
    bootHost();
    signIn(USER_ID);

    await bootstrap(false);

    expect(assignments()).toEqual([{ user_id: USER_ID, role_id: "role_builtin_member" }]);
    expect(audits()).toEqual([]);
    expect(stderr.at(-1)).toBe(
      "Dry run only. Re-run with --execute after reviewing the preflight result."
    );
  });

  it("refuses to bootstrap beside another unsuspended Owner", async () => {
    bootHost();
    signIn(USER_ID);
    signIn(OTHER_USER_ID);
    await run(
      { dataDir, userId: OTHER_USER_ID, execute: true },
      { randomUUID: () => "audit-other", now: () => 100 }
    );

    await expect(bootstrap(true)).rejects.toThrow(
      "Owner bootstrap preflight was refused: another unsuspended Owner already exists"
    );

    expect(assignments()).toEqual([
      { user_id: USER_ID, role_id: "role_builtin_member" },
      { user_id: OTHER_USER_ID, role_id: "role_builtin_owner" },
    ]);
    expect(audits()).toHaveLength(1);
  });

  it("refuses a user who has not signed in", async () => {
    bootHost();

    await expect(bootstrap(true)).rejects.toThrow(
      "Owner bootstrap preflight was refused: target user does not exist exactly once"
    );
    expect(audits()).toEqual([]);
  });

  it("fails without creating a store when none exists at the data directory", async () => {
    await expect(bootstrap(true)).rejects.toThrow(
      `No global store at ${path}; the host creates it on first boot, so check DATA_DIR or --data-dir`
    );
    expect(existsSync(path)).toBe(false);
  });

  it("fails readably when the file is not a SQLite database", async () => {
    writeFileSync(path, "not a database\n");

    await expect(bootstrap(true)).rejects.toThrow(/not a database/);
  });

  it("fails rather than migrates a store the host has not migrated", async () => {
    new DatabaseSync(path).close();

    await expect(bootstrap(true)).rejects.toThrow("no such table: users");
    expect(query<{ name: string }>("SELECT name FROM sqlite_master")).toEqual([]);
  });
});
