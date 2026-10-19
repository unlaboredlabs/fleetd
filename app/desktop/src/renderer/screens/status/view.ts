// Everything the Status view says, as pure functions of the doc and the hub's clock. The components only lay these
// out. Raw ids and wire names never reach the screen (the app-wide text rule): sources, limit types, stages and
// rules are turned into words here, and an unknown wire value gets a generic phrase instead of breaking.

import type {
  PathStep,
  HealthMachine,
  HealthUsage,
  InProgressRow,
  ItemStage,
  Progress,
  ProgressPoint,
  Since,
  StaleMark,
  StatusDoc,
  StatusScope,
} from "./contracts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** An age at the view's granularity: "<1m", "4m", "3h", "2d". It changes once a minute at most. */
export const age = (ms: number): string => {
  const m = Math.floor(Math.max(0, ms) / MIN);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  if (m < 2880) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
};

/** How long until `age` would print something else for any of these ages: when to redraw next. */
export const nextAgeChange = (ages: Iterable<number>): number | null => {
  let best: number | null = null;
  for (const raw of ages) {
    const a = Math.max(0, raw);
    const step = a < HOUR ? MIN : a < 2 * DAY ? HOUR : DAY;
    const wait = step - (a % step);
    if (best === null || wait < best) best = wait;
  }
  return best;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const two = (n: number): string => String(n).padStart(2, "0");

/** A time in the viewer's zone: "14:02" today, "Thu 14:02" within a week, else "Oct 21 14:02". */
export const when = (iso: string, nowMs: number): string => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const now = new Date(nowMs);
  const hm = `${two(t.getHours())}:${two(t.getMinutes())}`;
  if (t.toDateString() === now.toDateString()) return hm;
  if (Math.abs(t.getTime() - nowMs) < 6 * DAY) return `${DAYS[t.getDay()] ?? ""} ${hm}`;
  return `${MONTHS[t.getMonth()] ?? ""} ${t.getDate()} ${hm}`;
};

/** "14:02:07", for "as of". */
export const clock = (iso: string): string => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : `${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())}`;
};

