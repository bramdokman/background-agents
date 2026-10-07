/**
 * The Node host's audit export sinks: the process's stdout, as a JSON line
 * under its own logger component so a log shipper can select the audit
 * stream, and an append-only file of one JSON record per line, the format
 * `scripts/audit-export-check.mjs` verifies.
 *
 * The file is opened once, in append mode, when the host boots: a path
 * that cannot be opened is a configuration error and fails the boot, as a
 * missing data directory would. A write that fails later is logged and
 * dropped; the audit row itself is already committed, and a sink must never
 * fail the request that wrote it.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import type { AuditExportRecord, AuditExportSink } from "../db/audit-export";
import { createLogger, type Logger } from "../logger";
import type { NodeHostSettings } from "./config";

/** The `component` of every exported event on stdout; nothing else logs under it. */
export const AUDIT_EXPORT_LOG_COMPONENT = "audit-export";

/** Export records are append-only audit evidence, private to the host user like the stores. */
const EXPORT_FILE_MODE = 0o600;

export interface NodeAuditExportSink extends AuditExportSink {
  /** Close the export file, if one is open. Later writes are logged as failures. */
  close(): void;
}

/**
 * The sink the settings ask for, or null when the export is off. The
 * stdout logger emits at `info` regardless of `LOG_LEVEL`: an operator who
 * enabled the export asked for every event.
 */
export function openAuditExportSink(
  settings: Pick<NodeHostSettings, "auditExportStdout" | "auditExportFile">,
  log: Logger
): NodeAuditExportSink | null {
  const { auditExportStdout, auditExportFile } = settings;
  if (!auditExportStdout && auditExportFile === undefined) return null;

  const stdout = auditExportStdout ? createLogger(AUDIT_EXPORT_LOG_COMPONENT) : null;
  let fd: number | null = null;
  if (auditExportFile !== undefined) {
    try {
      fd = openSync(auditExportFile, "a", EXPORT_FILE_MODE);
    } catch (cause) {
      throw new Error(
        `AUDIT_EXPORT_FILE ${auditExportFile} cannot be opened for appending: ${describe(cause)}`
      );
    }
  }

  return {
    write(record: AuditExportRecord): void {
      // The record's own keys are the line; the logger adds its envelope around them.
      stdout?.info("audit.event", { ...record });
      if (auditExportFile === undefined) return;
      try {
        if (fd === null) throw new Error("export file is closed");
        writeSync(fd, `${JSON.stringify(record)}\n`);
      } catch (cause) {
        log.error("Audit export file write failed; the audit row is committed", {
          event: "audit.export_file_write_failed",
          path: auditExportFile,
          audit_event_id: record.id,
          error: cause instanceof Error ? cause : String(cause),
        });
      }
    },
    close(): void {
      if (fd === null) return;
      closeSync(fd);
      fd = null;
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
