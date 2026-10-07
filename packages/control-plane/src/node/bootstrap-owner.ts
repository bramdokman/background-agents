/**
 * Bootstrap the first workspace Owner on the Node host, by canonical user ID.
 *
 * The container counterpart of `scripts/bootstrap-workspace-owner.ts`, which
 * reaches D1 through Wrangler: the same SQL (owner-bootstrap-sql.ts), the
 * same preflight-then-execute shape and the same refusals, run against the
 * global store under `DATA_DIR`, the file the host itself opens. It is built
 * next to the host as `dist/node/bootstrap-owner.js`, so the control-plane
 * image can run it as a one-shot command against the host's data volume.
 *
 * Dry-run (the default), from the repository root after `npm run build:node`:
 *   npm run bootstrap-owner -w @open-inspect/control-plane -- --user <canonical-user-id>
 *
 * Execute after reviewing the preflight result:
 *   npm run bootstrap-owner -w @open-inspect/control-plane -- --user <canonical-user-id> --execute
 *
 * `--data-dir <dir>` names the host's data directory in place of `DATA_DIR`.
 *
 * The store is opened as the host opens it but is never created or migrated
 * here: the host does both at boot, and the target user must have signed in
 * through that host once to exist at all. A file the host has not migrated
 * yet fails the preflight rather than being changed underneath a running
 * host. A missing file is an error rather than a new, empty store at the
 * wrong path.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SqlDatabase } from "../db/sql-database";
import { type ConfigSource, GLOBAL_STORE_FILE, readNodeHostSettings } from "./config";
import {
  type BootstrapReport,
  type BootstrapSql,
  buildBootstrapSql,
  CANONICAL_USER_ID,
} from "./owner-bootstrap-sql";
import { openNodeSqlDatabase } from "./sqlite-database";

const VALUE_OPTIONS = new Set(["user", "data-dir"]);
const FLAG_OPTIONS = new Set(["execute"]);

/** Validated command-line options for the Node host's Owner bootstrap. */
export interface NodeBootstrapCliOptions {
  /** The host's data directory; the global store is `GLOBAL_STORE_FILE` inside it. */
  dataDir: string;
  userId: string;
  execute: boolean;
}

/**
 * Parse and validate the command line. `--data-dir` wins over `DATA_DIR`
 * in `env`, which is read the way the host reads it.
 */
export function parseArgs(argv: string[], env: ConfigSource): NodeBootstrapCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (FLAG_OPTIONS.has(name)) {
      if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    values.set(name, value);
  }

  const userId = values.get("user");
  if (!userId) throw new Error("--user is required");
  if (!CANONICAL_USER_ID.test(userId)) {
    throw new Error("--user must be a canonical 32-character lowercase hexadecimal user ID");
  }
  const dataDir = values.get("data-dir")?.trim();

  return {
    dataDir: dataDir ? resolve(dataDir) : readNodeHostSettings(env).dataDir,
    userId,
    execute: flags.has("execute"),
  };
}

/** Injectable side effects for deterministic bootstrap tests. */
export interface BootstrapRunDependencies {
  randomUUID?: () => string;
  now?: () => number;
}

/** Run the Owner bootstrap against the global store under `options.dataDir`. */
export async function run(
  options: NodeBootstrapCliOptions,
  dependencies: BootstrapRunDependencies = {}
): Promise<void> {
  const path = join(options.dataDir, GLOBAL_STORE_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `No global store at ${path}; the host creates it on first boot, so check DATA_DIR or --data-dir`
    );
  }
  console.error(`${options.execute ? "Executing" : "Dry-running"} Owner bootstrap on ${path}...`);
  const sql = buildBootstrapSql({
    userId: options.userId,
    auditId: dependencies.randomUUID?.() ?? crypto.randomUUID(),
    now: dependencies.now?.() ?? Date.now(),
  });
  const db = openNodeSqlDatabase(path);
  try {
    await bootstrap(db, sql, options.execute);
  } finally {
    db.close();
  }
}

async function bootstrap(db: SqlDatabase, sql: BootstrapSql, execute: boolean): Promise<void> {
  const preflight = asReport(await db.prepare(sql.preflight).first(), "preflight");
  if (preflight.status === "refused") {
    throw new Error(`Owner bootstrap preflight was refused: ${preflight.detail}`);
  }
  if (preflight.status === "no-op") {
    console.error(`Nothing to do: ${preflight.detail}.`);
    return;
  }
  if (preflight.status !== "ready") {
    throw new Error("The global store returned no valid Owner bootstrap preflight");
  }
  if (!execute) {
    console.error("Dry run only. Re-run with --execute after reviewing the preflight result.");
    return;
  }

  // One transaction, as the D1 script's result-bearing batch: the mutation
  // and its proof commit together, with one result per statement.
  const results = await db.batch(sql.execution.map((statement) => db.prepare(statement)));
  const postcondition = asReport(results.at(-1)?.results[0], "postcondition");
  if (postcondition.status === "no-op") {
    throw new Error(
      "Owner bootstrap did not prove this invocation completed; ownership may have changed concurrently"
    );
  }
  if (postcondition.status !== "executed" || postcondition.audit_written !== 1) {
    throw new Error("Owner bootstrap execution did not prove its exact audit and assignment");
  }
  console.error("Owner bootstrap command completed; rerun the dry run and expect no-op.");
}

/** The row as the report it must be, printed for the operator's record. */
function asReport(row: unknown, report: BootstrapReport["report"]): BootstrapReport {
  if (typeof row !== "object" || row === null || (row as BootstrapReport).report !== report) {
    throw new Error(`The global store returned no valid Owner bootstrap ${report}`);
  }
  console.log(JSON.stringify(row));
  return row as BootstrapReport;
}

async function main(): Promise<void> {
  await run(parseArgs(process.argv.slice(2), process.env));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
