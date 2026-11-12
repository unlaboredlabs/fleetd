// The vault's audit log (vault-design §5): one `vault_audit` row per use, naming who, which item (and its label at
// the time), where and how it went. Never a value: `data` carries labels, hosts, field names and variable names.
// Rows stay 365 days. The Rust hub writes the same rows for its fills, so the shapes here are shared:
// - machine_id/project_id: the calling session's project; person_id: whose work it is;
// - data: { label, kind, fields, site, frame, host (the browser's machine), sessionId, message, typed, purchaseId,
//   names (an inject's variable names), via }.
import type { Database } from "bun:sqlite";

import { AUDIT_KEEP_MS, type AuditAction, type AuditData, type AuditEntry, type AuditOutcome, type NewAudit } from "./audit_entry.ts";

export { AUDIT_KEEP_MS, type AuditAction, type AuditData, type AuditEntry, type AuditOutcome, type NewAudit } from "./audit_entry.ts";

type Raw = {
  n: number;
  at_ms: number;
  item_id: string;
  action: AuditAction;
  outcome: AuditOutcome;
  person_id: string | null;
  device_id: string | null;
  machine_id: string | null;
  project_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  workstream_id: string | null;
  data: string;
};

const HOUR = 3600_000;

const entryOf = (x: Raw): AuditEntry => {
  let data: AuditData = {};
  try {
    data = JSON.parse(x.data) as AuditData;
  } catch {}
  return {
    n: x.n,
    atMs: x.at_ms,
    itemId: x.item_id,
    action: x.action,
    outcome: x.outcome,
    ...(x.person_id !== null ? { personId: x.person_id } : {}),
    ...(x.device_id !== null ? { deviceId: x.device_id } : {}),
    ...(x.machine_id !== null ? { machineId: x.machine_id } : {}),
    ...(x.project_id !== null ? { projectId: x.project_id } : {}),
    ...(x.thread_id !== null ? { threadId: x.thread_id } : {}),
    ...(x.task_id !== null ? { taskId: x.task_id } : {}),
    ...(x.workstream_id !== null ? { workstreamId: x.workstream_id } : {}),
    data,
  };
};

export class VaultAudit {
  constructor(private readonly db: Database) {}

  write(e: NewAudit): number {
    const row = this.db
      .query<{ n: number }, (string | number | null)[]>(
        `INSERT INTO vault_audit (at_ms, item_id, action, outcome, person_id, device_id, machine_id, project_id, thread_id,
           task_id, workstream_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING n`,
      )
      .get(
        e.atMs,
        e.itemId,
        e.action,
        e.outcome,
        e.personId ?? null,
        e.deviceId ?? null,
        e.machineId ?? null,
        e.projectId ?? null,
        e.threadId ?? null,
        e.taskId ?? null,
        e.workstreamId ?? null,
        JSON.stringify(e.data),
      );
    return row!.n;
  }

  get(n: number): AuditEntry | undefined {
    const x = this.db.query<Raw, [number]>("SELECT * FROM vault_audit WHERE n = ?").get(n);
    return x ? entryOf(x) : undefined;
  }

  /** Closes a pending row once (a fill's or a purchase's outcome); false when it was no longer pending. */
  settle(n: number, outcome: AuditOutcome, extra: AuditData): boolean {
    const x = this.get(n);
    if (!x || x.outcome !== "pending") return false;
    const changed = this.db
      .query("UPDATE vault_audit SET outcome = ?, data = ? WHERE n = ? AND outcome = 'pending'")
      .run(outcome, JSON.stringify({ ...x.data, ...extra }), n);
    return changed.changes === 1;
  }

  /** Newest first: rows `where` picks, before `before` (a row number). */
  list(where: string, params: (string | number)[], before: number | undefined, limit: number): AuditEntry[] {
    const cond = before !== undefined ? `(${where}) AND n < ?` : where;
    const args = before !== undefined ? [...params, before] : params;
    return this.db
      .query<Raw, (string | number)[]>(`SELECT * FROM vault_audit WHERE ${cond} ORDER BY n DESC LIMIT ?`)
      .all(...args, Math.max(1, Math.min(500, limit)))
      .map(entryOf);
  }

  /** Fills of `itemId` for project `r` in the last hour, refusals aside (30 an hour allowed). */
  fillsForItem(itemId: string, machineId: string, projectId: string, now: number): number {
    return (
      this.db
        .query<{ n: number }, [string, string, string, number]>(
          `SELECT count(*) AS n FROM vault_audit WHERE item_id = ? AND machine_id = ? AND project_id = ?
             AND action IN ('fill', 'purchase') AND outcome <> 'refused' AND at_ms > ?`,
        )
        .get(itemId, machineId, projectId, now - HOUR)?.n ?? 0
    );
  }

  /** Fills a browser host made in the last hour (300 an hour allowed). */
  fillsOnHost(host: string, now: number): number {
    return (
      this.db
        .query<{ n: number }, [string, number]>(
          `SELECT count(*) AS n FROM vault_audit WHERE action IN ('fill', 'purchase') AND outcome <> 'refused'
             AND json_extract(data, '$.host') = ? AND at_ms > ?`,
        )
        .get(host, now - HOUR)?.n ?? 0
    );
  }

  /** Refusals one browser session drew in the last ten minutes. */
  refusalsIn(sessionId: string, now: number): number {
    return (
      this.db
        .query<{ n: number }, [string, number]>(
          `SELECT count(*) AS n FROM vault_audit WHERE action = 'fill_refused' AND json_extract(data, '$.sessionId') = ?
             AND at_ms > ?`,
        )
        .get(sessionId, now - 10 * 60_000)?.n ?? 0
    );
  }

  /** Drops rows past AUDIT_KEEP_MS. */
  sweep(now: number): number {
    return this.db.query("DELETE FROM vault_audit WHERE at_ms < ?").run(now - AUDIT_KEEP_MS).changes;
  }
}
