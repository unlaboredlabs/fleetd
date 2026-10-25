// What the panel's agents show, as plain view data: one project's agents under the orders they work on, the
// headline, each agent's state and where its work is, one line per step of an agent's work, and the work elsewhere
// on the project's repo. Pure, so it is unit-tested.
import type { AgentRow, ChangeState, ClaimOwner, LaneStatus, RecentLanding, WorkItem, WorkListOutput, WorkStep } from "../../../shared/contracts";
import type { LiveAgent } from "../../src/data/selectors";
import { projectKey, type ProjectKey } from "../../src/data/store";
import { parseMs } from "../live/format";
import { agoText } from "../projects/machineText";

/** A line above agents: a project's name (All projects), or the order they work on. */
export interface GroupLine {
  /** Unique in the list: "project:<key>" or "order:<key>/<workstream>". */
  readonly group: string;
  readonly title: string;
  readonly level: "project" | "order";
  /** Its agents, and how many of them wait on you. */
  readonly count: number;
  readonly waiting: number;
}

/** An order's title by its workstream id; undefined when the board doesn't hold it. */
export type OrderTitle = (workstreamId: string) => string | undefined;

const noTitles: OrderTitle = () => undefined;

const waits = (a: LiveAgent): boolean => a.row.status === "waiting";

/** Those waiting on you first, then as given: a row moves only when it starts or stops needing you. */
const waitingFirst = <T extends { readonly agents: readonly LiveAgent[] }>(groups: readonly T[]): readonly T[] => [
  ...groups.filter((g) => g.agents.some(waits)),
  ...groups.filter((g) => !g.agents.some(waits)),
];

/** One project's agents, in the data layer's order (oldest first). Not the lead: its chat is beside them. */
const mineOf = (agents: readonly LiveAgent[], project: string): readonly LiveAgent[] => agents.filter((a) => a.project === project && a.row.role !== "lead");

/**
 * One project's agents, those waiting on you first, then the data layer's order (oldest first), so a row moves only
 * when it starts or stops needing you. Not the lead.
 */
export const projectAgents = (agents: readonly LiveAgent[], project: string): readonly LiveAgent[] => {
  const mine = mineOf(agents, project);
  return [...mine.filter(waits), ...mine.filter((a) => !waits(a))];
};

/**
 * One project's agents under the orders they work on, each order under a line with its title: the orders with an
 * agent waiting on you first, then by their oldest agent; in each, as `projectAgents`. An agent of no order the board
 * holds goes under "Other agents".
 */
export const projectGroups = (agents: readonly LiveAgent[], project: string, titleOf: OrderTitle = noTitles): readonly (GroupLine | LiveAgent)[] => {
  const byOrder = new Map<string, LiveAgent[]>();
  for (const a of mineOf(agents, project)) {
    const ws = a.row.workstreamId;
    const id = ws !== undefined && titleOf(ws) !== undefined ? ws : "";
    const group = byOrder.get(id);
    if (group === undefined) byOrder.set(id, [a]);
    else group.push(a);
  }
  const groups = [...byOrder].map(([id, list]) => ({ id, agents: [...list.filter(waits), ...list.filter((a) => !waits(a))] }));
  return waitingFirst(groups).flatMap(({ id, agents: list }) => [
    {
      group: `order:${project}/${id}`,
      title: (id === "" ? undefined : titleOf(id)) ?? "Other agents",
      level: "order" as const,
      count: list.length,
      waiting: list.filter(waits).length,
    },
    ...list,
  ]);
};

/**
 * Every project's agents, each project under a line with its name and in it as `projectGroups`: the projects with an
 * agent waiting on you first, then the data layer's order (by name). Not the leads.
 */
export const allAgents = (agents: readonly LiveAgent[], titleOf: OrderTitle = noTitles): readonly (GroupLine | LiveAgent)[] => {
  const groups = [...new Set(agents.map((a) => a.project))].map((key) => ({ key, agents: mineOf(agents, key) })).filter((g) => g.agents.length > 0);
  return waitingFirst(groups).flatMap(({ key, agents: mine }) => [
    { group: `project:${key}`, title: mine[0]?.row.projectTitle ?? key, level: "project" as const, count: mine.length, waiting: mine.filter(waits).length },
    ...projectGroups(mine, key, titleOf),
  ]);
};

/** What works, what waits on you and what is queued, the leads not counted, so it agrees with the sidebar's count. */
export interface Tally {
  readonly working: number;
  readonly waiting: number;
  readonly queued: number;
}

export const tally = (agents: readonly LiveAgent[]): Tally => {
  let working = 0;
  let waiting = 0;
  let queued = 0;
  for (const { row } of agents) {
    if (row.role === "lead") continue;
    if (row.status === "working" || row.status === "starting") working++;
    else if (row.status === "waiting") waiting++;
    else if (row.status === "queued") queued++;
  }
  return { working, waiting, queued };
};

