// The panel's tabs, in the order its tab bar shows them: the one list the bar, the routes (`/<tab>` after a project),
// the palette's Go to commands and the remembered tab all read. A new tab is one entry here: its words, its icon, its
// pane and, if it has one, its count, each loaded the first time the panel shows it. Agents, Browser sessions and Pull
// requests also name an item in their routes (one agent's work, one session, one PR); every other tab's view is
// `{ tab }`.
import { Activity, AppWindow, Bot, GitPullRequest, ListChecks, Scale, TrainFront, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { PanelView, ProjectKey } from "../shell/routes";

export interface PaneProps {
  readonly project: ProjectKey;
  readonly view: PanelView;
  /** Asks the frame for its wide width (a PR's changes) or its own again. */
  readonly onWide: (wide: boolean) => void;
}

/** A tab's badge: renders null until it knows a number worth showing. */
export interface CountProps {
  readonly project: ProjectKey;
  /** Its tab is on view, so a count may read what only its pane would. */
  readonly active: boolean;
}

export interface PanelTabEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The palette's line under its Go to command. */
  readonly detail: string;
  readonly keywords: readonly string[];
  /** Back's words above one of its items, for a tab whose route names items. */
  readonly back?: string;
  readonly pane: () => Promise<ComponentType<PaneProps>>;
  readonly count?: () => Promise<ComponentType<CountProps>>;
  /** The hub feature it needs (its ready frame's `features`): a hub that doesn't serve it shows no such tab. */
  readonly feature?: string;
}

export const PANEL_TABS = [
  {
    id: "agents",
    label: "Agents",
    icon: Bot,
    detail: "This project’s agents at work",
    keywords: ["live", "work", "running"],
    back: "All agents",
    pane: () => import("./panes").then((m) => m.AgentsTab),
    count: () => import("./panes").then((m) => m.AgentCount),
  },
  {
    id: "sessions",
    label: "Browser sessions",
    icon: AppWindow,
    detail: "The browsers this project’s agents use: watch live, take over, replay",
    keywords: ["browser", "session", "chrome", "takeover", "take over", "replay", "recording", "web"],
    back: "All sessions",
    pane: () => import("./panes").then((m) => m.SessionsTab),
    count: () => import("./panes").then((m) => m.SessionCount),
    feature: "browser_sessions",
  },
  {
    id: "prs",
    label: "Pull requests",
    icon: GitPullRequest,
    detail: "This project’s PRs: checks, reviews and changes",
    keywords: ["pr", "prs", "pull", "diff", "changes", "review"],
    back: "All pull requests",
    pane: () => import("./panes").then((m) => m.PrsTab),
    count: () => import("./panes").then((m) => m.PrCount),
  },
  {
    id: "train",
    label: "Train",
    icon: TrainFront,
    detail: "This project’s merge train: what merges now, what waits, what landed",
    keywords: ["merge", "queue", "merging", "ci", "batch", "landed"],
    pane: () => import("../train/TrainPane").then((m) => m.TrainPane),
    count: () => import("../train/TrainPane").then((m) => m.TrainCount),
  },
  {
    id: "checklist",
    label: "Checklist",
    icon: ListChecks,
    detail: "The lead’s to-do list for this project",
    keywords: ["todo", "to-do", "tasks", "progress", "plan", "list"],
    pane: () => import("../checklist/ChecklistPane").then((m) => m.ChecklistPane),
    count: () => import("../checklist/ChecklistPane").then((m) => m.ChecklistCount),
  },
  {
    id: "activity",
    label: "Activity",
    icon: Activity,
    detail: "What happened in this project while you were away",
    keywords: ["events", "feed", "history", "log", "recent", "away"],
    pane: () => import("../activity").then((m) => m.ActivityPane),
    count: () => import("./counts").then((m) => m.ActivityCount),
  },
  {
    id: "decisions",
    label: "Decisions",
    icon: Scale,
    detail: "What the lead and you decided in this project",
    keywords: ["decided", "choices", "settled", "why", "revoke"],
    pane: () => import("../decisions/DecisionsPane").then((m) => m.DecisionsPane),
    count: () => import("./counts").then((m) => m.DecisionCount),
  },
] as const satisfies readonly PanelTabEntry[];

export type PanelTab = (typeof PANEL_TABS)[number]["id"];

export const isPanelTab = (value: unknown): value is PanelTab => PANEL_TABS.some((t) => t.id === value);

export const tabEntry = (id: PanelTab): PanelTabEntry => PANEL_TABS.find((t) => t.id === id) ?? PANEL_TABS[0];

/** Whether the hub serves `id`: a tab that needs no feature always, one that does once the hub says it has it. */
export const served = (id: PanelTab, features: readonly string[]): boolean => {
  const feature = tabEntry(id).feature;
  return feature === undefined || features.includes(feature);
};
