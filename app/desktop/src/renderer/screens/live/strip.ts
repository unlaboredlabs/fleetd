// The agents at work, pure: how many of a project's agents are at work, waiting on you, on hold and queued, a glyph and
// a line for each, and the PRs they are on (chat/Island.tsx, its card's Lanes). It reads only the data layer
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

/** An agent's state on the strip, as its glyph shows it: at work, waiting on you, on hold, or queued. */
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
}

const agentOf = (l: AgentLane): StripAgent => ({ laneId: l.laneId, role: l.role, title: l.title, state: stateOf(l), line: describe(l) });

export const stripOf = (lanes: readonly AgentLane[], prs: readonly PrRef[] = []): Strip => {
  const agents = lanes
    .map(agentOf)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => ORDER[x.a.state] - ORDER[y.a.state] || x.i - y.i)
    .map(({ a }) => a);
  return { ...counts(lanes, prs), lanes: agents };
};

const counts = (lanes: readonly AgentLane[], prs: readonly PrRef[]): Omit<Strip, "lanes"> => ({
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

const sameStrip = (a: Strip, b: Strip): boolean => JSON.stringify(a) === JSON.stringify(b);

const selectors = new Map<string, (s: DataState) => Strip | undefined>();

/**
 * A project's strip, the same object until what it draws changes (a count, a glyph, an agent's line); undefined until the board has loaded (draw nothing,
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
