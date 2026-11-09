// Status: one row per project, a state word, its work in groups, agents running and the last merge
// (crates/fleetd/src/hub/status/rows.rs). Observed only, never an estimate.
import type { Database } from "bun:sqlite";
import type { HubEventType, Machine, ProjectRef, ProjectRowState, ProjectStatusRow, StaleMark } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { hubZone } from "../attention/index.ts";
import { chat } from "../chat/index.ts";
import { leadAccountKey } from "../claude_accounts/index.ts";
import { leads } from "../leads/index.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { type Fresh, github, train } from "./fresh.ts";
import { line, read as readGroups } from "./groups.ts";

const DAY_MS = 24 * 3_600_000;

export const pkey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

export function projectRef(key: string): ProjectRef {
  const slash = key.indexOf("/");
  return slash < 0 ? { machineId: key, projectId: "" } : { machineId: key.slice(0, slash), projectId: key.slice(slash + 1) };
}

/** Event types that can change a row: `fleetd status --watch` reads the rows again after one. */
export const CHANGES_A_ROW: HubEventType[] = [
  "machine.online", "machine.offline", "machine.degraded", "machine.guard", "project.added", "project.removed",
  "chat.message", "chat.waiting", "lead.started", "workstream.created", "workstream.running", "workstream.state",
  "workstream.done", "task.queued", "task.started", "task.completed", "task.failed", "task.cancelled", "thread.waiting",
  "thread.usage_limited", "thread.started", "thread.completed", "thread.failed", "thread.interrupted", "request.opened",
  "request.updated", "review.verdict", "change.queued", "change.ready", "change.needs_rebase", "change.ci_failed",
  "change.refused", "change.state", "pr.merged", "pr.merged_outside", "usage.breaker", "usage.resumed", "ci.main",
  "source.stale", "source.fresh",
] as HubEventType[];

function parts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: p.year, mon: p.month, d: p.day, wd: p.weekday, hm: `${p.hour}:${p.minute}` };
}

/** "14:02" today, "Thu 14:00" within a week, else "Oct 21 14:00", in the hub's zone. */
export function clock(ms: number, now: number, tz: string): string {
  if (Number.isNaN(new Date(ms).getTime())) return isoMs(ms);
  const t = parts(ms, tz);
  const n = parts(now, tz);
  if (t.y === n.y && t.mon === n.mon && t.d === n.d) return t.hm;
  if (Math.abs(ms - now) < 6 * DAY_MS) return `${t.wd} ${t.hm}`;
  return `${t.mon} ${t.d} ${t.hm}`;
}

/** An offline machine's mark: since its last heartbeat. */
function machineStale(m: Machine, now: number, tz: string): StaleMark | undefined {
  if (m.status !== "offline") return undefined;
  const seen = parseMs(m.lastSeenAt) ?? now;
  return { reason: line(`no heartbeat from ${m.machineId} since ${clock(seen, now, tz)}`, 200), since: isoMs(seen) };
}

/** A project's latest merge. */
export type Merged = { atMs: number; title: string; prNumber: number; prUrl?: string };

/** How many PRs looked back for the latest merge of each project. */
const MERGES_READ = 1000;

/**
 * Per project: its latest merge (from `pr.merged`, titled by the writer task, else the order), and its PRs in review,
 * CI or the train now.
 */
