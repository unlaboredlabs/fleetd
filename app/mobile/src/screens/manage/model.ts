// What a project's screens show and offer, from the hub's answers: pure, so the tests pin them. The hub checks every
// call; these say in the desktop's words what a delete does.
import { deleteWords as eraseWords, tilde, type AgentRow, type OrderCard, type PrRow, type ProfilesListOutput, type ProjectSettings, type ProjectSummary, type TodoItem } from "../../desktop";
import type { Machine } from "../../store";

/** A machine's name, else its id. */
export const machineName = (machines: readonly Machine[], machineId: string): string => machines.find((m) => m.machineId === machineId)?.name ?? machineId;

/** The line under its name on its screen. */
export const subtitle = (p: ProjectSummary, machine: string): string => {
  const repos = p.repos?.length ?? 0;
  return repos > 1 ? `${String(repos)} repos on ${machine}` : `Bot on ${machine}`;
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
const MERGES_SHOWN = 5;

/** Merged in the last this many days: what pr_list is asked for. */
export const MERGES_DAYS = 14;

/** Its newest merges, newest first. */
export const merges = (prs: readonly PrRow[]): PrRow[] =>
  prs
    .filter((p) => p.state === "merged")
    .sort((a, b) => (b.mergedAt ?? b.updatedAt).localeCompare(a.mergedAt ?? a.updatedAt))
    .slice(0, MERGES_SHOWN);

/** How many checklist items its screen lists; the rest are counted. */
const CHECKLIST_SHOWN = 8;

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
  /** Its worktrees with uncommitted changes, which the delete loses: each named. */
  readonly unsaved: readonly string[];
  /**
   * The tickbox that deletes its folder too, off by default, and its note: the desktop's label, its folder on a line of
   * its own under it, as a phone's row is too narrow for both.
   */
  readonly folder: { readonly label: string; readonly path: string; readonly note: string };
}

/**
 * The delete's confirm, the same for every project and in the desktop's own words (`deleteWords`): everything fleetd
 * keeps for it is erased, its folder too when ticked. Uncommitted changes it would lose are named apart (`unsaved`); the
 * confirm always asks for its name.
 */
export const deleteWords = (p: ProjectSummary, settings: ProjectSettings, machine: string): DeleteWords => {
  const unsaved = (settings.worktrees?.worktrees ?? []).filter((w) => w.uncommitted).map((w) => w.branch ?? tilde(w.path));
  const path = tilde(settings.workspaceRoot);
  const words = eraseWords(p.title, machine, path);
  const label = words.folder.endsWith(`, ${path}`) ? words.folder.slice(0, -(path.length + 2)) : words.folder;
  return { title: `Delete ${p.title}?`, message: words.message, button: "Delete Bot", unsaved, folder: { label, path, note: words.folderNote } };
};

/** A delete is confirmed by typing its name, as on the desktop: exactly, around spaces. */
export const deleteConfirmed = (typed: string, title: string): boolean => typed.trim() === title.trim() && title.trim() !== "";

/** Why a delete can't be asked now: its machine has to list its worktrees first, so no uncommitted work goes unseen. */
export const deleteBlocked = (settings: ProjectSettings): string | undefined =>
  settings.worktrees === undefined ? `Its worktrees can't be listed now: ${settings.worktreesUnknown ?? "its machine hasn't listed them."} Delete once they can.` : undefined;

/** New Bot's line while the hub link is down: Create stays pressable and says this rather than going grey. */
export const NOT_CONNECTED = "Not connected to the hub. Create works once it's back.";

/** What New Bot still says once the link is `live` again: not that it is down. */
export const refusalNow = (refused: string | undefined, live: boolean): string | undefined => (live && refused === NOT_CONNECTED ? undefined : refused);

/**
 * Why New Bot's Create can't go now, first reason first; undefined when it can. `typed` is the add field's text as
 * typedRepo reads it, `typedBot` the bot a typed folder already is, `block` why its machine can't take it, `named` the
 * name it would get.
 */
export const createRefusal = (o: {
  live: boolean;
  typed: { readonly why: string } | { readonly repo: unknown } | null;
  typedBot: { readonly title: string; readonly workspaceRoot: string } | undefined;
  block: string | undefined;
  named: string;
}): string | undefined => {
  if (!o.live) return NOT_CONNECTED;
  if (o.typed !== null && "why" in o.typed) return o.typed.why;
  if (o.typedBot !== undefined) return `${tilde(o.typedBot.workspaceRoot)} is already the bot ${o.typedBot.title}: open it from Chats.`;
  return o.block ?? (o.named === "" ? "Name it, or add a repo." : undefined);
};
