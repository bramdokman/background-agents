/**
 * Structured JSON logger for the Teams bot.
 *
 * Delegates to the shared logger factory from @open-inspect/shared,
 * pre-binding the "teams-bot" service name so callers don't repeat it.
 */

import { createLogger as _createLogger, type LogLevel } from "@open-inspect/shared/logger";
import type { Logger } from "@open-inspect/shared/logger";
export type { Logger, LogLevel } from "@open-inspect/shared/logger";

const SERVICE_NAME = "teams-bot";

export function createLogger(
  component: string,
  context: Record<string, unknown> = {},
  minLevel: LogLevel = "info"
): Logger {
  return _createLogger(component, context, minLevel, SERVICE_NAME);
}

/** Normalize a thrown value for the logger's `error` field. */
export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