export function readChanges(c: Database): [Map<string, Merged>, Map<string, number>] {
  const inFlight = new Map<string, number>();
  for (const row of c
    .query<{ pk: string; n: number }, []>(
      `SELECT machine_id || '/' || project_id AS pk, COUNT(*) AS n FROM changes
       WHERE state IN ('queued', 'reviewing', 'ready', 'rebasing', 'ci', 'merging') GROUP BY 1`,
    )
    .all()) {
    inFlight.set(row.pk, row.n);
  }
  const merges = new Map<string, Merged>();
  const rows = c
    .query<{ at: number; pk: string | null; change: string | null; pr: number | null }, [number]>(
      `SELECT created_ms AS at, json_extract(data, '$.machineId') || '/' || json_extract(data, '$.projectId') AS pk,
         json_extract(data, '$.data.changeId') AS change, json_extract(data, '$.data.prNumber') AS pr
       FROM events WHERE type = 'pr.merged' ORDER BY seq DESC LIMIT ?1`,
    )
    .all(MERGES_READ);
  for (const { at, pk, change: changeId, pr } of rows) {
    if (pk === null || merges.has(pk)) continue;
    let change: Record<string, unknown> | undefined;
    if (changeId?.startsWith("X")) {
      const n = Number.parseInt(changeId.slice(1), 10);
      const data = c.query<{ data: string }, [number]>("SELECT data FROM changes WHERE n = ?1").get(Number.isNaN(n) ? -1 : n)?.data;
      try {
        change = data === undefined ? undefined : (JSON.parse(data) as Record<string, unknown>);
      } catch {
        change = undefined;
      }
    }
    const s = (k: string) => (typeof change?.[k] === "string" ? (change[k] as string) : undefined);
    const titleOf = (sql: string, id: string | undefined) => {
      const n = id === undefined ? Number.NaN : Number.parseInt(id.slice(1), 10);
      if (Number.isNaN(n)) return undefined;
      return c.query<{ t: string | null }, [number]>(sql).get(n)?.t ?? undefined;
    };
    const title =
      titleOf("SELECT json_extract(data, '$.title') AS t FROM tasks WHERE n = ?1", s("taskId")) ??
      titleOf("SELECT json_extract(data, '$.title') AS t FROM workstreams WHERE n = ?1", s("workstreamId"));
    const prNumber = pr ?? (typeof change?.prNumber === "number" ? change.prNumber : 0);
    const prUrl = s("prUrl");
    merges.set(pk, { atMs: at, title: title ?? `PR #${prNumber}`, prNumber, ...(prUrl === undefined ? {} : { prUrl }) });
  }
  return [merges, inFlight];
}

/** What decides a row's state word. */
export type Facts = { needsYou: boolean; blocked?: string; agents: number; inFlight: number; leadWorking: boolean };

/** Waiting on you first (only you can move it), then blocked, then working; idle when nothing runs or waits. */
export function stateOf(f: Facts): ProjectRowState {
  if (f.needsYou) return "waiting_on_you";
  if (f.blocked !== undefined) return "blocked";
  if (f.agents > 0 || f.inFlight > 0 || f.leadWorking) return "working";
  return "idle";
}

/** A project's 7-day merge fact (metrics `weeks`). */
export type Week = { merged: number; throughFleetdPct?: number };

/**
 * What a row reads from areas still porting, each with the Rust hub's answer for a hub without it: the train's repos
 * and red-main note (train), the usage pause (usage), running agents (slots), the lead's Claude account
 * (claude_accounts) and the 7-day merges (metrics). Each area assigns its own onto this object when it starts.
 */
export type StatusInputs = {
  trainRepos(): [repo: string, r: ProjectRef][];
  mainCiNote(repo: string): string | undefined;
  usageGate(machineId: string, account: string | undefined): string | undefined;
  agentsRunning(r: ProjectRef): number;
  leadAccountKey(r: ProjectRef): string | undefined;
  /** Each project's 7-day merges, by `machine/project`, caught up first. */
  weeks(nowMs: number, tz: string): Map<string, Week>;
};

export const statusInputs = (hub: Hub) =>
  hub.area<StatusInputs>("status_inputs", (h) => ({
    trainRepos: () =>
      h.db
        .all<{ repo: string; machine_id: string; project_id: string }>("SELECT repo, machine_id, project_id FROM trains ORDER BY repo")
        .map((t) => [t.repo, { machineId: t.machine_id, projectId: t.project_id }]),
    mainCiNote: () => undefined,
    usageGate: () => undefined,
    agentsRunning: () => 0,
    leadAccountKey: (r) => leadAccountKey(h.db, r),
    weeks: () => new Map(),
  }));

