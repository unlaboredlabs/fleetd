// The live strip's model, pure: how many of a project's agents are at work, waiting on you, on hold and queued, a dot
// and a line for each, which of them the now-line shows, and the PRs they are on. It reads only the data layer
// (src/data). `selectStrip` keeps the same object until something it draws changes, so a lane's every token doesn't
// redraw it.
import { selectProjectWork, type ProjectWork } from "../../src/data/selectors";
import type { DataState } from "../../src/data/store";
import type { AgentLane, AgentRole, PrRef } from "./contracts";
import { projectKey } from "./lanes";
import { describe, isChecker, isFinal, isWorking, type Line } from "./words";

export interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

/**
 * The agents the strip counts: every agent of the project's orders, not the lead, not finished, and not idle. An idle
 * lane's session has stopped (its task books the result a moment later), so it neither holds a slot nor has anything
 * to show.
 */
const shownLanes = (w: ProjectWork): AgentLane[] => w.lanes.filter((l) => l.role !== "lead" && !isFinal(l.status) && l.status !== "idle");

/** On a PR: checking it, or the writer whose task opened it. */
const isOn = (l: AgentLane, pr: PrRef): boolean =>
  l.pr?.number === pr.number || (!isChecker(l.role) && pr.taskId !== undefined && l.taskId === pr.taskId);

/** An agent's dot: at work (it breathes), waiting on you (the attention color), on hold, or queued (hollow). */
export type AgentState = "working" | "needsYou" | "onHold" | "queued";

const stateOf = (l: AgentLane): AgentState =>
  isWorking(l.status) ? "working" : l.status === "waiting" ? "needsYou" : l.status === "queued" ? "queued" : "onHold";

/** The order the dots and the lanes go in: what wants you first, then what runs, then what doesn't yet. */
const ORDER: Readonly<Record<AgentState, number>> = { needsYou: 0, working: 1, onHold: 2, queued: 3 };

/** One agent as the strip draws it: a dot, and in the opened strip a row that opens it in the panel. */
export interface StripAgent {
  readonly laneId: string;
  readonly role: AgentRole;
  readonly title: string;
  readonly state: AgentState;
  /** What it is doing now, as the agents view says it. */
  readonly line: Line;
}

/** The buckets of an agent's sparkline that count as now: the last 16 seconds. */
const RECENT = 8;

/** How much an agent did lately: its sparkline's recent work. */
const recentWork = (l: AgentLane): number => (l.live?.spark?.samples ?? []).slice(-RECENT).reduce((a, b) => a + b, 0);

/** Tool work reads busier than writing or planning, and those than waiting on the model. */
const lineRank = (line: Line): number => (line.machine !== undefined ? 0 : line.tone === "loud" ? 1 : line.thinking ? 3 : 2);

/**
 * The agents the now-line may show, the busiest first: those at work by their recent work, then by what they are
 * doing, then as the board has them. With none at work, those waiting on you, so the line says what for.
 */
const nowOrder = (agents: readonly StripAgent[], lanes: readonly AgentLane[]): string[] => {
  const work = new Map(lanes.map((l) => [l.laneId, recentWork(l)]));
  const working = agents.filter((a) => a.state === "working");
  if (working.length === 0) return agents.filter((a) => a.state === "needsYou").map((a) => a.laneId);
  return working
    .map((a, i) => ({ a, i, work: work.get(a.laneId) ?? 0, rank: lineRank(a.line) }))
    .sort((x, y) => y.work - x.work || x.rank - y.rank || x.i - y.i)
    .map(({ a }) => a.laneId);
};

export interface Strip {
  /** Every agent counted; nothing is drawn without one. */
  readonly agents: number;
  /** Agents whose session runs, as the max-agents count has them: a slot is held from its grant until the session stops. */
  readonly working: number;
  readonly needsYou: number;
  /** Stopped mid-task: stalled, or paused at a usage limit. */
  readonly onHold: number;
  readonly queued: number;
  /** The PRs the agents are on, lowest first. */
  readonly prs: readonly number[];
  /** Every agent counted, those waiting on you first, then at work, on hold and queued; the board's order within. */
  readonly lanes: readonly StripAgent[];
  /** The agents the now-line may show, the one to show first leading; empty when nothing has anything to say. */
  readonly now: readonly string[];
}

