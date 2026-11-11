// The panel's views, each with its route (`/<id>` after a project): the one list the routes, the palette's Go to
// commands and the remembered view all read. The panel's row has fewer tabs than this (Sections.tsx): a tab is one
// list, and several of these land in it, so no tab has tabs of its own. Screens is the Agents tab's Screens group,
// Train the head of Shipping's list, Asked work the foot of Plan's, and Decisions opens from History's first row.
// Agents, Sessions, Pull requests, Skills and Artifacts also name an item in their routes (one agent's work, one
// session, one PR, one skill, one artifact); every other view is `{ tab }`. Skills is only its one skill, with no tab
// or Go to command: the list is in the project's settings.
import { Activity, AppWindow, BookOpen, Bot, FileText, GitPullRequest, ListChecks, Scale, Send, TrainFront, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { PanelView, ProjectKey } from "../shell/routes";

export interface PaneProps {
  readonly project: ProjectKey;
  readonly view: PanelView;
  /** Asks the frame for its wide width (a PR's changes) or its own again. */
  readonly onWide: (wide: boolean) => void;
}

/** A tab's badge, on the row: renders null until it knows a number worth showing. */
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
  /** Back's words above one of its items, for a view whose route names items. A PR and the decisions have their own, on their top line. */
  readonly back?: string;
  readonly count?: () => Promise<ComponentType<CountProps>>;
  /** The hub feature it needs (its ready frame's `features`): a hub that doesn't serve it shows no such tab. */
  readonly feature?: string;
  /** No Go to command in the palette: it opens only on one item. */
  readonly itemOnly?: true;
}

export const PANEL_TABS = [
  {
    id: "agents",
    label: "Agents",
    icon: Bot,
    detail: "This project’s agents at work",
    keywords: ["live", "work", "running"],
    back: "All agents",
    count: () => import("./panes").then((m) => m.AgentCount),
  },
  {
    id: "sessions",
    label: "Screens",
    icon: AppWindow,
    detail: "The browsers and devices this project’s agents use: watch live, take over, replay",
    keywords: ["screen", "browser", "session", "device", "desktop", "chrome", "takeover", "take over", "replay", "recording", "web"],
    back: "All screens",
    feature: "browser_sessions",
  },
  {
    id: "prs",
    label: "Pull requests",
    icon: GitPullRequest,
    detail: "This project’s PRs: checks, reviews and changes",
    keywords: ["pr", "prs", "pull", "diff", "changes", "review"],
    count: () => import("./panes").then((m) => m.PrCount),
  },
  {
    id: "train",
    label: "Train",
    icon: TrainFront,
    detail: "This project’s merge train: what merges now, what waits, what landed",
    keywords: ["merge", "queue", "merging", "ci", "batch", "landed"],
  },
  {
    id: "checklist",
    label: "Checklist",
    icon: ListChecks,
    detail: "The lead’s to-do list for this project",
    keywords: ["todo", "to-do", "tasks", "progress", "plan", "list"],
    count: () => import("../checklist/ChecklistPane").then((m) => m.ChecklistCount),
  },
  {
    id: "artifacts",
    label: "Artifacts",
    icon: FileText,
    detail: "Reports the lead and its agents published in this chat, every version kept",
    keywords: ["report", "reports", "artifact", "document", "page", "html", "markdown", "published", "versions"],
    back: "All artifacts",
    feature: "artifacts",
  },
  {
    id: "activity",
    label: "Activity",
    icon: Activity,
    detail: "What happened in this project while you were away",
    keywords: ["events", "feed", "history", "log", "recent", "away"],
    count: () => import("./counts").then((m) => m.ActivityCount),
  },
  {
    id: "decisions",
    label: "Decisions",
    icon: Scale,
    detail: "What the lead and you decided in this project",
    keywords: ["decided", "choices", "settled", "why", "revoke"],
  },
  {
    id: "asked",
    label: "Asked work",
    icon: Send,
    detail: "The work this project’s lead asked your other projects for, and how each order is going",
    keywords: ["asked", "orders", "requests", "delegated", "factory"],
  },
  {
    id: "skills",
    label: "Skills",
    icon: BookOpen,
    detail: "What this project’s lead has learned to do, with every change: who, when and why",
    keywords: ["skill", "skills", "learned", "how", "workflow", "history", "versions"],
    back: "All skills",
    itemOnly: true,
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
