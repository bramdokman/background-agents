/**
 * Bootstrap the first workspace Owner by canonical user ID.
 *
 * Dry-run (remote D1 by default):
 *   npm run rbac:bootstrap-owner -- --database <d1-name> --user <canonical-user-id>
 *
 * Execute after reviewing the preflight result:
 *   npm run rbac:bootstrap-owner -- --database <d1-name> --user <canonical-user-id> --execute
 *
 * Wrangler uses the normal CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID
 * environment variables or the credentials established by `wrangler login`.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildBootstrapSql,
  CANONICAL_USER_ID,
} from "../packages/control-plane/src/node/owner-bootstrap-sql.ts";

const VALUE_OPTIONS = new Set(["database", "user"]);
const FLAG_OPTIONS = new Set(["execute"]);

/** Validated command-line options for the Owner bootstrap operation. */
export interface BootstrapCliOptions {
  database: string;
  userId: string;
  execute: boolean;
}

/** Parse and validate Owner bootstrap command-line arguments. */
export function parseArgs(argv: string[]): BootstrapCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
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

  const database = values.get("database");
  if (!database?.trim()) throw new Error("--database is required");
  const userId = values.get("user");
  if (!userId) throw new Error("--user is required");
  if (!CANONICAL_USER_ID.test(userId)) {
    throw new Error("--user must be a canonical 32-character lowercase hexadecimal user ID");
  }

  return {
    database: database.trim(),
    userId,
    execute: flags.has("execute"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readReport(
  stdout: string,
  statementCount: number,
  report: "preflight" | "postcondition"
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("Wrangler returned a malformed JSON result");
  if (parsed.length !== statementCount) {
    throw new Error(`Wrangler returned ${parsed.length} results for ${statementCount} statements`);
  }

  const results = parsed.map((result) => {
    if (
      !isRecord(result) ||
      result.success !== true ||
      !Array.isArray(result.results) ||
      !result.results.every(isRecord)
    ) {
      throw new Error("Wrangler returned a malformed JSON result");
    }
    return result.results;
  });
  const rows = results.at(-1);
  if (rows?.length !== 1 || rows[0].report !== report) {
    throw new Error(`Wrangler returned no valid Owner bootstrap ${report}`);
  }
  console.log(JSON.stringify(rows[0]));
  return rows[0];
}

type WranglerRunner = (database: string, operation: readonly string[]) => string;

/** Injectable side effects for deterministic bootstrap orchestration tests. */
export interface BootstrapRunDependencies {
  runWrangler?: WranglerRunner;
  randomUUID?: () => string;
  now?: () => number;
}

function runWrangler(database: string, operation: readonly string[]): string {
  const child = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", database, "--remote", ...operation, "--json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (child.status !== 0) {
    throw new Error(`Owner bootstrap refused or failed:\n${child.stderr || child.stdout}`);
  }
  return child.stdout;
}

/** Run the remote Owner bootstrap workflow and verify its postcondition. */
export async function run(
  options: BootstrapCliOptions,
  dependencies: BootstrapRunDependencies = {}
): Promise<void> {
  const runner = dependencies.runWrangler ?? runWrangler;
  console.error(`${options.execute ? "Executing" : "Dry-running"} Owner bootstrap on remote D1...`);
  const sql = buildBootstrapSql({
    userId: options.userId,
    auditId: dependencies.randomUUID?.() ?? crypto.randomUUID(),
    now: dependencies.now?.() ?? Date.now(),
  });
  const { status } = readReport(
    runner(options.database, ["--command", sql.preflight]),
    1,
    "preflight"
  );
  if (status !== "ready" && status !== "no-op" && status !== "refused") {
    throw new Error("Wrangler returned no valid Owner bootstrap preflight");
  }
  if (status === "refused") throw new Error("Owner bootstrap preflight was refused");
  if (status === "no-op") return;
  if (!options.execute) {
    console.error("Dry run only. Re-run with --execute after reviewing the preflight result.");
    return;
  }

  // Like WranglerD1Database.batch, use D1's result-bearing /query transaction:
  // the mutation and its proof commit together, with one result per statement.
  const postcondition = readReport(
    runner(options.database, ["--command", sql.execution.join("\n")]),
    sql.execution.length,
    "postcondition"
  );
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

async function main(): Promise<void> {
  await run(parseArgs(process.argv.slice(2)));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
