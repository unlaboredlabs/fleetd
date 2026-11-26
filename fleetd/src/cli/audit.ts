// `fleetd audit`: the workspace's audit log, newest first, from the workspace's machine. Like `fleetd people`, it opens
// the workspace home's database directly (read-only), so the workspace need not be running. --csv writes the same file
// Settings › Workspace › Audit log exports (app/desktop/src/shared/auditCsv.ts).
import { auditCsvLine, AUDIT_CSV_HEADER } from "../../../app/desktop/src/shared/auditCsv.ts";
import type { AuditEvent, AuditListInput } from "../shared/contracts.ts";
import { AuditLog } from "../hub/audit/store.ts";
import { ArgError, parse, type Parsed } from "./args.ts";
import { resolveHome } from "./common.ts";
import { type CliResult, err, ok } from "./result.ts";
import { listPeople, openHub } from "./store.ts";
import { AUDIT_USAGE } from "./usages.ts";
export { AUDIT_USAGE };

const usage = (message: string) => err(2, `fleetd: ${message}\n\nusage:\n${AUDIT_USAGE}`);
const fail = (message: string) => err(1, `fleetd: ${message}\n`);

/** `7d`, `24h`, `30m` before `now`, or a date or time (`2026-11-01`, `2026-11-01T09:00:00Z`); undefined when it's neither. */
export function timeArg(text: string, now: number): string | undefined {
  const ago = /^(\d+)([dhm])$/.exec(text);
  if (ago) return new Date(now - Number(ago[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[ago[2] as "d" | "h" | "m"]).toISOString();
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

type Db = ReturnType<typeof openHub>;

/** The person `who` names: an id, or a name (any case). */
function personFilter(db: Db, who: string): string {
  if (/^p_[a-z2-7]{8}$/.test(who)) return who;
  const found = listPeople(db, true).filter((p) => p.name.toLowerCase() === who.toLowerCase());
  if (found.length === 1) return found[0]!.personId;
  throw new Error(found.length === 0 ? `no person named ${who}; \`fleetd people\` lists them` : `${found.length} people are named ${who}: pass their id (fleetd people)`);
}

/** The bot `bot` names: its id, or its name (any case); a deleted bot by the name its rows kept. */
function botFilter(db: Db, bot: string): string {
  const live = db.conn
    .query<{ project_id: string }, [string, string]>("SELECT project_id FROM projects WHERE project_id = ? OR lower(json_extract(data, '$.title')) = lower(?)")
    .all(bot, bot);
  const ids = new Set(live.map((r) => r.project_id));
  if (ids.size === 0) {
    for (const r of db.conn
      .query<{ project_id: string }, [string]>("SELECT DISTINCT project_id FROM audit_log WHERE lower(bot_name) = lower(?) AND project_id IS NOT NULL")
      .all(bot)) {
      ids.add(r.project_id);
    }
  }
  if (ids.size === 1) return [...ids][0]!;
  throw new Error(ids.size === 0 ? `no bot named ${bot}` : `${ids.size} bots are named ${bot}: pass its id`);
}

function filters(v: Parsed, db: Db, now: number): AuditListInput {
  const input: AuditListInput = {};
  const who = v.str("person");
  if (who !== undefined) input.personId = personFilter(db, who);
  const bot = v.str("bot");
  if (bot !== undefined) input.projectId = botFilter(db, bot);
  const kind = v.str("kind");
  if (kind !== undefined) input.kind = kind;
  for (const name of ["since", "until"] as const) {
    const text = v.str(name);
    if (text === undefined) continue;
    const at = timeArg(text, now);
    if (at === undefined) throw new ArgError(`--${name} takes 7d, 24h, 30m, a date or a time, not ${text}`);
    input[name] = at;
  }
  return input;
}

const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)}… ` : s.padEnd(n + 1));

/** One row as a line: time (UTC, to the minute), who, kind, bot, then what happened. */
function line(e: AuditEvent): string {
  const at = `${e.at.slice(0, 10)} ${e.at.slice(11, 16)}`;
  const outcome = e.outcome === "ok" ? "" : ` [${e.outcome}]`;
  return `${at}  ${pad(e.actor.name, 24)}${pad(e.kind, 20)}${pad(e.bot?.name ?? "", 20)}${e.summary}${outcome}\n`;
}

export function auditCommand(argv: string[], home?: string, now = Date.now()): CliResult {
  const v = parse(argv, { options: { person: "str", bot: "str", kind: "str", since: "str", until: "str", limit: "str", csv: "bool" }, positionals: true });
  if (v instanceof ArgError) return usage(v.message);
  if (v.positionals.length > 0) return usage(`unexpected ${v.positionals[0]}`);
  const limitText = v.str("limit");
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) return usage("--limit is a whole number above 0");
  let db: Db;
  try {
    db = openHub(resolveHome(home));
  } catch (error) {
    return fail((error as Error).message);
  }
  try {
    const input = filters(v, db, now);
    const log = new AuditLog(db, () => now);
    const csv = v.flag("csv");
    // Plain text shows the newest 50 unless --limit; --csv every row the filters pick unless --limit.
    const want = limit ?? (csv ? Number.POSITIVE_INFINITY : 50);
    const rows: AuditEvent[] = [];
    let before: number | undefined;
    let more = true;
    while (more && rows.length < want) {
      const page = log.list({ ...input, limit: Math.min(500, want - rows.length), ...(before === undefined ? {} : { before }) });
      rows.push(...page.events);
      more = page.more;
      before = page.events.at(-1)?.n;
      if (before === undefined) break;
    }
    if (csv) return ok([AUDIT_CSV_HEADER.join(","), ...rows.map(auditCsvLine)].join("\r\n") + "\r\n");
    if (rows.length === 0) return ok("Nothing in the audit log matches.\n");
    const tail = more ? `… older rows too: --limit <n> shows more, --csv writes every one.\n` : "";
    return ok(rows.map(line).join("") + tail);
  } catch (error) {
    if (error instanceof ArgError) return usage(error.message);
    return fail((error as Error).message);
  } finally {
    db.conn.close();
  }
}
