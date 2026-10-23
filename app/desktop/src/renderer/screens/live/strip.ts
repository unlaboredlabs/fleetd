// The live strip's model, pure: which of a project's agents to show, the header that counts them, and the opened rows
// (one line per PR, then the agents on it). It reads only the data layer (src/data). `selectStrip` keeps the same
// object until a word changes, so a lane's every token doesn't redraw the chat.
import { selectProjectWork, type ProjectWork } from "../../src/data/selectors";
import type { DataState } from "../../src/data/store";
import type { AgentLane } from "./contracts";
import { projectKey } from "./lanes";
import { type Fleet, fleet, groupLabel } from "./fleet";
import { type Tone, ROLE_WORD, describe, isFinal, isWorking, stageTone } from "./words";

export interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

/**
 * The agents the strip shows, grouped under their PRs: every agent of the project's orders, not the lead, not
 * finished, and not idle; at work first, then queued. An idle lane's session has stopped (its task books the result a
 * moment later), so it neither holds a slot nor has anything to show. The finished agents the orders' details list
 * count toward a PR's reviews done.
 */
const projectFleet = (w: ProjectWork): { readonly lanes: AgentLane[]; readonly fleet: Fleet } => {
  const shown = w.lanes.filter((l) => l.role !== "lead" && !isFinal(l.status) && l.status !== "idle");
  const lanes = [...shown.filter((l) => l.status !== "queued"), ...shown.filter((l) => l.status === "queued")];
  const ids = new Set(lanes.map((l) => l.laneId));
  const finished = w.doneLanes.filter((l) => !ids.has(l.laneId));
  return { lanes, fleet: fleet(lanes, [...lanes, ...finished], w.prs) };
};

/** One agent, opened: its role, what it is doing, and since when. */
export interface AgentRow {
  readonly kind: "agent";
  readonly key: string;
  /** The lane without its live values (what "What it was told" needs), so the row is stable while it works. */
  readonly lane: AgentLane;
  readonly roleWord: string;
  /** What it is doing, in plain words ("editing", "thinking", "waiting on you: …"). */
  readonly words: string;
  /** The machine text after the words (a command, a path), when there is one. */
  readonly machine?: string | undefined;
  readonly tone: Tone;
  /** Under a PR's line. */
  readonly indent: boolean;
  readonly startedAt?: string | undefined;
}

/** A PR's one line, above the agents on it: "#221 round in cart/total.ts · review 1/3". */
export interface PrRow {
  readonly kind: "pr";
  readonly key: string;
  readonly number: number;
  readonly url: string;
  /** What it is for: its writer's title, once known. */
  readonly title?: string | undefined;
  readonly label: string;
  readonly tone: Tone;
}

export type StripRow = AgentRow | PrRow;

export interface Strip {
  /** Agents whose session runs, as the max-agents count has them: a slot is held from its grant until the session stops. */
  readonly working: number;
  readonly needsYou: number;
  /** Stopped mid-task: stalled, or paused at a usage limit. */
  readonly onHold: number;
  readonly queued: number;
  /** The PRs the agents work on, as the opened rows group them. */
  readonly prs: readonly number[];
  readonly rows: readonly StripRow[];
  /** The project's orders, whose details the opened strip loads. */
  readonly orders: readonly string[];
  /** The live feed dropped: the words stay, greyed, until the next frame. */
  readonly stale: boolean;
}

const agentRow = (l: AgentLane, indent: boolean): AgentRow => {
  const line = describe(l);
  return {
    kind: "agent",
    key: l.laneId,
    lane: {
      laneId: l.laneId,
      role: l.role,
      title: l.title,
      status: l.status,
      ...(l.taskId === undefined ? {} : { taskId: l.taskId }),
      ...(l.threadRef === undefined ? {} : { threadRef: l.threadRef }),
      ...(l.profile === undefined ? {} : { profile: l.profile }),
    },
    roleWord: ROLE_WORD[l.role],
    words: line.words,
    machine: line.machine,
    tone: line.tone,
    indent,
    startedAt: l.status === "queued" ? undefined : l.startedAt,
  };
};

/**
 * The strip from the agents it shows and their fleet: writers without a PR first, then each PR with the agents on it
 * (its writer first), then the rest.
 */
export const stripOf = (
  lanes: readonly AgentLane[],
  f: Fleet = { writers: lanes, groups: [], others: [] },
  more: { readonly orders?: readonly string[]; readonly stale?: boolean } = {},
): Strip => {
  const on = (g: Fleet["groups"][number]) =>
    lanes.filter((l) => l.laneId === g.writer?.laneId || l.pr?.number === g.pr.number).sort((a, b) => Number(b.laneId === g.writer?.laneId) - Number(a.laneId === g.writer?.laneId));
  const groups = f.groups.map((g) => ({ g, lanes: on(g) })).filter((x) => x.lanes.length > 0);
  const rows: StripRow[] = [
    ...f.writers.map((l) => agentRow(l, false)),
    ...groups.flatMap(({ g, lanes: mine }): StripRow[] => {
      return [
        {
          kind: "pr",
          key: `pr:${g.pr.changeId}`,
          number: g.pr.number,
          url: g.pr.url,
          title: g.writer?.title,
          label: groupLabel(g),
          tone: stageTone(g.pr.state),
        },
        ...mine.map((l) => agentRow(l, true)),
      ];
    }),
    ...f.others.map((l) => agentRow(l, false)),
  ];
  return {
    working: lanes.filter((l) => isWorking(l.status)).length,
    needsYou: lanes.filter((l) => l.status === "waiting").length,
    onHold: lanes.filter((l) => l.status === "stalled" || l.status === "parked").length,
    queued: lanes.filter((l) => l.status === "queued").length,
    prs: groups.map((x) => x.g.pr.number),
    rows,
    orders: more.orders ?? [],
    stale: more.stale ?? false,
  };
};

const count = (n: number, one: string, many: string): string[] => (n > 0 ? [`${n} ${n === 1 ? one : many}`] : []);

/** "3 agents working · 1 needs you · 1 queued"; empty when nothing is shown (the strip then isn't drawn). */
export const stripHeadline = (s: Strip): string =>
  [
    ...count(s.working, "agent working", "agents working"),
    ...count(s.needsYou, "needs you", "need you"),
    ...count(s.onHold, "on hold", "on hold"),
    ...count(s.queued, "queued", "queued"),
  ].join(" · ");

/** The folded header's PRs: "on #221", "on #9, #10 and #11", "on #9, #10, #11 and 2 more". */
export const stripPrs = (prs: readonly number[]): string => {
  if (prs.length === 0) return "";
  const named = prs.slice(0, prs.length > 4 ? 3 : prs.length).map((n) => `#${n}`);
  const rest = prs.length - named.length;
  if (rest > 0) return `on ${named.join(", ")} and ${rest} more`;
  return named.length === 1 ? `on ${named[0] ?? ""}` : `on ${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
};

/** The hub's clock skew, for the opened strip's elapsed times. */
export const selectSkew = (s: DataState): number => s.live.skewMs ?? 0;

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
  const work = selectProjectWork(key);
  selector = (s: DataState) => {
    const w = work(s);
    if (w === undefined) return undefined;
    const { lanes, fleet: f } = projectFleet(w);
    const next = stripOf(lanes, f, { orders: w.orders, stale: s.live.stale });
    if (last !== undefined && sameStrip(last, next)) return last;
    last = next;
    return next;
  };
  selectors.set(key, selector);
  return selector;
};
