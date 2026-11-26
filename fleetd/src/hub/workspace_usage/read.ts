// The Usage page's answer for a period: the counts table (fold.ts) by person, bot and day; merges from the factory
// metrics' landed changes; agent time from the Time view's daily roll-ups. A person's agents, agent time and merges
// are those of the orders they started; their messages and approvals are their own. Each read touches only the
// period's rows through an index on time, so a year of history reads as fast as a week. `read` is the period's
// windows (`period`), the hub's queries, and `assemble`, which fleetd cloud calls with the same rows from its own
// database so both give the same figures. Nothing here needs bun:sqlite at run time.
import type {
  HubRole,
  Person,
  WorkspaceUsageBot,
  WorkspaceUsageCounts,
  WorkspaceUsageDay,
  WorkspaceUsageMember,
  WorkspaceUsageOutput,
} from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";
import { addDays, dateText, dayStart, localDate, type LocalDate } from "../metrics/zone.ts";
const DAY_MS = 86_400_000;

/** What a row of the counts table (fold.ts) counts. */
export type Kind = "message" | "order" | "agent" | "failed" | "stopped" | "approval";

/** A read of the hub's database: the read worker's, or the main connection's in a test. */
export type Read = <T>(sql: string, params: (string | number)[]) => Promise<T[]>;

export type Inputs = {
  now: number;
  tz: string;
  days: 7 | 30 | 90;
  /** Everyone, removed people too. */
  people: Person[];
  /** Each bot's name by "<machine>/<project>". */
  bots: Map<string, string>;
};

/**
 * The span kinds that are an agent working, from the Time view's roll-ups: thinking and output (model), tools, and
 * starting up, compacting and the runner's own (machine). Not its waits (retries, offline) nor the run itself, which
 * only frames them.
 */
export const WORKING = "r.cat IN (0, 1, 2) AND r.kind NOT IN (1, 20, 21, 25)";

/** Merges through fleetd, on a bot's repo. */
const THROUGH_FLEETD = "mm.route IN ('train', 'fleetd_by_hand') AND mm.machine_id IS NOT NULL";

const zero = (): WorkspaceUsageCounts => ({ agents: 0, agentMs: 0, approvals: 0, failed: 0, merged: 0, messages: 0, orders: 0 });

const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
};

const FIELD: Record<Kind, keyof WorkspaceUsageCounts> = {
  message: "messages",
  order: "orders",
  agent: "agents",
  failed: "failed",
  stopped: "failed",
  approval: "approvals",
};

/** Counts under a key, with the ask-to-merge times beside them until the median is taken. */
class Tally {
  readonly by = new Map<string, WorkspaceUsageCounts>();
  readonly asks = new Map<string, number[]>();
  of(key: string): WorkspaceUsageCounts {
    let c = this.by.get(key);
    if (!c) this.by.set(key, (c = zero()));
    return c;
  }
  ask(key: string, ms: number) {
    let l = this.asks.get(key);
    if (!l) this.asks.set(key, (l = []));
    l.push(ms);
  }
  done(key: string): WorkspaceUsageCounts {
    const c = { ...this.of(key) };
    const m = median(this.asks.get(key) ?? []);
    return m === undefined ? c : { ...c, askToMergeMs: m };
  }
}

const any = (c: WorkspaceUsageCounts) => c.agents + c.agentMs + c.approvals + c.failed + c.merged + c.messages + c.orders > 0;
const NUMBERS = ["agents", "agentMs", "approvals", "failed", "merged", "messages", "orders"] as const;

/** The period's windows: its calendar days in `tz`, the period before of the same length, and the UTC days of agent time in each. */
export type Frame = {
  /** The start of the period's first day; `prevSince`, of the period before's. */
  since: number;
  prevSince: number;
  /** Now: the period ends here. `end` is when today ends, for the UTC days whose midday is still to come. */
  until: number;
  end: number;
  dates: LocalDate[];
  /** Each day's [start, end), the last ending now. */
  bounds: [number, number][];
  /** The UTC days of the Time view's roll-ups that count for the period: those whose midday falls in it. */
  periodDays: number[];
  /** The same for the period before, and the two together. */
  prevDays: number[];
  allDays: number[];
};

