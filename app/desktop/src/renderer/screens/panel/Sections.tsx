// The panel's tabs, in everyday words, and all the navigation it has: Agents (the agents, and under them the screens
// they and you have open); Shipping (what merges now, the line behind it, and the other pull requests); Plan (the
// lead's checklist, and under it the work it asked other projects for); History (what happened, with the decisions a
// row away); and Artifacts (the reports published in its chat, and the files sent in it), which joins the row once the
// project has one of either and the hub serves them, or while it is open. One skill (`skills/<name>`, from a chat line
// or Settings › Agents › Skills, where the list is) opens in the panel with no tab of its own. One compact row: each
// tab its word with its count on the word's baseline, and what it is in its tooltip (hover or keyboard focus), never
// in a line under the row. A tab is one list (ui/DESIGN.md): no tab has tabs of its own. The views are tabs.ts's, each
// with its route; several land in one tab, the first of them its list and the others a place in it. A view the hub
// doesn't serve (tabs.ts `feature`) isn't there: Agents without Sessions has no Screens group, and a tab whose every
// view needs a feature shows once it is served.
import { BookOpen, Bot, FileText, History, ListChecks, Ship, type LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Tab, TabList, Tooltip } from "../../ui";
import { forgetFolds } from "./folds";
import { served, type PaneProps, type PanelTab } from "./tabs";
import s from "./sections.module.css";

export interface Section {
  readonly id: string;
  readonly label: string;
  /** The row's mark when it is too narrow for words. */
  readonly icon: LucideIcon;
  /** What it is, in one line, for someone new: its tooltip. */
  readonly line: string;
  /** Its line when the hub serves only its first view, if that differs. */
  readonly lineAlone?: string;
  /** The views that land in it: the first is its list, the others a place in that list or a row away. */
  readonly views: readonly PanelTab[];
  readonly pane: () => Promise<ComponentType<PaneProps>>;
  /** Off the row unless the panel asks for it (`shownSections`' `extra`): Artifacts, once it has something or is open. */
  readonly tucked?: true;
}

export const SECTIONS: readonly Section[] = [
  {
    id: "agents",
    label: "Agents",
    icon: Bot,
    line: "The AI workers on this project, what each is doing right now, and the screens they use.",
    lineAlone: "The AI workers on this project, and what each is doing right now.",
    views: ["agents", "sessions"],
    pane: () => import("./panes").then((m) => m.AgentsTab),
  },
  {
    id: "shipping",
    label: "Shipping",
    icon: Ship,
    line: "Changes on their way into main: what merges now, the line behind it, and the other pull requests.",
    views: ["prs", "train"],
    pane: () => import("./panes").then((m) => m.ShippingTab),
  },
  {
    id: "plan",
    label: "Plan",
    icon: ListChecks,
    line: "The lead’s to-do list, ticked off as work lands, and the work it asked your other projects for.",
    views: ["checklist", "asked"],
    pane: () => import("./panes").then((m) => m.PlanTab),
  },
  {
    id: "artifacts",
    label: "Artifacts",
    icon: FileText,
    line: "Reports the lead and its agents published here, every version kept, and the files sent in the chat.",
    views: ["artifacts"],
    pane: () => import("./panes").then((m) => m.ArtifactsTab),
    tucked: true,
  },
  {
    id: "history",
    label: "History",
    icon: History,
    line: "What happened here while you were away, and what you and the lead decided.",
    views: ["activity", "decisions"],
    pane: () => import("./panes").then((m) => m.HistoryTab),
  },
];

/** One skill's, which has no tab: its list is in the project's settings. */
export const SKILL: Section = {
  id: "skills",
  label: "Skills",
  icon: BookOpen,
  line: "What the lead has learned to do: see, edit and undo every change.",
  views: ["skills"],
  pane: () => import("./panes").then((m) => m.SkillsTab),
};

const AGENTS = SECTIONS[0] as Section;

/**
 * The tabs the row shows: one whose every view needs a feature, only once it is served; a tucked one only when
 * `extra` names it (the open tab, Artifacts once there is one).
 */
export const shownSections = (features: readonly string[], extra: readonly string[] = []): readonly Section[] =>
  SECTIONS.filter((g) => (g.tucked !== true || extra.includes(g.id)) && g.views.some((tab) => served(tab, features)));

/** The tab a view lands in. */
export const sectionOf = (tab: PanelTab): Section => (tab === "skills" ? SKILL : (SECTIONS.find((g) => g.views.includes(tab)) ?? AGENTS));

/** `section` with only the views the hub serves (always its first), and the line that fits them. */
export const servedSection = (section: Section, features: readonly string[]): Section => {
  const views = section.views.filter((tab, i) => i === 0 || served(tab, features));
  return views.length === section.views.length ? section : { ...section, views, line: views.length === 1 ? (section.lineAlone ?? section.line) : section.line };
};

/** The view a tab opens on: its list. */
export const listOf = (id: string): PanelTab => (SECTIONS.find((g) => g.id === id) ?? AGENTS).views[0] ?? "agents";

/** Forgets what the tabs' lists remember while the app runs, which is what you unfolded in them (tests start clean). */
export const forgetViews = (): void => forgetFolds();

/**
 * The panel's one row of tabs (inside its Tabs, whose value is a tab's id), each tooltip the line for the views the
 * hub serves; `extra` names the tucked ones to show.
 */
export function SectionTabs({ count, features, extra }: { count: (tab: PanelTab) => ReactNode; features: readonly string[]; extra: readonly string[] }) {
  const shown = shownSections(features, extra);
  return (
    // A container can't style itself by its own width: the row carries how many tabs it holds for its rules to read.
    <TabList aria-label="Panel" className={s.bar} data-tabs={shown.length}>
      {shown.map((section) => {
        const g = servedSection(section, features);
        const Icon = g.icon;
        return (
          <Tooltip key={g.id} content={g.line} side="bottom">
            <Tab value={g.id} className={s.section} data-section={g.id} aria-label={g.label}>
              <Icon aria-hidden className={s.icon} />
              <span className={s.words}>
                <span className={s.label} data-label={g.label}>
                  <span>{g.label}</span>
                </span>
                <span className={s.count}>{count(listOf(g.id))}</span>
              </span>
            </Tab>
          </Tooltip>
        );
      })}
    </TabList>
  );
}
