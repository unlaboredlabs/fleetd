// Words and figures for the time inspector: durations read like the CLI's, and every figure that is a bound, a
// split or an approximation says so (spec §2f) with the same mark everywhere.
import { KIND_CATEGORY, SPAN_KINDS, type AgentRole, type Category, type Coverage, type Gap, type Span, type SpanKind } from "./types.ts";

export interface Lane {
  readonly role: AgentRole;
  readonly title: string;
  readonly model?: string;
  readonly laneId?: string;
  /** Its place by start among agents with the same role and title (two reviewers of one PR); absent when unique. */
  readonly nth?: number;
}

/** "1st", "2nd", "3rd", "11th", "22nd". */
export const ordinal = (n: number): string => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
};

/**
 * An agent as the screen names it: what it worked on, else its role, never a task number. Agents doing the same
 * work (every reviewer of one PR is "review #113") are told apart by their order of start: "review #113 · 2nd".
 */
export const agentName = (lane: Pick<Lane, "role" | "title" | "nth">): string => {
  const base = lane.title.trim() !== "" ? lane.title : ROLE_WORD[lane.role];
  return lane.nth === undefined ? base : `${base} · ${ordinal(lane.nth)}`;
};

/** Numbers the lanes whose role and title collide, by start (then lane id), so every name on screen is its own. */
export const numberCollisions = (lanes: ReadonlyMap<string, Lane & { readonly startedAt?: string }>): Map<string, Lane> => {
  const groups = new Map<string, string[]>();
  for (const [id, l] of lanes) {
    const key = `${l.role}\u0000${agentName({ role: l.role, title: l.title })}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const out = new Map<string, Lane>();
  for (const [id, { startedAt: _, ...l }] of lanes) out.set(id, l);
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const start = (id: string) => lanes.get(id)?.startedAt ?? "";
    ids
      .sort((a, b) => start(a).localeCompare(start(b)) || (lanes.get(a)?.laneId ?? a).localeCompare(lanes.get(b)?.laneId ?? b))
      .forEach((id, i) => {
        const l = out.get(id);
        if (l !== undefined) out.set(id, { ...l, nth: i + 1 });
      });
  }
  return out;
};

/** What the hub's ids are called on screen. Built from the live store by whoever mounts the screen. */
export interface Names {
  /** thread id → its lane: the agent's role, what it worked on, its model, and the lane id live frames use. */
  readonly threads: ReadonlyMap<string, Lane>;
  /** The projects' lead threads. */
  readonly leads: ReadonlySet<string>;
  /** change id → PR number. */
  readonly changes: ReadonlyMap<string, number>;
  /** workstream id → its title, its project's title, and the project (its chat is where it is opened). */
  readonly orders: ReadonlyMap<string, { readonly title: string; readonly project: string; readonly ref: { readonly machineId: string; readonly projectId: string } }>;
  readonly projects: readonly { readonly machineId: string; readonly projectId: string; readonly title: string }[];
  readonly machines: readonly string[];
}

export const NO_NAMES: Names = {
  threads: new Map(),
  leads: new Set(),
  changes: new Map(),
  orders: new Map(),
  projects: [],
  machines: [],
};

/** "840 ms", "3.2s", "42s", "2m10s", "34m", "1h42m". */
export const fmtDur = (raw: number): string => {
  const ms = Math.max(0, Math.round(raw));
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 600_000) {
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 60_000);
    return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, "0")}s`;
  }
  const m = Math.floor((ms + 30_000) / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

/** "312 B", "48 KB", "1.2 MB", "118 MB". */
export const fmtBytes = (raw: number): string => {
  const b = Math.max(0, raw);
  const k = 1024;
  if (b < k) return `${b} B`;
  if (b < k * k) return `${Math.round(b / k)} KB`;
  if (b < 10 * k * k) return `${(b / k / k).toFixed(1)} MB`;
  if (b < k * k * k) return `${Math.round(b / k / k)} MB`;
  return `${(b / k / k / k).toFixed(1)} GB`;
};

const two = (n: number) => String(n).padStart(2, "0");

// Every time the inspector shows is in the viewer's own zone, as a clock reads: no zone name, no ISO stamps.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "10:21:04" for a hub ms stamp, local. */
export const clockMs = (ms: number): string => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

/** "Oct 12", local. */
export const dayMs = (ms: number): string => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()] ?? ""} ${d.getDate()}`;
};

/** "Oct 12, 09:30", local. */
export const stampMs = (ms: number): string => {
  const d = new Date(ms);
  return `${dayMs(ms)}, ${two(d.getHours())}:${two(d.getMinutes())}`;
};


/** An axis tick: "10:15", "10:15:30" when zoomed under ten minutes, and the day ("Oct 18") at local midnight. */
export const tickLabel = (t: number, v0: number, v1: number): string => {
  const d = new Date(t);
  if (v1 - v0 >= 3_600_000 && d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return dayMs(t);
  return v1 - v0 < 10 * 60_000 ? clockMs(t) : clockMs(t).slice(0, 5);
};

/** "39%", or "<1%" for a sliver that is still there. */
export const pct = (part: number, whole: number): string => {
  if (whole <= 0 || part <= 0) return "0%";
  const p = (part * 100) / whole;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
};

/** "▲ 12%", "▼ 31%", "same"; "new" when the earlier period had none. */
export const delta = (before: number, now: number): string => {
  if (before === 0) return now === 0 ? "same" : "new";
  const p = Math.round(((now - before) * 100) / before);
  if (p === 0) return "same";
  return p > 0 ? `▲ ${p}%` : `▼ ${-p}%`;
};

export const CAT_LABEL: Record<Category, string> = {
  model: "model",
  tools: "tools",
  machine: "machine",
  queue: "queue",
  human: "you",
  pipeline: "CI · review · merge",
  idle: "idle",
};

/** The categories in the order the breakdown and the legend list them. */
export const SHOWN: readonly Category[] = ["model", "tools", "pipeline", "queue", "human", "machine"];

export const KIND_WORD: Record<SpanKind, string> = {
  run: "run",
  "model.message": "model message",
  "model.first_token": "first token",
  "model.thinking": "thinking",
  "model.output": "output",
  "tool.bash": "Bash",
  "tool.read": "Read",
  "tool.edit": "Edit",
  "tool.web": "web",
  "tool.mcp": "MCP",
  "tool.other": "other tools",
  "tools.parallel": "parallel tools",
  git: "git",
  "check.claim": "done-when checks",
  "wait.retry.api": "API retries",
  "wait.retry.node": "node retries",
  "run.startup": "startup",
  compaction: "compaction",
  "claude.other": "claude overhead",
  "wait.offline": "machine offline",
  "queue.slot": "agent limit",
  "queue.lease": "waiting on another agent",
  "queue.usage": "usage limit",
  "queue.offline": "machine offline",
  "run.queued": "behind a run",
  "wake.debounce": "lead start delay",
  "park.usage": "paused at usage limit",
  "slots.full": "at the agent limit",
  "wait.permission": "approvals",
  "wait.request": "requests",
  "change.review": "review",
  "change.queue": "merge queue",
  "change.rebase": "rebase",
  "change.ci": "CI",
  "ci.check": "CI check",
  "ci.queue": "CI queue",
  "change.merge": "merge",
  "change.blocked": "blocked",
  "intake.route": "routing",
  idle: "idle",
  gap: "missing data",
};

export const ROLE_WORD: Record<AgentRole, string> = {
  lead: "lead",
  implementer: "implementer",
  reader: "reader",
  reviewer: "reviewer",
  verifier: "verifier",
  qa: "QA",
};

/** The marks a figure can carry: approximate, an upper bound, whole-second precision, or a rule-based split. */
export type Mark = "≈" | "≤" | "±1 s" | "split" | "";

export interface Inexact {
  readonly mark: Mark;
  readonly why: string;
}

export const WHY = {
  firstToken:
    "Time to the first token includes claude's own work before the request, the network, API queueing and prefill; they can't be told apart.",
  phases: "Split as streamed: summarized thinking can arrive in bursts. The message's total is exact.",
  parallel:
    "Ran alongside other tools from the same message, so this call's own time is an upper bound. The group's time is exact.",
  ciCheck: "GitHub's own start and end, which are whole seconds.",
  human: "From when the ask was published to your answer; when you first saw it isn't known.",
  lead: "One lead turn serves all the work it woke for; its time is split equally across it.",
} as const;

/** What a span's figure can't say exactly (spec §2f): the mark beside the number and the sentence behind it. */
export const inexact = (span: Span, names: Names, parallel: boolean): Inexact | undefined => {
  switch (span.kind) {
    case "model.first_token":
      return { mark: "≈", why: WHY.firstToken };
    case "model.thinking":
    case "model.output":
      return { mark: "≈", why: WHY.phases };
    default:
      break;
  }
  if (parallel) return { mark: "≤", why: WHY.parallel };
  if (span.kind === "ci.check") return { mark: "±1 s", why: WHY.ciCheck };
  if (span.kind === "wait.request") return { mark: "", why: WHY.human };
  if (span.threadId !== undefined && names.leads.has(span.threadId)) return { mark: "split", why: WHY.lead };
  return undefined;
};

/** A duration with its mark in front when the mark qualifies the number: "≈ 3.2s", "≤ 48s"; "±1 s" goes after. */
export const markedDur = (ms: number, mark: Mark | undefined): string => {
  const d = fmtDur(ms);
  if (mark === "≈" || mark === "≤") return `${mark} ${d}`;
  if (mark === "±1 s") return `${d} ±1 s`;
  return d;
};

export const spanMs = (span: Span, nowMs: number): number => (span.endMs ?? nowMs) - span.startMs;

/**
 * The command, the path, the check, the ask, or the kind's word. An ask's key is internal, so screens pass the
 * design system's humanizeKey; this file stays free of UI imports because the fixture build runs it under Node.
 */
export const spanTitle = (span: Span, humanize: (key: string) => string = (k) => k): string => {
  if (span.extra?.check !== undefined) return span.extra.check;
  if (span.extra?.key !== undefined) return `secret: ${humanize(span.extra.key)}`;
  if (span.label !== undefined && span.label !== "") return span.label;
  return KIND_WORD[span.kind];
};

/** Whether the title is machine text (a command, path or check name) and so set in mono. */
export const titleIsMachineText = (span: Span): boolean =>
  span.extra?.check !== undefined || (span.label !== undefined && span.label !== "");

/** The other lanes by what they are to the user. */
const LANE_WORD: Readonly<Record<string, string>> = { train: "merge queue", requests: "requests", fleet: "all projects", order: "this work" };

/** "about page", "lead", "PR #212", "requests". */
export const laneName = (names: Names, span: Span): string => {
  const thread = span.threadId;
  if (thread !== undefined) {
    if (names.leads.has(thread)) return "lead";
    const lane = names.threads.get(thread);
    if (lane !== undefined) return agentName(lane);
    return "an agent";
  }
  const change = span.lane.startsWith("change:") ? span.lane.slice("change:".length) : undefined;
  if (change !== undefined) {
    const pr = names.changes.get(change);
    return pr === undefined ? "PR" : `PR #${pr}`;
  }
  const kind = span.lane.split(":")[0] ?? span.lane;
  return LANE_WORD[kind] ?? kind;
};