const since = (iso: string | undefined, nowMs: number): number | null => {
  if (iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : nowMs - t;
};

/** "stale 4m". */
export const staleAge = (mark: StaleMark, nowMs: number): string => {
  const a = since(mark.since, nowMs);
  return a === null ? "stale" : `stale ${age(a)}`;
};

/** "stale 4m: no heartbeat from buildbox since 09:55". */
export const staleWords = (mark: StaleMark, nowMs: number): string => `${staleAge(mark, nowMs)}: ${mark.reason}`;

/** "as of 4m ago" / "as of 14:02", for a field's own as-of. Under a minute reads "just now". */
export const asOf = (iso: string | undefined, nowMs: number): string => {
  const a = since(iso, nowMs);
  if (a === null) return "as of: never";
  return a < MIN ? "as of just now" : `as of ${age(a)} ago`;
};

const words = (wire: string): string => wire.replaceAll(/[_.:-]+/gu, " ").trim();

/** A stale source's name for people: "machine:buildbox" → "buildbox". */
export const sourceName = (source: string): string => {
  const at = source.indexOf(":");
  const [kind, rest] = at < 0 ? [source, ""] : [source.slice(0, at), source.slice(at + 1)];
  switch (kind) {
    case "machine":
      return rest;
    case "usage":
      return `claude usage on ${rest}`;
    case "ci":
      return `main CI of ${rest}`;
    case "github":
      return `GitHub for ${rest}`;
    case "train":
      return `the ${rest} train`;
    case "webhook":
      return `webhooks for ${rest}`;
    default:
      return rest === "" ? words(kind) : `${words(kind)} ${rest}`;
  }
};

/** claude's limit type: "five_hour" → "5h". */
export const limitName = (limitType: string): string =>
  ({ five_hour: "5h", seven_day: "wk", seven_day_opus: "wk opus", seven_day_sonnet: "wk sonnet" })[limitType] ??
  words(limitType);

const STAGES: Record<string, string> = {
  planned: "planned",
  brief_frozen: "brief ready",
  task_started: "started",
  first_push: "first push",
  pr_open: "PR open",
  review_passed: "review passed",
  ci_green: "CI green",
  merged: "merged",
  verified: "verified",
};
export const stageName = (stage: ItemStage): string => STAGES[stage] ?? words(stage);

/** The figure the view shows, from the progress model when the hub has it, else the verified-only figure. */
export interface Figure {
  /** The headline number; null while the lead is still planning (the view says "planning" instead). */
  readonly pct: number | null;
  /** Solid part of the bar. */
  readonly verifiedPct: number;
  /** Lighter part, after the solid one. */
  readonly inFlightPct: number;
  /** Shown beside the number when the number is an estimate. */
  readonly verifiedNote: string | null;
  /** The planning bar while the lead plans: 0–90. */
  readonly planning: number | null;
  /** "3 of 5 must items verified" / "polish 2/5" / the no-plan sentence. */
  readonly detail: readonly string[];
}

const clampPct = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

export const figure = (p: Progress, virtualTier?: string): Figure => {
  const e = p.estimate;
  const planning = e?.planning?.active === true ? clampPct(e.planning.pct) : null;
  const detail: string[] = [];
  if (p.total > 0) detail.push(`${p.done} of ${p.total} must items verified`);
  if (p.polishTotal > 0) detail.push(`polish ${p.polishDone}/${p.polishTotal}`);
  if (p.total === 0 && p.polishTotal === 0 && planning === null) {
    detail.push(
      virtualTier === undefined
        ? "No plan items yet: nothing to count."
        : `No plan items: this order counts as one ${virtualTier} item until it is verified.`,
    );
  }
  if (!e) return { pct: p.pct, verifiedPct: clampPct(p.pct), inFlightPct: 0, verifiedNote: null, planning, detail };
  const verifiedPct = clampPct(e.verifiedPct);
  return {
    pct: planning === null ? clampPct(e.pct) : null,
    verifiedPct,
    // The lighter part never claims past 100, whatever rounding did.
    inFlightPct: Math.min(clampPct(e.inFlightPct), 100 - verifiedPct),
    verifiedNote: `verified ${verifiedPct}%`,
    planning,
    detail,
  };
};

/** "↓ from 80%" for a scope change that moved the figure. */
export const markerDirection = (before?: number, after?: number): { text: string; down: boolean } | null => {
  if (before === undefined || after === undefined || before === after) return null;
  return after < before ? { text: `↓ from ${before}%`, down: true } : { text: `↑ from ${before}%`, down: false };
};

const DROP_REASONS: Record<string, string> = {
  scope_change: "scope added",
  review_failed: "review failed",
  ci_failed: "CI failed",
  reopened: "reopened",
};
export const dropReason = (reason: string): string => DROP_REASONS[reason] ?? "fell back";

export interface Spark {
  /** SVG path of the estimate, in a width × height box (y grows down). */
  readonly estimate: string;
  readonly verified: string;
  readonly drops: readonly {
    readonly x: number;
    readonly y: number;
    readonly label: string;
    readonly at: string;
  }[];
}

/** The progress series as two lines plus one marker per drop. Fewer than two points draws nothing. */
export const spark = (series: readonly ProgressPoint[], width: number, height: number): Spark | null => {
  if (series.length < 2) return null;
  const times = series.map((p) => Date.parse(p.at));
  const t0 = times[0] ?? 0;
  const t1 = times[times.length - 1] ?? t0;
  const dt = t1 > t0 ? t1 - t0 : 1;
  // Even spacing if the clock is useless (equal or unparsable stamps), so the line still reads.
  const timed = times.every((t) => !Number.isNaN(t)) && t1 > t0;
  const x = (i: number): number => {
    const v = timed ? (((times[i] ?? t0) - t0) / dt) * width : (i / (series.length - 1)) * width;
    return Math.round(v * 10) / 10;
  };
  const y = (pct: number): number => Math.round((height - (clampPct(pct) / 100) * height) * 10) / 10;
  const path = (pick: (p: ProgressPoint) => number): string =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(pick(p))}`).join(" ");
  const drops = series.flatMap((p, i) =>
    p.drop
      ? [{ x: x(i), y: y(p.pct), label: `↓ ${p.drop.fromPct}% → ${p.pct}%: ${p.drop.text} (${dropReason(p.drop.reason)})`, at: p.at }]
      : [],
  );
  return { estimate: path((p) => p.pct), verified: path((p) => p.verifiedPct), drops };
};

/** What the scope waits on, as state, never as a time: the critical path in order ("review of #12 → CI →
 * merge") and what blocks work now, each with how long it has been so (a measured age). */
export interface StateView {
  readonly path: readonly string[];
  readonly blocking: readonly { readonly label: string; readonly since: string | null }[];
}

const stepLabel = (step: PathStep): string => (typeof step === "string" ? step : step.label);

export const stateView = (doc: StatusDoc, nowMs: number): StateView => {
  const sinceText = (iso?: string): string | null => {
    const a = since(iso, nowMs);
    return a === null ? null : `for ${age(a)}`;
  };
  // A hub before the progress model's state fields: its gates, serial first, are the same facts.
  const gates = [...doc.gates].sort((a, b) => Number(b.serial) - Number(a.serial));
  const path = doc.waitingOn !== undefined ? doc.waitingOn.map(stepLabel) : gates.map((g) => g.label);
  const blocking =
    doc.blocking !== undefined
      ? doc.blocking.map((b) => ({ label: b.label, since: sinceText(b.since) }))
      : gates.filter((g) => g.serial).map((g) => ({ label: g.label, since: sinceText(g.since) }));
  return { path, blocking };
};

/** Risk rules that are about predicted time; the product shows none (the hub stops sending them too). */
const TIME_RULES: ReadonlySet<string> = new Set(["slipping", "estimate_drift"]);
export const shownRisks = (doc: StatusDoc): StatusDoc["risks"] => doc.risks.filter((r) => !TIME_RULES.has(r.rule));

/** "Since you looked (09:12):" and its counts; null parts when nothing changed. */
export const sinceView = (s: Since, nowMs: number): { lead: string; parts: readonly { text: string; bad: boolean }[] } => {
  const counts: [number, string, boolean][] = [
    [s.merged, "merged", false],
    [s.verified, "verified", false],
    [s.started, "started", false],
    [s.failed, "failed", true],
    [s.asked, "asked", false],
  ];
  const parts = counts.filter(([n]) => n !== 0).map(([n, w, bad]) => ({ text: `${n} ${w}`, bad }));
  if (s.scopeItems !== 0) {
    const n = Math.abs(s.scopeItems);
    parts.push({ text: `${s.scopeItems > 0 ? "+" : "−"}${n} item${n === 1 ? "" : "s"}`, bad: false });
  }
  const lead = s.pruned
    ? "Since more than 30 days ago:"
    : s.seenAt !== undefined
      ? `Since you looked (${when(s.seenAt, nowMs)}):`
      : "Since you first opened this:";
  return { lead, parts };
};

/** Max utilization per limit type across machines: "58% 5h". */
export const usageView = (usage: readonly HealthUsage[]): readonly { label: string; row: HealthUsage }[] => {
  const best = new Map<string, HealthUsage>();
  for (const u of usage) {
    const cur = best.get(u.limitType);
    if (!cur || (u.utilization ?? -1) > (cur.utilization ?? -1)) best.set(u.limitType, u);
  }
  return [...best.values()].map((row) => ({
    label: row.utilization === undefined ? `? ${limitName(row.limitType)}` : `${Math.round(row.utilization * 100)}% ${limitName(row.limitType)}`,
    row,
  }));
};

/** "offline 4m", "slept 10m46s at 11:02", or "online". */
export const machineView = (m: HealthMachine, nowMs: number): string => {
  const parts: string[] = [];
  if (m.status !== "online") {
    const a = since(m.lastSeenAt, nowMs);
    const status = m.status === "offline" || m.status === "degraded" ? m.status : "not online";
    parts.push(a === null ? status : `${status} ${age(a)}`);
  }
  if (m.slept && nowMs - m.slept.toMs < DAY) {
    const secs = Math.round((m.slept.toMs - m.slept.fromMs) / 1000);
    const len = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${two(secs % 60)}s`;
    parts.push(`slept ${len} at ${when(new Date(m.slept.toMs).toISOString(), nowMs)}`);
  }
  if (m.dropsToday > 1) parts.push(`${m.dropsToday}× today`);
  return parts.length === 0 ? "online" : parts.join(" · ");
};

