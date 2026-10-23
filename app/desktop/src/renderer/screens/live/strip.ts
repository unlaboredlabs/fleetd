// The live strip's model, pure: how many of a project's agents are at work, waiting on you, on hold and queued, and
// the PRs they are on. It reads only the data layer (src/data). `selectStrip` keeps the same object until a count
// changes, so a lane's every token doesn't redraw the chat.
import { selectProjectWork, type ProjectWork } from "../../src/data/selectors";
import type { DataState } from "../../src/data/store";
import type { AgentLane, PrRef } from "./contracts";
import { projectKey } from "./lanes";
import { isChecker, isFinal, isWorking } from "./words";

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
}

export const stripOf = (lanes: readonly AgentLane[], prs: readonly PrRef[] = []): Strip => ({
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

/** The hub's clock skew, for elapsed times read against the hub's clock (Status). */
export const selectSkew = (s: DataState): number => s.live.skewMs ?? 0;

const sameStrip = (a: Strip, b: Strip): boolean => JSON.stringify(a) === JSON.stringify(b);

const selectors = new Map<string, (s: DataState) => Strip | undefined>();

/**
 * A project's strip, the same object until its counts change; undefined until the board has loaded (draw nothing,
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
