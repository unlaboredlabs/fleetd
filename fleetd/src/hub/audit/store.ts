// The workspace's audit log (`audit_log`, migration 202611261317): one row per thing a person or agent did that an
// admin may need to answer for, by name as it was then. Never a value or chat content. `auditLog(hub)` is the area;
// record.ts writes its rows, tools.ts serves `audit_list`, loops.ts drops rows past a year.
import type {
  AuditActor,
  AuditBot,
  AuditEvent,
  AuditKind,
  AuditListInput,
  AuditOutcome,
  KnownAuditKind,
  MachineId,
  ProjectId,
} from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { HubDb } from "../store/db.ts";

/** Every kind this workspace writes, as `audit_list`'s group filter reads them. */
export const AUDIT_KINDS: readonly KnownAuditKind[] = [
  "person.joined",
  "person.left",
  "person.removed",
  "person.role",
  "invite.created",
  "invite.revoked",
  "device.added",
  "device.revoked",
  "bot.settings",
  "bot.erased",
  "vault.created",
  "vault.changed",
  "vault.deleted",
  "vault.revealed",
  "vault.refused",
  "vault.filled",
  "approval.answered",
  "pr.merged",
  "workspace.settings",
  "connection.added",
  "connection.removed",
];

/** How long a row stays: a year. */
export const AUDIT_KEEP_MS = 365 * 24 * 3600_000;

/** One row to write; `at` defaults to now. */
export type NewAuditRow = {
  atMs?: number;
  kind: AuditKind;
  actor: AuditActor;
  bot?: { machineId?: MachineId; projectId: ProjectId; name: string };
  target?: string;
  outcome?: AuditOutcome;
  summary: string;
  /** Ids that go with it (a request's, an item's, a key's): kept for a later reader, never shown. */
  data?: Record<string, unknown>;
};

type Raw = {
  n: number;
  at_ms: number;
  kind: string;
  actor_kind: AuditActor["kind"];
  person_id: string | null;
  actor_name: string;
  machine_id: string | null;
  project_id: string | null;
  bot_name: string | null;
  target: string | null;
  outcome: AuditOutcome;
  summary: string;
};

const eventOf = (x: Raw): AuditEvent => {
  const bot: AuditBot | undefined =
    x.project_id === null ? undefined : { ...(x.machine_id !== null ? { machineId: x.machine_id } : {}), projectId: x.project_id, name: x.bot_name ?? "" };
  return {
    n: x.n,
    at: new Date(x.at_ms).toISOString(),
    kind: x.kind,
    actor: { kind: x.actor_kind, name: x.actor_name, ...(x.person_id !== null ? { personId: x.person_id } : {}) },
    ...(bot ? { bot } : {}),
    ...(x.target !== null ? { target: x.target } : {}),
    outcome: x.outcome,
    summary: x.summary,
  };
};

/** Lines and names are cut to these, so one row stays small whatever it was given. */
const LINE = 300;
const NAME = 120;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const auditLog = (hub: Hub) => hub.area("audit_log", (h) => new AuditLog(h.db, () => h.clock.now()));

export class AuditLog {
  constructor(
    private readonly db: HubDb,
    private readonly now: () => number,
  ) {}

  write(row: NewAuditRow): number {
    const r = this.db.conn
      .query<{ n: number }, (string | number | null)[]>(
        `INSERT INTO audit_log (at_ms, kind, actor_kind, person_id, actor_name, machine_id, project_id, bot_name, target,
           outcome, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING n`,
      )
      .get(
        row.atMs ?? this.now(),
        row.kind,
        row.actor.kind,
        row.actor.personId ?? null,
        cut(row.actor.name, NAME),
        row.bot?.machineId ?? null,
        row.bot?.projectId ?? null,
        row.bot === undefined ? null : cut(row.bot.name, NAME),
        row.target === undefined ? null : cut(row.target, NAME),
        row.outcome ?? "ok",
        cut(row.summary, LINE),
        JSON.stringify(row.data ?? {}),
      );
    return r!.n;
  }

  /** Writes `row`, logging a failure instead of throwing: recording never fails what it records. */
  record(row: NewAuditRow): void {
    try {
      this.write(row);
    } catch (error) {
      console.warn(`audit row not recorded (${row.kind}):`, error);
    }
  }

  /**
   * Newest first, `limit` rows the filters pick before `before`, and whether older ones remain. Each filter has an
   * index of its own, walked by `n` from the newest down, so a page is as quick at a year of rows as at ten.
   */
  list(input: AuditListInput): { events: AuditEvent[]; more: boolean } {
    const limit = Math.max(1, Math.min(500, input.limit ?? 100));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (input.before !== undefined) {
      where.push("n < ?");
      args.push(input.before);
    }
    if (input.personId !== undefined) {
      where.push("person_id = ?");
      args.push(input.personId);
    }
    if (input.projectId !== undefined) {
      where.push("project_id = ?");
      args.push(input.projectId);
    }
    // Rows are numbered as they're written, so a time is also a row number: the first row at or after it, one seek of
    // the time index. Bounding `n` with it lets every other index stop at the window instead of walking past it.
    const firstAt = (ms: number) =>
      this.db.conn.query<{ n: number }, [number]>("SELECT n FROM audit_log WHERE at_ms >= ? ORDER BY at_ms LIMIT 1").get(ms)?.n;
    if (input.since !== undefined) {
      const ms = Date.parse(input.since);
      const from = firstAt(ms);
      if (from === undefined) return { events: [], more: false };
      where.push("n >= ? AND at_ms >= ?");
      args.push(from, ms);
    }
    if (input.until !== undefined) {
      const ms = Date.parse(input.until);
      const to = firstAt(ms);
      where.push("at_ms < ?");
      args.push(ms);
      if (to !== undefined) {
        where.push("n < ?");
        args.push(to);
      }
    }
    // A kind, or a group's kinds (`vault` is every `vault.*`): one walk of the kind index each, newest first, merged.
    const kinds =
      input.kind === undefined || input.kind === ""
        ? undefined
        : input.kind.includes(".")
          ? [input.kind]
          : AUDIT_KINDS.filter((k) => k.startsWith(`${input.kind}.`));
    if (kinds?.length === 0) return { events: [], more: false };
    const one = (conds: string[]) =>
      `SELECT n, at_ms, kind, actor_kind, person_id, actor_name, machine_id, project_id, bot_name, target, outcome, summary
         FROM audit_log ${conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY n DESC LIMIT ?`;
    const sql =
      kinds === undefined
        ? one(where)
        : `${kinds.map(() => `SELECT * FROM (${one(["kind = ?", ...where])})`).join(" UNION ALL ")} ORDER BY n DESC LIMIT ?`;
    const params = kinds === undefined ? [...args, limit + 1] : [...kinds.flatMap((k) => [k, ...args, limit + 1]), limit + 1];
    const rows = this.db.conn.query<Raw, (string | number)[]>(sql).all(...params);
    return { events: rows.slice(0, limit).map(eventOf), more: rows.length > limit };
  }

  /** Drops rows past AUDIT_KEEP_MS; how many went. */
  sweep(now: number): number {
    return this.db.conn.query("DELETE FROM audit_log WHERE at_ms < ?").run(now - AUDIT_KEEP_MS).changes;
  }
}