const agentOf = (l: AgentLane): StripAgent => ({ laneId: l.laneId, role: l.role, title: l.title, state: stateOf(l), line: describe(l) });

export const stripOf = (lanes: readonly AgentLane[], prs: readonly PrRef[] = []): Strip => {
  const agents = lanes
    .map(agentOf)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => ORDER[x.a.state] - ORDER[y.a.state] || x.i - y.i)
    .map(({ a }) => a);
  return { ...counts(lanes, prs), lanes: agents, now: nowOrder(agents, lanes) };
};

const counts = (lanes: readonly AgentLane[], prs: readonly PrRef[]): Omit<Strip, "lanes" | "now"> => ({
  agents: lanes.length,
  working: lanes.filter((l) => isWorking(l.status)).length,
  needsYou: lanes.filter((l) => l.status === "waiting").length,
  onHold: lanes.filter((l) => l.status === "stalled" || l.status === "parked").length,
  queued: lanes.filter((l) => l.status === "queued").length,
  prs: prs
    .filter((pr) => lanes.some((l) => isOn(l, pr)))
    .map((pr) => pr.number)
    .sort((a, b) => a - b),
});

const count = (n: number, one: string, many: string): string[] => (n > 0 ? [`${n} ${n === 1 ? one : many}`] : []);

/** "3 agents working · 1 needs you · 1 queued"; empty when nothing is shown (the strip then isn't drawn). */
export const stripHeadline = (s: Strip): string =>
  [
    ...count(s.working, "agent working", "agents working"),
    ...count(s.needsYou, "needs you", "need you"),
    ...count(s.onHold, "on hold", "on hold"),
    ...count(s.queued, "queued", "queued"),
  ].join(" · ");

/** The PRs after the headline, as words and PR numbers: "on #221", "on #9, #10 and #11", "on #9, #10, #11 and 2 more". */
export const stripPrs = (prs: readonly number[]): Array<string | number> => {
  if (prs.length === 0) return [];
  const named = prs.slice(0, prs.length > 4 ? 3 : prs.length);
  const rest = prs.length - named.length;
  const out: Array<string | number> = ["on "];
  named.forEach((n, i) => {
    if (i > 0) out.push(rest === 0 && i === named.length - 1 ? " and " : ", ");
    out.push(n);
  });
  if (rest > 0) out.push(` and ${rest} more`);
  return out;
};

/** How long the now-line stays on one agent before it may turn to a busier one. */
export const NOW_DWELL_MS = 6000;

/**
 * The agent the now-line shows: the busiest, except that one already shown stays for `dwell` (while it still has
 * something to say), so the line turns over gently rather than flickering between two agents about as busy.
 */
export const nowAgent = (
  now: readonly string[],
  shown: { readonly laneId: string; readonly since: number } | undefined,
  at: number,
  dwell: number = NOW_DWELL_MS,
): string | undefined => {
  if (shown !== undefined && now.includes(shown.laneId) && at - shown.since < dwell) return shown.laneId;
  return now[0];
};

/** The hub's clock skew, for elapsed times read against the hub's clock (Status). */
export const selectSkew = (s: DataState): number => s.live.skewMs ?? 0;

const sameStrip = (a: Strip, b: Strip): boolean => JSON.stringify(a) === JSON.stringify(b);

const selectors = new Map<string, (s: DataState) => Strip | undefined>();

/**
 * A project's strip, the same object until what it draws changes (a count, a dot, an agent's line, who is busiest); undefined until the board has loaded (draw nothing,
 * never "0 agents"). One selector per project, memoized on its own.
 */
export const selectStrip = (project: ProjectRef): ((s: DataState) => Strip | undefined) => {
  const key = projectKey(project);
  let selector = selectors.get(key);
  if (selector !== undefined) return selector;
  let last: Strip | undefined;
  const work = selectProjectWork(key);
  selector = (s: DataState) => {
    const w = work(s);
    if (w === undefined) return undefined;
    const next = stripOf(shownLanes(w), w.prs);
    if (last !== undefined && sameStrip(last, next)) return last;
    last = next;
    return next;
  };
  selectors.set(key, selector);
  return selector;
};