/** "18 working · 1 needs you · 1 queued"; empty when none of the three. */
export const headline = (agents: readonly LiveAgent[]): string => {
  const { working, waiting, queued } = tally(agents);
  return [working > 0 ? `${String(working)} working` : "", waiting > 0 ? `${String(waiting)} ${waiting === 1 ? "needs" : "need"} you` : "", queued > 0 ? `${String(queued)} queued` : ""]
    .filter((p) => p !== "")
    .join(" · ");
};

/** The five states a row's dot tells apart. Running is the only one that moves. */
export type AgentState = "running" | "queued" | "waiting" | "done" | "failed";

/** Stalled still runs (its line says it stalled); parked and idle wait their turn as queued does; cancelled ended. */
export const agentState = (status: LaneStatus): AgentState => {
  switch (status) {
    case "starting":
    case "working":
    case "stalled":
      return "running";
    case "waiting":
      return "waiting";
    case "done":
    case "cancelled":
      return "done";
    case "failed":
      return "failed";
    case "queued":
    case "parked":
    case "idle":
      return "queued";
  }
};

/** Each status in one word, beside the dot in an agent's head. */
export const STATE_WORD: Readonly<Record<LaneStatus, string>> = {
  queued: "queued",
  starting: "starting",
  working: "running",
  stalled: "stalled",
  idle: "idle",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  waiting: "needs you",
  parked: "paused",
};

/** Where an agent's work is: its PR and the train's word for it, or else its branch. */
export interface WorkPlace {
  readonly kind: "pr" | "branch";
  readonly text: string;
  readonly state?: string | undefined;
  readonly tone: "quiet" | "danger" | "success";
}

const PR_WORD: Readonly<Record<ChangeState, string>> = {
  queued: "queued",
  reviewing: "in review",
  ready: "ready",
  rebasing: "rebasing",
  ci: "in CI",
  merging: "merging",
  merged: "merged",
  needs_rebase: "needs a rebase",
  ci_failed: "CI failed",
  refused: "refused",
  abandoned: "closed",
};

export const workPlace = (row: Pick<AgentRow, "pr" | "branch">): WorkPlace | undefined => {
  const { pr, branch } = row;
  if (pr !== undefined) {
    const tone = pr.state === "ci_failed" || pr.state === "refused" ? "danger" : pr.state === "merged" ? "success" : "quiet";
    return { kind: "pr", text: `#${String(pr.number)}`, state: PR_WORD[pr.state], tone };
  }
  if (branch !== undefined && branch !== "") return { kind: "branch", text: branch, tone: "quiet" };
  return undefined;
};

export interface StepLine {
  readonly words: string;
  /** The command, path or tool, set in mono. */
  readonly machine: string;
  readonly tone: "quiet" | "danger";
  /** After the machine text: "failed", "exit 1". */
  readonly outcome?: string | undefined;
}

const VERB: Readonly<Record<string, readonly [running: string, done: string]>> = {
  command: ["running", "ran"],
  file_change: ["editing", "edited"],
  tool_call: ["using", "used"],
};

/** One action as a quiet line in the past tense ("ran npm test"), or the present while it runs. */
export const actionLine = (step: Extract<WorkStep, { kind: "action" }>): StepLine => {
  const { action } = step;
  const [running, done] = VERB[action.kind] ?? ["", ""];
  const words = action.status === "running" ? running : done;
  if (!action.failed) return { words, machine: action.summary, tone: "quiet" };
  return { words, machine: action.summary, tone: "danger", outcome: action.exitCode === undefined ? "failed" : `failed, exit ${String(action.exitCode)}` };
};

/**
 * One row of the Elsewhere group: work on the project's repo and base that isn't its own agents'. `tag` stands where
 * an agent's role does; `meta` says who holds it and until when, whose it is, or how it landed.
 */
export interface ElsewhereRow {
  readonly id: string;
  readonly tag: string;
  readonly title: string;
  readonly meta: string;
  /** An expired claim: shown dimmed, last. */
  readonly dim: boolean;
  /** A landing's commit, behind a copy control. */
  readonly sha?: string | undefined;
}

const CHANGE_WORD: Readonly<Record<string, string>> = {
  queued: "queued for the merge train",
  reviewing: "in review",
  ready: "ready to merge",
  rebasing: "rebasing",
  ci: "in CI",
  merging: "merging",
  needs_rebase: "needs a rebase",
  ci_failed: "CI failed",
  refused: "refused",
};

/** "40 min", "9 h", "2 days": a span to come, at least a minute. */
const spanText = (ms: number): string => {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  if (m < 60) return `${String(m)} min`;
  if (m < 2880) return `${String(Math.floor(m / 60))} h`;
  return `${String(Math.floor(m / 1440))} days`;
};

const isExpired = (item: WorkItem): boolean => item.kind === "claim" && item.state === "expired";

/** The project's own work, as the lead's digest leaves it out: its writers and PRs, and the claims its lead holds. */
const isOwn = (item: WorkItem, project: ProjectKey): boolean =>
  item.kind === "claim" ? item.owner?.kind === "lead" && item.owner.keyId === project : item.projectRef !== undefined && projectKey(item.projectRef) === project;