/** The In-progress row's right side: the stage fleetd saw, its credit, and what it waits on. */
export const progressRowView = (row: InProgressRow): readonly string[] => {
  const meta: string[] = [];
  if (row.stage !== undefined) meta.push(stageName(row.stage));
  if (row.creditPct !== undefined) meta.push(`${clampPct(row.creditPct)}% credited`);
  if (row.gate !== undefined) meta.push(`waiting on ${row.gate}`);
  return meta;
};

/** The headline as shown: the hub writes "Not live: …" for stale sources; if the app itself isn't live, or a
 * stale source isn't named by an older hub's line, the clause is added here so the line never reads as current. */
export const headlineText = (doc: StatusDoc, appLive: boolean): string => {
  const text = doc.headline.text;
  if (text.startsWith("Not live")) return text;
  if (!appLive) return `Not live: ${text}`;
  if (doc.stale.length > 0) return `Not live: ${doc.stale.map((s) => sourceName(s.source)).join(", ")} stale. ${text}`;
  return text;
};

/** Every as-of on screen, so one timer can redraw exactly when one of their ages would read differently. */
export const agesOnScreen = (doc: StatusDoc, nowMs: number): number[] => {
  const stamps: (string | undefined)[] = [
    doc.progress.asOf,
    doc.progress.stale?.since,
    doc.headline.at,
    ...doc.stale.map((s) => s.since),
    ...doc.health.ci.flatMap((c) => [c.asOf, c.stale?.since]),
    ...doc.health.machines.flatMap((m) => [m.status === "online" ? undefined : m.lastSeenAt, m.stale?.since]),
    ...doc.health.usage.flatMap((u) => [u.observedAt, u.stale?.since]),
    ...doc.inProgress.map((r) => r.stale?.since),
  ];
  return stamps.flatMap((s) => {
    const a = since(s, nowMs);
    return a === null ? [] : [a];
  });
};