/** What to say is missing. `complete: false` alone says nothing: a long read past retention is the cutoff's business. */
export interface Missing {
  readonly gaps: number;
  readonly capped: boolean;
  /** "Oct 12": the retention cutoff's day, when what is shown began before it. */
  readonly detailSince?: string;
}

export const isMissingEmpty = (m: Missing): boolean => m.gaps === 0 && !m.capped && m.detailSince === undefined;

/** `from`: when what is shown began (an order's start, a period's since); unknown flags no cutoff. */
export const missing = (c: Coverage, from: number | undefined): Missing => {
  const cut = c.detailSince === undefined ? Number.NaN : Date.parse(c.detailSince);
  const before = from !== undefined && Number.isFinite(cut) && from < cut;
  return {
    gaps: c.gaps.length,
    capped: c.capped === true,
    ...(before && c.detailSince !== undefined ? { detailSince: dayMs(cut) } : {}),
  };
};

/** "Oct 16, 16:20 to 18:02", or "Oct 16, 23:40 to Oct 17, 00:10" across midnight: a gap can be days back. */
export const rangeText = (fromMs: number, toMs: number): string =>
  `${stampMs(fromMs)} to ${dayMs(fromMs) === dayMs(toMs) ? stampMs(toMs).slice(-5) : stampMs(toMs)}`;

