#!/usr/bin/env node
/**
 * Verifies an audit export file (AUDIT_EXPORT_FILE, or the "audit-export"
 * lines a log shipper collected from stdout): every line is a JSON object
 * with a non-empty string `id`, no `id` repeats, and `occurredAt` is an ISO
 * timestamp that never goes backwards. Reports every problem with its line
 * number and exits 1 when there is one.
 *
 * Usage: node scripts/audit-export-check.mjs FILE
 */

import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * Check `lines`, an iterable or async iterable of lines without their
 * newlines. Empty lines at the end are the file's final newline; an empty
 * line before another event is a problem. Returns the number of events and
 * the problems found, each with its 1-based line number.
 */
export async function checkAuditExport(lines) {
  const problems = [];
  const seen = new Set();
  let events = 0;
  let previous = null;
  let number = 0;
  let emptySince = [];
  for await (const line of lines) {
    number += 1;
    if (line === "") {
      emptySince.push(number);
      continue;
    }
    for (const empty of emptySince) {
      problems.push({ line: empty, message: "empty line inside the export" });
    }
    emptySince = [];

    let record;
    try {
      record = JSON.parse(line);
    } catch (cause) {
      problems.push({ line: number, message: `not JSON: ${cause.message}` });
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      problems.push({ line: number, message: "not a JSON object" });
      continue;
    }
    events += 1;

    const { id, occurredAt } = record;
    if (typeof id !== "string" || id === "") {
      problems.push({ line: number, message: "missing or empty id" });
    } else if (seen.has(id)) {
      problems.push({ line: number, message: `duplicate id ${id}` });
    } else {
      seen.add(id);
    }

    const timestamp = typeof occurredAt === "string" ? Date.parse(occurredAt) : NaN;
    if (Number.isNaN(timestamp)) {
      problems.push({ line: number, message: `occurredAt is not an ISO timestamp: ${occurredAt}` });
      continue;
    }
    if (previous !== null && timestamp < previous) {
      problems.push({
        line: number,
        message: `occurredAt ${occurredAt} is earlier than the previous event`,
      });
    }
    previous = timestamp;
  }
  return { events, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error("Usage: node scripts/audit-export-check.mjs FILE");
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  const { events, problems } = await checkAuditExport(lines);
  for (const { line, message } of problems) console.error(`${path}:${line}: ${message}`);
  const verdict = problems.length === 0 ? "PASS" : "FAIL";
  console.log(`${path}: ${events} events, ${problems.length} problems ${verdict}`);
  if (problems.length > 0) process.exitCode = 1;
}