export function period(i: Pick<Inputs, "now" | "tz" | "days">): Frame {
  const today = localDate(i.now, i.tz);
  const first = addDays(today, -(i.days - 1));
  const since = dayStart(first, i.tz);
  const prevSince = dayStart(addDays(first, -i.days), i.tz);
  const until = i.now;
  const dates: LocalDate[] = Array.from({ length: i.days }, (_, k) => addDays(first, k));
  const bounds = dates.map((d, k): [number, number] => [dayStart(d, i.tz), k + 1 < dates.length ? dayStart(dates[k + 1]!, i.tz) : until]);
  // Agent time is kept by UTC day: each counts on the calendar day its midday falls on, in the totals as in `days`,
  // so a period's are the UTC days whose midday is in it, today's included.
  const end = dayStart(addDays(today, 1), i.tz);
  const utcDays = (from: number, to: number) => {
    const out: number[] = [];
    for (let d = Math.floor(from / DAY_MS) - 1; d * DAY_MS + DAY_MS / 2 < to; d++) if (d * DAY_MS + DAY_MS / 2 >= from) out.push(d);
    return out;
  };
  const periodDays = utcDays(since, end);
  const prevDays = utcDays(prevSince, since);
  return { since, prevSince, until, end, dates, bounds, periodDays, prevDays, allDays: [...prevDays, ...periodDays] };
}

/** What the queries answer, row by row: the hub's SQL here, fleetd cloud's from its own tables. */
export type Rows = {
  /** Counted things from the period before's start until now, by kind, bot, person (the order's starter for an agent's, a failure's) and whether in the period. */
  facts: { kind: Kind; m: string; p: string; who: string | null; cur: number; n: number }[];
  /** Orders, failed agents and stopped orders in the period, each when. */
  perDay: { kind: Kind; at: number }[];
  /** PRs merged through fleetd from the period before's start until now: bot, the order's starter, when merged, when asked. */
  merges: { m: string; p: string; who: string | null; at: number; req: number | null }[];
  /** Agent working time per UTC day of `allDays`, the whole workspace's. */
  fleetMs: { day: number; ms: number }[];
  /** Per bot ("<machine>/<project>") and per person, over `periodDays`. */
  botMs: { key: string; ms: number }[];
  personMs: { who: string; ms: number }[];
  now: { queued: number; running: number; waiting: number }[];
};

export async function read(q: Read, i: Inputs): Promise<WorkspaceUsageOutput> {
  const frame = period(i);
  const { since, prevSince, until } = frame;
  const [facts, perDay, merges, fleetMs, botMs, personMs, now] = await Promise.all([
    q<Rows["facts"][number]>(
      `SELECT f.kind, f.machine_id AS m, f.project_id AS p, COALESCE(f.person_id, o.person_id) AS who, f.at_ms >= ?1 AS cur, COUNT(*) AS n
       FROM usage_facts f
       LEFT JOIN usage_facts o ON f.kind IN ('agent', 'failed', 'stopped') AND o.kind = 'order' AND o.key = f.workstream_id
       WHERE f.at_ms >= ?2 AND f.at_ms < ?3
       GROUP BY f.kind, m, p, who, cur`,
      [since, prevSince, until],
    ),
    q<Rows["perDay"][number]>(
      `SELECT kind, at_ms AS at FROM usage_facts WHERE at_ms >= ?1 AND at_ms < ?2 AND kind IN ('order', 'failed', 'stopped')`,
      [since, until],
    ),
    q<Rows["merges"][number]>(
      `SELECT mm.machine_id AS m, mm.project_id AS p, o.person_id AS who, mm.merged_ms AS at, mm.requested_ms AS req
       FROM metric_merges mm LEFT JOIN usage_facts o ON o.kind = 'order' AND o.key = mm.workstream_id
       WHERE mm.merged_ms >= ?1 AND mm.merged_ms < ?2 AND ${THROUGH_FLEETD}`,
      [prevSince, until],
    ),
    q<Rows["fleetMs"][number]>(
      `SELECT r.day, SUM(r.ms) AS ms FROM json_each(?1) d JOIN time_rollups r ON r.day = d.value AND r.scope = 'fleet'
       WHERE ${WORKING} GROUP BY r.day`,
      [JSON.stringify(frame.allDays)],
    ),
    q<Rows["botMs"][number]>(
      `SELECT r.scope_id AS key, SUM(r.ms) AS ms FROM json_each(?1) d JOIN time_rollups r ON r.day = d.value AND r.scope = 'project'
       WHERE ${WORKING} GROUP BY r.scope_id`,
      [JSON.stringify(frame.periodDays)],
    ),
    q<Rows["personMs"][number]>(
      `SELECT o.person_id AS who, SUM(r.ms) AS ms FROM json_each(?1) d JOIN time_rollups r ON r.day = d.value AND r.scope = 'order'
       JOIN usage_facts o ON o.kind = 'order' AND o.key = r.scope_id
       WHERE ${WORKING} AND o.person_id IS NOT NULL GROUP BY o.person_id`,
      [JSON.stringify(frame.periodDays)],
    ),
    q<Rows["now"][number]>(
      `SELECT (SELECT COUNT(*) FROM tasks WHERE state = 'queued') AS queued, (SELECT COUNT(*) FROM tasks WHERE state = 'running') AS running,
         (SELECT COUNT(*) FROM requests WHERE state = 'open') AS waiting`,
      [],
    ),
  ]);
  return assemble({ facts, perDay, merges, fleetMs, botMs, personMs, now }, i, frame);
}