/** Every project's row, by title, read at `now`. */
export function read(hub: Hub, fresh: Fresh, now: number): ProjectStatusRow[] {
  const tz = hubZone();
  const inputs = statusInputs(hub);
  const [merges, inFlight] = readChanges(hub.db.conn);
  // Status never fails on the metrics: a row whose 7-day fact can't be read leaves it out.
  let weeks = new Map<string, Week>();
  try {
    weeks = inputs.weeks(now, tz);
  } catch (error) {
    console.warn("status: 7-day merges not read:", error);
  }
  const machines = store(hub).machinesList();
  const projects = store(hub)
    .projectsShown()
    .map((p) => [`${p.machineId}/${p.projectId}`, p.title] as const)
    .sort((a, b) => {
      const ta = a[1].toLowerCase();
      const tb = b[1].toLowerCase();
      return ta < tb ? -1 : ta > tb ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
  const allRepos = inputs.trainRepos().map(([repo, p]) => [repo.toLowerCase(), pkey(p)] as const);
  const out: ProjectStatusRow[] = [];
  for (const [pk, title] of projects) {
    const r = projectRef(pk);
    const machine = machines.find((m) => m.machineId === r.machineId);
    const mname = machine?.name ?? r.machineId;
    const repos = allRepos.filter(([, p]) => p === pk).map(([repo]) => repo);
    // The usage layer's pause, else a window claude rejected.
    const gate = inputs.usageGate(r.machineId, inputs.leadAccountKey(r));
    const usagePaused = gate?.startsWith("usage: ") ? gate.slice(7) : gate;
    // A window claude rejected, until it resets: an older node keeps reporting it after.
    let usageHit: number | null | undefined;
    for (const l of link(hub).load(r.machineId)?.limits ?? []) {
      if (l.status !== "rejected") continue;
      const resets = l.resetsAt === undefined ? undefined : parseMs(l.resetsAt);
      if (resets !== undefined && resets <= now) continue;
      const v = resets ?? null;
      // Rust's Option max: any time beats none.
      usageHit = usageHit === undefined || usageHit === null ? v : v === null ? usageHit : Math.max(usageHit, v);
    }
    // A red main stops nothing (the train keeps merging): a warning, never a block.
    let warning: string | undefined;
    for (const repo of repos) {
      const note = inputs.mainCiNote(repo);
      if (note !== undefined) {
        warning = repos.length > 1 ? `${note} in ${repo}` : note;
        break;
      }
    }
    const why = machine?.degradedReason?.trim();
    const cant = why ? `${mname} can't run agents: ${why.replace(/\.+$/, "")} (see Machines)` : `${mname} can't run agents (see Machines)`;
    let blocked: string | undefined;
    if (machine?.status === "offline") blocked = `${mname} is offline`;
    else if (machine?.status === "degraded") blocked = usagePaused !== undefined ? `${cant}, and its usage is paused` : cant;
    else if (usagePaused !== undefined) blocked = usagePaused;
    else if (usageHit !== undefined) {
      blocked = usageHit === null ? `usage limit reached on ${mname}` : `usage limit reached on ${mname} until ${clock(usageHit, now, tz)}`;
    } else blocked = link(hub).paused(r.machineId);
    // The lead chat's own rule, so the row and the chat's needs-you dot never disagree; a read that announces nothing.
    let state: { needsYou: boolean; leadWorking: boolean } | undefined;
    try {
      state = chat(hub).state(r, leads(hub).get(r)?.state === "working");
    } catch {
      state = undefined;
    }
    const facts: Facts = {
      needsYou: state?.needsYou === true,
      ...(blocked === undefined ? {} : { blocked }),
      agents: inputs.agentsRunning(r),
      inFlight: inFlight.get(pk) ?? 0,
      leadWorking: state?.leadWorking === true,
    };
    // Its machine first, then GitHub and the merge train of its repos.
    let stale = machine ? machineStale(machine, now, tz) : undefined;
    for (const repo of repos) {
      if (stale) break;
      for (const source of [github(repo), train(repo)]) {
        const st = fresh.view(source, now)?.stale;
        if (st) {
          stale = { reason: line(st.reason, 200), since: isoMs(st.sinceMs) };
          break;
        }
      }
    }
    const usagePausedOn = usagePaused !== undefined && machine?.status !== "offline" ? r.machineId : undefined;
    const [counts, items] = readGroups(hub, r, facts.needsYou, now);
    const merged = merges.get(pk);
    const week = weeks.get(pk);
    out.push({
      agentsRunning: Math.max(0, facts.agents),
      asOf: isoMs(now),
      ...(facts.blocked === undefined ? {} : { blockedReason: line(facts.blocked, 160) }),
      counts,
      items,
      ...(merged
        ? {
            lastMerged: {
              at: isoMs(merged.atMs),
              ...(merged.prNumber > 0 ? { prNumber: merged.prNumber } : {}),
              ...(merged.prUrl !== undefined && merged.prUrl !== "" && merged.prUrl.length <= 300 ? { prUrl: merged.prUrl } : {}),
              title: line(merged.title, 120),
            },
          }
        : {}),
      ...(week ? { merged7d: week.merged } : {}),
      projectRef: r,
      ...(stale ? { stale } : {}),
      state: stateOf(facts),
      ...(week?.throughFleetdPct === undefined ? {} : { throughFleetdPct7d: week.throughFleetdPct }),
      title: line(title, 120),
      ...(usagePausedOn === undefined ? {} : { usagePausedOn, usagePausedReason: line(usagePaused as string, 160) }),
      ...(warning === undefined ? {} : { warning: line(warning, 160) }),
    });
  }
  return out;
}
