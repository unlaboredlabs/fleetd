// "What <x> was told" (order-view brief A): the exact first message a session was sent, which prompt texts it
// pinned, grouped under the registry's own titles and groups, with every all-default prompt folded into one line
// and only the overrides spelled out; the hashes stay behind hover and copy.

import type { PromptGroup, PromptScope, PromptSummary, SessionPrompt } from "../../../shared/contracts";
import { ROLE_WORD, type AgentRole } from "../../ui";

export interface ToldRow {
  readonly id: string;
  readonly title: string;
  readonly scope: PromptScope;
  /** "your edit for this project". */
  readonly level: string;
  /** `<id>@<hash>`: for the hover and the copy. */
  readonly ref: string;
}

export interface ToldGroup {
  readonly group: string;
  readonly label: string;
  readonly rows: readonly ToldRow[];
}

export interface ToldTool {
  readonly label: string;
  readonly why: string;
  /** claude's own tool names, for the tooltip. */
  readonly names: readonly string[];
}

export interface ToldView {
  /** "cliproxyapi-console · W1 Share card · writer T1". */
  readonly context: string;
  readonly total: number;
  /** Every pinned prompt at fleetd's default, grouped; shown folded as one line. */
  readonly defaults: readonly ToldGroup[];
  readonly defaultCount: number;
  /** The ones a person changed (or the instructions), grouped and shown open. */
  readonly overrides: readonly ToldGroup[];
  readonly tools: readonly ToldTool[];
}

const INSTRUCTIONS = "instructions";

const GROUP_LABELS: Readonly<Record<PromptGroup, string>> = {
  lead: "Lead",
  tasks: "Tasks",
  reviews_and_checks: "Reviews and checks",
  messages: "Messages",
  one_shots: "One-shots",
  instructions: "Your instructions",
};
const GROUP_ORDER = Object.keys(GROUP_LABELS);

/** A group the registry may add later still reads as words. */
const groupLabel = (g: string): string =>
  g in GROUP_LABELS ? GROUP_LABELS[g as PromptGroup] : g.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** For a prompt the list didn't return (an older hub): its group from the id's first word. */
function groupFromId(id: string): PromptGroup {
  const head = id.split(".")[0] ?? "";
  if (id === INSTRUCTIONS) return "instructions";
  if (head === "lead") return "lead";
  if (head === "task") return "tasks";
  if (head === "review" || head === "judge") return "reviews_and_checks";
  if (head === "router" || head === "retro" || head === "status") return "one_shots";
  return "messages";
}

/** "wake.task_result" → "Wake: task result", for a prompt with no registry title. */
function titleFromId(id: string): string {
  const [head = "", ...rest] = id.split(".");
  const words = (s: string) => s.replace(/[_-]+/g, " ");
  const first = words(head).replace(/^./, (c) => c.toUpperCase());
  return rest.length === 0 ? first : `${first}: ${rest.map(words).join(" ")}`;
}

export function level(id: string, scope: PromptScope): string {
  if (id === INSTRUCTIONS) return scope === "project" ? "your instructions for this project" : "your instructions for every project";
  if (scope === "default") return "fleetd's default";
  return scope === "global" ? "your hub-wide edit" : "your edit for this project";
}

function grouped(rows: ReadonlyArray<ToldRow & { readonly group: string }>): ToldGroup[] {
  const by = new Map<string, ToldRow[]>();
  for (const { group, ...row } of rows) {
    const list = by.get(group) ?? [];
    list.push(row);
    by.set(group, list);
  }
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...by.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([group, list]) => ({ group, label: groupLabel(group), rows: list }));
}

// Tools fleetd keeps from every session (node/runner/claude/mod.rs ALWAYS_DISALLOWED), in words, with the reason.
const TOOL_WHY: ReadonlyArray<{ readonly label: string; readonly why: string; readonly names: readonly string[] }> = [
  {
    label: "Subagents and workflows",
    why: "fleetd runs every agent itself, under its slots, so fan-out stays visible and counted.",
    names: ["Task", "Workflow"],
  },
  {
    label: "Asking at the terminal",
    why: "Nobody sits at an agent's terminal; it asks the lead, and the lead asks you in the chat.",
    names: ["AskUserQuestion"],
  },
  {
    label: "Plan mode",
    why: "Nobody approves a plan at the terminal, so a run would stall there; plans go through the lead.",
    names: ["EnterPlanMode", "ExitPlanMode"],
  },
  {
    label: "Scheduling",
    why: "fleetd schedules the work (tasks, wakes); one claude process may be stopped or restarted at any time.",
    names: ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"],
  },
  {
    label: "Worktrees",
    why: "fleetd owns the worktrees, one per writer; a session that moves its own folder can't be resumed.",
    names: ["EnterWorktree", "ExitWorktree"],
  },
];

export function toolsInWords(disallowed: readonly string[]): ToldTool[] {
  const known = new Set(TOOL_WHY.flatMap((t) => t.names));
  const out: ToldTool[] = [];
  for (const t of TOOL_WHY) {
    const names = t.names.filter((n) => disallowed.includes(n));
    if (names.length > 0) out.push({ ...t, names });
  }
  const rest = disallowed.filter((n) => !known.has(n));
  if (rest.length > 0) out.push({ label: "Kept from this project", why: "This project's policy turns these off.", names: rest });
  return out;
}

export interface ToldWho {
  readonly project: string;
  /** "W1". */
  readonly orderId?: string;
  readonly orderTitle?: string;
  /** "the lead" or "writer T1". */
  readonly role: string;
}

export function toldView(sp: SessionPrompt, registry: readonly PromptSummary[], who: ToldWho): ToldView {
  const byId = new Map(registry.map((p) => [p.id, p]));
  const rows = sp.refs.map((r) => {
    const p = byId.get(r.id);
    return {
      id: r.id,
      title: p?.title ?? titleFromId(r.id),
      group: p?.group ?? groupFromId(r.id),
      scope: r.scope,
      level: level(r.id, r.scope),
      ref: r.ref,
    };
  });
  const overridden = (r: (typeof rows)[number]) => r.scope !== "default" || r.id === INSTRUCTIONS;
  const order = [who.orderId, who.orderTitle].filter(Boolean).join(" ");
  return {
    context: [who.project, order, who.role].filter((s) => s !== "").join(" · "),
    total: rows.length,
    defaults: grouped(rows.filter((r) => !overridden(r))),
    defaultCount: rows.filter((r) => !overridden(r)).length,
    overrides: grouped(rows.filter(overridden)),
    tools: toolsInWords(sp.disallowedTools),
  };
}

/** "the writer", "the reviewer", "the lead": the role's one name, never its task number. */
export function roleWords(role: AgentRole): string {
  return `the ${ROLE_WORD[role]}`;
}