/** The page's answer from the rows: the same figures wherever the rows came from. */
export function assemble(rows: Rows, i: Inputs, frame: Frame): WorkspaceUsageOutput {
  const { facts, perDay, merges, fleetMs, botMs, personMs, now } = rows;
  const { since, until, dates, bounds, periodDays } = frame;
  const people = new Tally();
  const bots = new Tally();
  const whole = new Tally();
  for (const r of facts) {
    const field = FIELD[r.kind];
    if (r.cur !== 1) {
      whole.of("previous")[field] += r.n;
      continue;
    }
    whole.of("total")[field] += r.n;
    bots.of(`${r.m}/${r.p}`)[field] += r.n;
    if (r.who !== null) people.of(r.who)[field] += r.n;
  }
  for (const r of merges) {
    const ask = r.req !== null && r.req > 0 && r.req <= r.at ? r.at - r.req : undefined;
    if (r.at < since) {
      whole.of("previous").merged += 1;
      if (ask !== undefined) whole.ask("previous", ask);
      continue;
    }
    const keys: [Tally, string][] = [[whole, "total"], [bots, `${r.m}/${r.p}`]];
    if (r.who !== null) keys.push([people, r.who]);
    for (const [t, k] of keys) {
      t.of(k).merged += 1;
      if (ask !== undefined) t.ask(k, ask);
    }
  }
  const inPeriod = new Set(periodDays);
  for (const r of fleetMs) whole.of(inPeriod.has(r.day) ? "total" : "previous").agentMs += r.ms;
  for (const r of botMs) bots.of(r.key).agentMs += r.ms;
  for (const r of personMs) people.of(r.who).agentMs += r.ms;

  const days: WorkspaceUsageDay[] = dates.map((d) => ({ agentMs: 0, date: dateText(d), failed: 0, merged: 0, orders: 0 }));
  const dayOf = (ms: number) => {
    for (let k = bounds.length - 1; k >= 0; k--) if (ms >= bounds[k]![0]!) return k;
    return -1;
  };
  for (const r of perDay) {
    const day = days[dayOf(r.at)];
    if (day === undefined) continue;
    if (r.kind === "order") day.orders += 1;
    else day.failed += 1;
  }
  for (const r of merges) {
    const day = r.at >= since ? days[dayOf(r.at)] : undefined;
    if (day) day.merged += 1;
  }
  // A UTC day's agent time goes to the calendar day its midday falls on.
  const index = new Map(days.map((d, k) => [d.date, k]));
  for (const r of fleetMs) {
    const k = index.get(dateText(localDate(r.day * DAY_MS + DAY_MS / 2, i.tz)));
    if (k !== undefined) days[k]!.agentMs += r.ms;
  }

  const roleOf = new Map<string, HubRole>(i.people.map((p) => [p.personId, p.role]));
  const members: WorkspaceUsageMember[] = i.people
    .filter((p) => p.removedAt === undefined || any(people.of(p.personId)))
    .map((p) => ({
      counts: people.done(p.personId),
      person: { name: p.name, personId: p.personId },
      ...(p.removedAt === undefined ? {} : { removed: true }),
      role: roleOf.get(p.personId) ?? "member",
    }))
    .sort((a, b) => b.counts.agentMs - a.counts.agentMs || b.counts.orders - a.counts.orders || a.person.name.localeCompare(b.person.name));

  const total = whole.done("total");
  const unattributed = zero();
  for (const f of NUMBERS) unattributed[f] = Math.max(0, total[f] - members.reduce((s, m) => s + m.counts[f], 0));

  // Bots removed since are one row: their names went with them.
  const gone = new Tally();
  for (const [key, c] of bots.by) {
    if (i.bots.has(key)) continue;
    const g = gone.of("");
    for (const f of NUMBERS) g[f] += c[f];
    for (const ms of bots.asks.get(key) ?? []) gone.ask("", ms);
  }
  const usage: WorkspaceUsageBot[] = [...bots.by.keys()]
    .filter((key) => i.bots.has(key))
    .map((key): WorkspaceUsageBot => {
      const slash = key.indexOf("/");
      return { counts: bots.done(key), name: i.bots.get(key) ?? key, projectRef: { machineId: key.slice(0, slash), projectId: key.slice(slash + 1) } };
    })
    .concat(gone.by.size === 0 ? [] : [{ counts: gone.done(""), name: "Removed bots" }])
    .filter((b) => any(b.counts))
    .sort((a, b) => b.counts.agentMs - a.counts.agentMs || b.counts.orders - a.counts.orders || a.name.localeCompare(b.name));

  return {
    bots: usage,
    days,
    members,
    now: now[0] ?? { queued: 0, running: 0, waiting: 0 },
    previous: whole.done("previous"),
    since: isoMs(since),
    total,
    unattributed,
    until: isoMs(until),
  };
}
