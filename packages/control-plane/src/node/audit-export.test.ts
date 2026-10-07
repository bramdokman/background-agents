import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditExportRecord } from "../db/audit-export";
import type { Logger } from "../logger";
import { AUDIT_EXPORT_LOG_COMPONENT, openAuditExportSink } from "./audit-export";

const record: AuditExportRecord = {
  id: "evt-1",
  occurredAt: "2026-10-07T10:00:00.000Z",
  action: "team.created",
  operationResult: "applied",
  reasonCode: "team.created",
  requestId: "req-1",
  principal: { kind: "user", userId: "user-1", service: null },
  target: { userId: null },
  resource: { type: "team", id: "team-1", teamId: "team-1" },
  metadata: { before: {}, requested: {}, after: {} },
};

const log: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => log,
};

describe("openAuditExportSink", () => {
  let dir: string;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-export-"));
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(log.error).mockClear();
  });

  afterEach(() => {
    stdout.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is off, and writes nothing, when neither setting is enabled", () => {
    expect(openAuditExportSink({ auditExportStdout: false, auditExportFile: undefined }, log)).toBe(
      null
    );
    expect(stdout).not.toHaveBeenCalled();
  });

  it("writes one stdout line per event under its own component, event ID first", () => {
    const sink = openAuditExportSink({ auditExportStdout: true, auditExportFile: undefined }, log);
    sink?.write(record);
    sink?.close();

    expect(stdout).toHaveBeenCalledTimes(1);
    const line = JSON.parse(stdout.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "info",
      component: AUDIT_EXPORT_LOG_COMPONENT,
      msg: "audit.event",
      ...record,
    });
    const envelope = ["level", "service", "component", "msg"];
    expect(Object.keys(line).slice(envelope.length)).toEqual([...Object.keys(record), "ts"]);
  });

  it("appends one JSON line per event to the file, keeping what was there", () => {
    const path = join(dir, "audit.jsonl");
    writeFileSync(path, "existing\n");
    const sink = openAuditExportSink({ auditExportStdout: false, auditExportFile: path }, log);
    sink?.write(record);
    sink?.write({ ...record, id: "evt-2" });
    sink?.close();

    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines).toEqual([
      "existing",
      JSON.stringify(record),
      JSON.stringify({ ...record, id: "evt-2" }),
      "",
    ]);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("creates a missing file private to the host user", () => {
    const path = join(dir, "audit.jsonl");
    openAuditExportSink({ auditExportStdout: false, auditExportFile: path }, log)?.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to open a path it cannot append to", () => {
    expect(() =>
      openAuditExportSink(
        { auditExportStdout: false, auditExportFile: join(dir, "missing", "audit.jsonl") },
        log
      )
    ).toThrow(/AUDIT_EXPORT_FILE .* cannot be opened for appending/);
  });

  it("logs a failed file write and returns, so the caller's write still succeeds", () => {
    const path = join(dir, "audit.jsonl");
    const sink = openAuditExportSink({ auditExportStdout: true, auditExportFile: path }, log);
    sink?.close();

    expect(() => sink?.write(record)).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe("");
    // The stdout line still went out: one sink's failure does not silence the other.
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.error).mock.calls[0][1]).toMatchObject({
      event: "audit.export_file_write_failed",
      path,
      audit_event_id: "evt-1",
    });
  });
});
