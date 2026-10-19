// The live strip's model, pure: which of a project's agents are at work, each as one plain line, and the header that
// counts them. It reads only the data layer (src/data). The collapsed strip draws from `selectStrip`, which keeps the
// same object until a line's words change, so a lane's every token or bar doesn't redraw the chat.
import type { BoardData } from "../../src/data/selectors";
import { selectBoardData } from "../../src/data/selectors";
import type { DataState } from "../../src/data/store";
import type { AgentLane } from "./contracts";
import { projectKey } from "./lanes";
import { type Fleet, fleet, groupLabel } from "./fleet";
import { ROLE_WORD, describe, isFinal } from "./words";

export interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

/** The project's agents: every lane of its orders, live, not the lead; at work first, then queued. */
export const projectAgents = (d: BoardData, project: ProjectRef): AgentLane[] => {
  const key = projectKey(project);
  const lanes = (d.orders ?? []).filter((o) => projectKey(o.card.projectRef) === key).flatMap((o) => o.lanes);
  const alive = lanes.filter((l) => l.role !== "lead" && !isFinal(l.status));
  return [...alive.filter((l) => l.status !== "queued"), ...alive.filter((l) => l.status === "queued")];
};

/**
 * The project's agents grouped under its PRs: the one place both the folded lines and the unfolded lanes take a
 * PR's progress from, so a count never changes when the strip unfolds. The finished agents its orders' details list
 * (order_get) count toward the reviews done.
 */
export const projectFleet = (d: BoardData, project: ProjectRef): { readonly lanes: AgentLane[]; readonly fleet: Fleet } => {
  const key = projectKey(project);
  const orders = (d.orders ?? []).filter((o) => projectKey(o.card.projectRef) === key);
  const lanes = projectAgents(d, project);
  const ids = new Set(lanes.map((l) => l.laneId));
  const finished = orders.flatMap((o) => d.details[o.card.workstreamId]?.doneLanes ?? []).filter((l) => !ids.has(l.laneId));
  return { lanes, fleet: fleet(lanes, [...lanes, ...finished], orders.flatMap((o) => o.card.prs)) };
};

export interface StripLine {
  readonly laneId: string;
  readonly role: AgentLane["role"];
  readonly roleWord: string;
  /** What it is doing, in plain words ("editing", "thinking", "waiting on you: …"). */
  readonly words: string;
  /** The machine text after the words (a command, a path), when there is one. */
  readonly machine?: string | undefined;
  readonly tone: "quiet" | "loud" | "warning" | "danger" | "success";
  /** The PR it works on: its number, link and progress words ("review 1/3"), from the same groups the lanes show. */
  readonly pr?: { readonly number: number; readonly url: string; readonly label: string } | undefined;
}

export interface Strip {
  /** Agents at work (those waiting on you and the queued ones are counted apart). */
  readonly working: number;
  readonly queued: number;
  readonly needsYou: number;
  readonly lines: readonly StripLine[];
}

export const stripOf = (lanes: readonly AgentLane[], groups: Fleet["groups"] = []): Strip => ({
  working: lanes.filter((l) => l.status !== "queued" && l.status !== "waiting").length,
  queued: lanes.filter((l) => l.status === "queued").length,
  needsYou: lanes.filter((l) => l.status === "waiting").length,
  lines: lanes.map((l) => {
    const line = describe(l);
    return {
      laneId: l.laneId,
      role: l.role,
      roleWord: ROLE_WORD[l.role],
      words: line.words,
      machine: line.machine,
      tone: line.tone,
      pr: (() => {
        if (l.pr === undefined) return undefined;
        const n = l.pr.number;
        const group = groups.find((g) => g.pr.number === n);
        return { number: n, url: l.pr.url, label: group ? groupLabel(group) : "" };
      })(),
    };
  }),
});

/** "3 agents working · 1 queued"; empty when nothing runs (the strip then isn't drawn). */
export const stripHeadline = (s: Strip): string => {
  const parts = [
    ...(s.working > 0 ? [`${s.working} ${s.working === 1 ? "agent" : "agents"} working`] : []),
    ...(s.needsYou > 0 ? [`${s.needsYou} ${s.needsYou === 1 ? "needs" : "need"} you`] : []),
    ...(s.queued > 0 ? [`${s.queued} queued`] : []),
  ];
  return parts.join(" · ");
};

const sameStrip = (a: Strip, b: Strip): boolean => JSON.stringify(a) === JSON.stringify(b);

const selectors = new Map<string, (s: DataState) => Strip | undefined>();

/**
 * A project's strip, the same object until its words change; undefined until the board has loaded (draw nothing,
 * never "0 agents"). One selector per project, memoized on its own.
 */
export const selectStrip = (project: ProjectRef): ((s: DataState) => Strip | undefined) => {
  const key = projectKey(project);
  let selector = selectors.get(key);
  if (selector !== undefined) return selector;
  let last: Strip | undefined;
  selector = (s: DataState) => {
    const d = selectBoardData(s);
    if (d.orders === undefined) return undefined;
    const { lanes, fleet: f } = projectFleet(d, project);
    const next = stripOf(lanes, f.groups);
    if (last !== undefined && sameStrip(last, next)) return last;
    last = next;
    return next;
  };
  selectors.set(key, selector);
  return selector;
};

/** How many lines the strip shows folded; the rest are "+N more", which unfolds it. */
export const FOLDED_LINES = 5;
