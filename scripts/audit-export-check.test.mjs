import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkAuditExport } from "./audit-export-check.mjs";

const SCRIPT = fileURLToPath(new URL("./audit-export-check.mjs", import.meta.url));

function event(id, occurredAt) {
  return JSON.stringify({
    id,
    occurredAt,
    action: "team.created",
    operationResult: "applied",
    reasonCode: "team.created",
    requestId: "req-1",
    principal: { kind: "user", userId: "user-1", service: null },
    target: { userId: null },
    resource: { type: "team", id: "team-1", teamId: "team-1" },
    metadata: { before: {}, requested: {}, after: {} },
  });
}

const GOOD = [
  event("a", "2026-10-07T10:00:00.000Z"),
  event("b", "2026-10-07T10:00:00.000Z"),
  event("c", "2026-10-07T10:00:01.000Z"),
];

test("accepts a file of unique, non-decreasing events, with or without a final newline", async () => {
  assert.deepEqual(await checkAuditExport(GOOD), { events: 3, problems: [] });
  assert.deepEqual(await checkAuditExport([...GOOD, ""]), { events: 3, problems: [] });
  assert.deepEqual(await checkAuditExport([]), { events: 0, problems: [] });
});

test("rejects a duplicate id, naming the line", async () => {
  const { events, problems } = await checkAuditExport([
    ...GOOD,
    event("b", "2026-10-07T10:00:02.000Z"),
  ]);
  assert.equal(events, 4);
  assert.deepEqual(problems, [{ line: 4, message: "duplicate id b" }]);
});

test("rejects a timestamp earlier than the previous event's", async () => {
  const { problems } = await checkAuditExport([...GOOD, event("d", "2026-10-07T09:59:59.000Z")]);
  assert.deepEqual(problems, [
    { line: 4, message: "occurredAt 2026-10-07T09:59:59.000Z is earlier than the previous event" },
  ]);
});

test("rejects lines that are not JSON objects, blank lines inside the file, and bad fields", async () => {
  const { events, problems } = await checkAuditExport([
    GOOD[0],
    "",
    "{not json",
    "[]",
    JSON.stringify({ id: "", occurredAt: "2026-10-07T10:00:00.000Z" }),
    JSON.stringify({ id: "e", occurredAt: 1759831200000 }),
    "",
  ]);
  assert.equal(events, 3);
  assert.deepEqual(
    problems.map(({ line, message }) => [line, message.split(":")[0]]),
    [
      [2, "empty line inside the export"],
      [3, "not JSON"],
      [4, "not a JSON object"],
      [5, "missing or empty id"],
      [6, "occurredAt is not an ISO timestamp"],
    ]
  );
});

test("the command exits 0 on a good file and 1 with each problem on stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-export-check-"));
  try {
    const good = join(dir, "good.jsonl");
    writeFileSync(good, `${GOOD.join("\n")}\n`);
    const pass = spawnSync(process.execPath, [SCRIPT, good], { encoding: "utf8" });
    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(pass.stdout, `${good}: 3 events, 0 problems PASS\n`);

    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, `${[...GOOD, event("a", "2026-10-07T09:00:00.000Z")].join("\n")}\n`);
    const fail = spawnSync(process.execPath, [SCRIPT, bad], { encoding: "utf8" });
    assert.equal(fail.status, 1);
    assert.equal(
      fail.stderr,
      `${bad}:4: duplicate id a\n` +
        `${bad}:4: occurredAt 2026-10-07T09:00:00.000Z is earlier than the previous event\n`
    );
    assert.equal(fail.stdout, `${bad}: 4 events, 2 problems FAIL\n`);

    const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    assert.notEqual(usage.status, 0);
    assert.match(usage.stderr, /Usage: node scripts\/audit-export-check.mjs FILE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
