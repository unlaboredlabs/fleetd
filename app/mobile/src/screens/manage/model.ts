// What a project's and a Navi's screens show and offer, from the hub's answers: pure, so the tests pin them. The hub
// checks every call (a member operates, a Navi is its owner's alone); these only leave out what it would refuse, and
// say in the desktop's words what a delete does.
import { foundRows, isNavi, isYours, tilde, type AgentRow, type Discovery, type Found, type OrderCard, type PrRow, type ProfilesListOutput, type ProjectSettings, type ProjectSummary, type TodoItem } from "../../desktop";
import type { Machine } from "../../store";

/** What the person may do to it from the phone. */
export interface Allowed {
  readonly rename: boolean;
  /** Which profiles its agents may run on: a project's, never a Navi's (its lead runs on the hub's default). */
  readonly profiles: boolean;
  readonly forgetSignins: boolean;
  readonly delete: boolean;
}

/**
 * A project: anyone who operates its machine, as the desktop's Settings › Projects. A Navi: only the person it belongs
 * to (D215); one with no owner, on a hub before people, is everyone's.
 */
export const allowed = (p: ProjectSummary, me: string | undefined): Allowed => {
  if (!isNavi(p)) return { rename: true, profiles: true, forgetSignins: false, delete: true };
  const own = isYours(p, me);
  return { rename: own, profiles: false, forgetSignins: own, delete: own };
};

/** A machine's name, else its id. */
export const machineName = (machines: readonly Machine[], machineId: string): string => machines.find((m) => m.machineId === machineId)?.name ?? machineId;

/** The line under its name on its screen. */
export const subtitle = (p: ProjectSummary, machine: string): string => {
  if (isNavi(p)) return `Navi on ${machine}`;
  const repos = p.repos?.length ?? 0;
  return repos > 1 ? `${String(repos)} repos on ${machine}` : `Project on ${machine}`;
};

const ROLE: Record<AgentRow["role"], string> = { lead: "Lead", implementer: "Writer", reader: "Reader", reviewer: "Reviewer", verifier: "Verifier", qa: "QA" };

const STATUS: Record<AgentRow["status"], string> = {
  queued: "Queued",
  starting: "Starting",
  working: "Working",
  stalled: "Stalled",
  idle: "Idle",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  waiting: "Waiting for you",
  parked: "Paused at the usage limit",
};

const ENDED = new Set<AgentRow["status"]>(["done", "failed", "cancelled"]);

export type Tone = "accent" | "warning" | "danger" | "quiet";

export interface AgentLine {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly status: string;
  readonly tone: Tone;
}

const statusTone = (s: AgentRow["status"]): Tone => (s === "working" || s === "starting" ? "accent" : s === "waiting" || s === "stalled" || s === "parked" ? "warning" : s === "failed" ? "danger" : "quiet");

/** What runs now, the lead first, then the rest as the hub lists them; ended ones are left out. */
export const agentLines = (agents: readonly AgentRow[]): AgentLine[] =>
  agents
    .filter((a) => !ENDED.has(a.status))
    .sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead"))
    .map((a) => ({
      id: a.laneId,
      title: a.role === "lead" ? "Lead" : a.title,
      role: a.role === "lead" ? (a.profile ?? "") : [ROLE[a.role], a.profile].filter((x) => x !== undefined && x !== "").join(" · "),
      status: a.statusReason !== undefined && a.status !== "working" ? `${STATUS[a.status]}: ${a.statusReason}` : STATUS[a.status],
      tone: statusTone(a.status),
    }));

const PHASE: Record<OrderCard["phase"], string> = {
  waiting_on_you: "Needs you",
  working: "Working",
  reviewing: "In review",
  merging: "Merging",
  queued: "Queued",
  planning: "Planning",
  idle: "Idle",
  done: "Done",
  stopped: "Stopped",
};

export interface OrderLine {
  readonly id: string;
  readonly title: string;
  readonly phase: string;
  /** "2 of 3 steps": the board's settled of total, once it has more than one. */
  readonly progress?: string;
  readonly tone: Tone;
}

/** Its open orders, what needs you first, then the newest. */
export const orderLines = (orders: readonly OrderCard[]): OrderLine[] =>
  orders
    .filter((o) => o.state === "open")
    .sort((a, b) => Number(b.phase === "waiting_on_you") - Number(a.phase === "waiting_on_you") || b.updatedAt.localeCompare(a.updatedAt))
    .map((o) => ({
      id: o.workstreamId,
      title: o.title,
      phase: o.phaseDetail ?? PHASE[o.phase],
      ...(o.total > 1 ? { progress: `${String(o.settled)} of ${String(o.total)}` } : {}),
      tone: o.phase === "waiting_on_you" ? "warning" : o.phase === "idle" || o.phase === "queued" ? "quiet" : "accent",
    }));

/** How many recent merges its screen lists. */
export const MERGES_SHOWN = 5;

/** Merged in the last this many days: what pr_list is asked for. */
export const MERGES_DAYS = 14;

/** Its newest merges, newest first. */
export const merges = (prs: readonly PrRow[]): PrRow[] =>
  prs
    .filter((p) => p.state === "merged")
    .sort((a, b) => (b.mergedAt ?? b.updatedAt).localeCompare(a.mergedAt ?? a.updatedAt))
    .slice(0, MERGES_SHOWN);

