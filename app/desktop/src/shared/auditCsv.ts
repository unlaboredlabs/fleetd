// The audit log as CSV, one writer for Settings › Workspace › Audit log's Export and `fleetd audit --csv`, so the two
// files are the same for the same rows. A cell that a spreadsheet would read as a formula starts with a quote.
import type { AuditEvent } from "./contracts/contracts.ts";

export const AUDIT_CSV_HEADER = ["time", "person", "actor", "kind", "bot", "target", "outcome", "summary"] as const;

function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One line, without its line end. */
export const auditCsvLine = (e: AuditEvent): string =>
  [e.at, e.actor.name, e.actor.kind, e.kind, e.bot?.name ?? "", e.target ?? "", e.outcome, e.summary].map(cell).join(",");

/** The header and every row, in the order given (newest first, as `audit_list` pages them). */
export const auditCsv = (events: readonly AuditEvent[]): string =>
  [AUDIT_CSV_HEADER.join(","), ...events.map(auditCsvLine)].join("\r\n") + "\r\n";