/** One coverage gap in words: "a machine runs a fleetd too old to record tool time (buildbox), Oct 16, 16:20 to 18:02". */
export const gapText = (g: Gap): string => {
  const count = g.count === undefined ? "" : `${g.count} `;
  const what: Record<Gap["why"], string> = {
    node_older: "a machine runs a fleetd too old to record tool time",
    node_dropped: `a machine dropped ${count}spans it couldn't send in time`,
    hub_dropped: `the hub was too busy to keep ${count}spans`,
    no_node_spans: "a session has no tool timeline",
    nothing_running: "the critical path found time with nothing running",
  };
  const on = g.machineId === undefined ? "" : ` (${g.machineId})`;
  return `${what[g.why]}${on}, ${rangeText(g.fromMs, g.toMs)}`;
};

export const gapWord = (why: Gap["why"]): string => {
  switch (why) {
    case "node_older":
    case "no_node_spans":
      return "no tool timeline";
    case "node_dropped":
    case "hub_dropped":
      return "spans lost";
    case "nothing_running":
      return "nothing running";
  }
};

/** The sentence a coverage banner says, or undefined when nothing is missing. */
export const missingSentence = (m: Missing, c: Coverage): string | undefined => {
  if (isMissingEmpty(m)) return undefined;
  const reasons = c.gaps.map(gapText);
  if (m.capped) reasons.push("capped: there are more spans than the hub reads at once, so only the newest are drawn");
  if (m.detailSince !== undefined) reasons.push(`detail since ${m.detailSince}; totals before that come from daily roll-ups`);
  return reasons.join("; ");
};

/** Envelopes hold their children's time, not their own. */
const ENVELOPES: readonly SpanKind[] = ["run", "model.message", "tools.parallel"];

/**
 * The kinds whose spans make up a category, as a breakdown row links them: every kind of it but the envelopes, so
 * pipeline includes each CI check even though checks carry no exclusive time of their own.
 */
export const categoryKinds = (cat: Category): SpanKind[] => SPAN_KINDS.filter((k) => KIND_CATEGORY[k] === cat && !ENVELOPES.includes(k));