/** Who holds a claim: "you (laptop)", "agent key ci-bot", "checkout's lead". */
const holder = (owner: ClaimOwner | undefined, titleOf: (key: ProjectKey) => string | undefined): string => {
  if (owner === undefined) return "someone";
  const label = owner.label === undefined ? "" : ` (${owner.label})`;
  if (owner.kind === "human_session") return `you${label}`;
  if (owner.kind === "lead") return `${titleOf(owner.keyId) ?? owner.keyId}’s lead`;
  return `agent key ${owner.label ?? owner.keyId}`;
};

const claimRow = (item: WorkItem, nowMs: number, titleOf: (key: ProjectKey) => string | undefined): ElsewhereRow => {
  const expired = isExpired(item);
  const until = parseMs(item.expiresAt);
  const when = until === undefined ? "" : expired ? ` · expired ${agoText(nowMs - until)}` : until <= nowMs ? " · expiring now" : ` · expires in ${spanText(until - nowMs)}`;
  const tag = expired ? "Expired" : item.owner?.kind === "human_session" ? "You" : "Claim";
  return { id: item.id, tag, title: item.title, meta: `held by ${holder(item.owner, titleOf)}${when}`, dim: expired };
};

const workRow = (item: WorkItem, titleOf: (key: ProjectKey) => string | undefined): ElsewhereRow => {
  const whose = item.projectRef === undefined ? "another project" : (titleOf(projectKey(item.projectRef)) ?? "another project");
  if (item.kind === "pr") return { id: item.id, tag: "PR", title: item.title, meta: `open PR outside fleetd · ${item.id}`, dim: false };
  if (item.kind === "change") return { id: item.id, tag: "PR", title: item.title, meta: `${whose}’s PR · ${CHANGE_WORD[item.state] ?? item.state}`, dim: false };
  return { id: item.id, tag: "Agent", title: item.title, meta: `${whose}’s agent · ${item.state}`, dim: false };
};

/** When the soonest active claim shown expires, so the group is read again then: a renewal moves it later. */
export const nextExpiry = (out: WorkListAnswer, nowMs: number): number | undefined => {
  const at = out.items.flatMap((i) => (i.kind === "claim" && !isExpired(i) ? [parseMs(i.expiresAt)] : [])).filter((ms): ms is number => ms !== undefined && ms > nowMs);
  return at.length === 0 ? undefined : Math.min(...at);
};

/** How it landed, for a person: "pushed straight to main", "PR #57 merged outside fleetd". */
export const landedHow = (landing: RecentLanding, base: string): string => {
  if (landing.route === "direct_push") return `pushed straight to ${base}`;
  if (landing.route === "pr_outside") return landing.pr === undefined ? "merged outside fleetd" : `PR ${landing.pr} merged outside fleetd`;
  return "merged by the train";
};

const landingRow = (landing: RecentLanding, base: string, nowMs: number): ElsewhereRow => {
  const by = landing.authorEmail === undefined ? "" : ` by ${landing.authorEmail}`;
  const at = parseMs(landing.at);
  const when = at === undefined ? "" : ` · ${agoText(nowMs - at)}`;
  const covers = landing.covers.length === 0 ? "" : ` · covers ${landing.covers.join(", ")}`;
  return {
    id: `landing:${landing.sha}`,
    tag: landing.route === "direct_push" ? "Pushed" : "Merged",
    title: landing.subject === "" ? "A commit with no subject" : landing.subject,
    meta: `${landedHow(landing, base)}${by}${when}${covers}`,
    dim: false,
    sha: landing.sha,
  };
};

/** work_list as any hub answers it: one from before recentLandings sends none, and claims without expiresAt. */
export type WorkListAnswer = Omit<WorkListOutput, "recentLandings"> & { readonly recentLandings?: WorkListOutput["recentLandings"] };

/**
 * The Elsewhere group under a project's agents, from work_list on its repo and base: a person's active claims first,
 * then other claims and other projects' agents and PRs (the hub's order, newest first), then what landed outside the
 * train (newest first), and expired claims last. Not the project's own work.
 */
export const elsewhere = (
  out: WorkListAnswer,
  project: ProjectKey,
  nowMs: number,
  titleOf: (key: ProjectKey) => string | undefined = () => undefined,
): readonly ElsewhereRow[] => {
  const items = out.items.filter((i) => !isOwn(i, project));
  const person = items.filter((i) => i.kind === "claim" && !isExpired(i) && i.owner?.kind === "human_session");
  const others = items.filter((i) => !isExpired(i) && !person.includes(i));
  return [
    ...person.map((i) => claimRow(i, nowMs, titleOf)),
    ...others.map((i) => (i.kind === "claim" ? claimRow(i, nowMs, titleOf) : workRow(i, titleOf))),
    ...(out.recentLandings ?? []).filter((l) => l.route !== "train").map((l) => landingRow(l, out.scope.base, nowMs)),
    ...items.filter(isExpired).map((i) => claimRow(i, nowMs, titleOf)),
  ];
};