/** How many checklist items its screen lists; the rest are counted. */
export const CHECKLIST_SHOWN = 8;

export interface Checklist {
  /** What's being done first, then what's to do, then what's done. */
  readonly items: readonly TodoItem[];
  /** "3 of 7 done", or undefined for an empty one. */
  readonly summary?: string;
  /** Left out past CHECKLIST_SHOWN. */
  readonly more: number;
}

const ORDER: Record<TodoItem["state"], number> = { doing: 0, todo: 1, done: 2 };

export const checklist = (items: readonly TodoItem[]): Checklist => {
  const sorted = [...items].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.id - b.id);
  const done = items.filter((i) => i.state === "done").length;
  return {
    items: sorted.slice(0, CHECKLIST_SHOWN),
    ...(items.length === 0 ? {} : { summary: `${String(done)} of ${String(items.length)} done` }),
    more: Math.max(0, sorted.length - CHECKLIST_SHOWN),
  };
};

export interface ProfileLine {
  readonly name: string;
  readonly note: string;
  readonly checked: boolean;
  /** The hub's default: always allowed, so it can't be unchecked. */
  readonly fixed: boolean;
}

/** Each of the hub's profiles, checked for each its agents may run on. */
export const profileLines = (view: ProfilesListOutput): ProfileLine[] => {
  const allowedNames = view.allowed ?? [];
  return view.profiles.map((p) => ({ name: p.name, note: p.default ? `Always allowed.${p.note === "" ? "" : ` ${p.note}`}` : p.note, checked: p.default || allowedNames.includes(p.name), fixed: p.default }));
};

/** The value on its Agent Profiles row: the allowed ones by name, or how many. */
export const profilesValue = (view: ProfilesListOutput): string => {
  const on = profileLines(view).filter((p) => p.checked);
  return on.length <= 2 ? on.map((p) => p.name).join(", ") : `${String(on.length)} allowed`;
};

export interface DeleteWords {
  readonly title: string;
  readonly message: string;
  readonly button: string;
}

/**
 * The delete's confirm, as the desktop's: a Navi or a plain folder keeps its folder; a repo's checkout, branches and
 * pull requests stay while its fleetd worktrees go (any with uncommitted changes named); the other repos a project
 * holds go from fleetd with it (#803), their checkouts staying on the machine.
 */
export const deleteWords = (p: ProjectSummary, settings: ProjectSettings, machine: string): DeleteWords => {
  const navi = isNavi(p);
  const own = (r: NonNullable<ProjectSummary["repos"]>[number]) => r.checkout.machineId === p.machineId && r.checkout.projectId === p.projectId;
  const plain = navi || !(p.repos ?? []).some(own);
  const others = (p.repos ?? []).filter((r) => !own(r)).map((r) => r.name);
  const unsaved = (settings.worktrees?.worktrees ?? []).filter((w) => w.uncommitted).map((w) => w.branch ?? tilde(w.path));
  const path = tilde(settings.workspaceRoot);
  const lines = [
    navi
      ? `Its lead stops and fleetd forgets it, with its sign-ins. Its folder at ${path} on ${machine} stays, with everything in it.`
      : plain
        ? `Its agents stop now and fleetd forgets it and its settings. Its folder at ${path} on ${machine} stays as it is.`
        : `Its agents stop now, fleetd forgets it and its settings, and the worktrees its agents worked in are removed. Its checkout at ${path}, its branches and its pull requests stay.`,
  ];
  if (others.length > 0) lines.push(`Its other ${others.length === 1 ? "repo" : "repos"}, ${others.join(", ")}, ${others.length === 1 ? "goes" : "go"} from fleetd with it; ${others.length === 1 ? "its checkout stays" : "their checkouts stay"} on ${machine}.`);
  if (unsaved.length > 0) lines.push(`Uncommitted changes are lost in ${unsaved.join(", ")}.`);
  return { title: `Delete ${p.title}?`, message: lines.join("\n\n"), button: navi ? "Delete Navi" : "Delete Project" };
};

/** Why a delete can't be asked now: its machine has to list its worktrees first, so no uncommitted work goes unseen. */
export const deleteBlocked = (settings: ProjectSettings): string | undefined =>
  settings.worktrees === undefined ? `Its worktrees can't be listed now: ${settings.worktreesUnknown ?? "its machine hasn't listed them."} Delete once they can.` : undefined;

/** How many suggestions New Project lists under the field. */
export const SUGGESTIONS_SHOWN = 12;

/** What New Project suggests for what is typed: checkouts on the machines and the person's GitHub repos, best first. */
export const suggestions = (text: string, d: Discovery | null): Found[] => {
  if (d === null) return [];
  const out: Found[] = [];
  for (const row of foundRows(text, d.found).rows) {
    if (row.kind !== "found") continue;
    const f = d.found[row.index];
    if (f !== undefined) out.push(f);
    if (out.length === SUGGESTIONS_SHOWN) break;
  }
  return out;
};

/** The longest project name the desktop's box takes. */
export const PROJECT_NAME_MAX = 200;

/** Why a project's name won't do, in a few words; undefined when it will. */
export const projectNameProblem = (name: string): string | undefined => {
  if (/[\r\n]/u.test(name)) return "One line";
  if (name.trim().length > PROJECT_NAME_MAX) return `Keep it under ${String(PROJECT_NAME_MAX)} characters`;
  return undefined;
};