/** The route for a scope (electron-routes.md). */
export const scopeRoute = (scope: StatusScope): string => {
  switch (scope.kind) {
    case "fleet":
      return "#/status";
    case "project":
      return `#/status/project/${encodeURIComponent(scope.projectRef.machineId)}/${encodeURIComponent(scope.projectRef.projectId)}`;
    case "order":
      return `#/status/order/${encodeURIComponent(scope.workstreamId)}`;
  }
};

/** The scope a status route shows, or null for a route that isn't Status. */
export const scopeFromRoute = (hash: string): StatusScope | null => {
  const path = (hash.replace(/^#/u, "").split("?")[0] ?? "").split("/").filter((p) => p !== "");
  if (path[0] !== "status") return null;
  const [, kind, a, b] = path.map((p) => decodeURIComponent(p));
  if (kind === undefined) return { kind: "fleet" };
  if (kind === "project" && a !== undefined && b !== undefined) return { kind: "project", projectRef: { machineId: a, projectId: b } };
  if (kind === "order" && a !== undefined) return { kind: "order", workstreamId: a };
  return null;
};

/** Cmd+. from a route: an order → its Status, a project's board → the project's, else the fleet's; from Status,
 * back to where it was opened from (the caller keeps that). */
export const statusFor = (hash: string): StatusScope => {
  const path = (hash.replace(/^#/u, "").split("?")[0] ?? "").split("/").filter((p) => p !== "").map((p) => decodeURIComponent(p));
  if (path[0] === "order" && path[1] !== undefined) return { kind: "order", workstreamId: path[1] };
  if (path[0] === "board" && path[1] !== undefined && path[2] !== undefined)
    return { kind: "project", projectRef: { machineId: path[1], projectId: path[2] } };
  return { kind: "fleet" };
};
