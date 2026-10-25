// What the panel's agents show, as plain view data: one project's agents, the headline, one line per step of an
// agent's work, and the work elsewhere on the project's repo. Pure, so it is unit-tested.
import type { ClaimOwner, RecentLanding, WorkItem, WorkListOutput, WorkStep } from "../../../shared/contracts";
import type { LiveAgent } from "../../src/data/selectors";
import { projectKey, type ProjectKey } from "../../src/data/store";
import { parseMs } from "../live/format";
import { agoText } from "../projects/machineText";

/**
 * One project's agents, those waiting on you first, then the data layer's order (oldest first), so a row moves only
 * when it starts or stops needing you. Not the lead: its chat is beside them.
 */
export const projectAgents = (agents: readonly LiveAgent[], project: string): readonly LiveAgent[] => {
  const mine = agents.filter((a) => a.project === project && a.row.role !== "lead");
  return [...mine.filter((a) => a.row.status === "waiting"), ...mine.filter((a) => a.row.status !== "waiting")];
};

/** A project's name above its agents in the All projects list. */
export interface ProjectLine {
  readonly group: string;
  readonly title: string;
}

/**
 * Every project's agents, each project under a line with its name: the projects with an agent waiting on you first,
 * then the data layer's order (by name); in each, as `projectAgents`. Not the leads.
 */
export const allAgents = (agents: readonly LiveAgent[]): readonly (ProjectLine | LiveAgent)[] => {
  const groups = [...new Set(agents.map((a) => a.project))].map((key) => projectAgents(agents, key));
  const waits = (g: readonly LiveAgent[]) => g[0]?.row.status === "waiting";
  return [...groups.filter(waits), ...groups.filter((g) => !waits(g))].flatMap((g) =>
    g[0] === undefined ? [] : [{ group: g[0].project, title: g[0].row.projectTitle }, ...g],
  );
};

/**
 * "18 working · 1 needs you · 1 queued", the leads not counted, so it agrees with the sidebar's count; empty
 * when none of the three.
 */
export const headline = (agents: readonly LiveAgent[]): string => {
  let working = 0;
  let waiting = 0;
  let queued = 0;
  for (const { row } of agents) {
    if (row.role === "lead") continue;
    if (row.status === "working" || row.status === "starting") working++;
    else if (row.status === "waiting") waiting++;
    else if (row.status === "queued") queued++;
  }
  return [working > 0 ? `${String(working)} working` : "", waiting > 0 ? `${String(waiting)} ${waiting === 1 ? "needs" : "need"} you` : "", queued > 0 ? `${String(queued)} queued` : ""]
    .filter((p) => p !== "")
    .join(" · ");
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
 * train (newest first), and expired claims last. Not the project's own work, and not plan items nobody has started.
 */
export const elsewhere = (
  out: WorkListAnswer,
  project: ProjectKey,
  nowMs: number,
  titleOf: (key: ProjectKey) => string | undefined = () => undefined,
): readonly ElsewhereRow[] => {
  const items = out.items.filter((i) => i.kind !== "planned" && !isOwn(i, project));
  const person = items.filter((i) => i.kind === "claim" && !isExpired(i) && i.owner?.kind === "human_session");
  const others = items.filter((i) => !isExpired(i) && !person.includes(i));
  return [
    ...person.map((i) => claimRow(i, nowMs, titleOf)),
    ...others.map((i) => (i.kind === "claim" ? claimRow(i, nowMs, titleOf) : workRow(i, titleOf))),
    ...(out.recentLandings ?? []).filter((l) => l.route !== "train").map((l) => landingRow(l, out.scope.base, nowMs)),
    ...items.filter(isExpired).map((i) => claimRow(i, nowMs, titleOf)),
  ];
};
