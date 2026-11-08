// The panel's sections, in everyday words: Agents (the agents, and the browsers they use); Shipping (its pull requests,
// and the merge line they land in); Plan (the lead's checklist, and the work it asked other projects for); History (what
// happened, and what was decided); and Artifacts (the reports published in its chat, and the files sent in it), which
// joins the row once the project has one of either and the hub serves them, or while it is open. One skill (`skills/<name>`, from a chat line or
// Settings › Agents › Skills, where the list is) opens in the panel with no tab of its own. One compact row of tabs,
// each its icon beside its word and its count on the word's baseline, a tooltip saying what it is; under the row that
// same line, and in a section of two views a second, smaller row of tabs between them (ui/DESIGN.md). The views are
// tabs.ts's, each with its route; a section remembers the view you last had in it while the app runs. A view the hub
// doesn't serve (tabs.ts `feature`) isn't there: Agents without Sessions is one view, with its own line, and a section
// whose every view needs one shows once it is served.
import { BookOpen, Bot, FileText, History, ListChecks, Ship, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tab, TabList, Tooltip } from "../../ui";
import type { ProjectKey } from "../shell/routes";
import { served, type PanelTab } from "./tabs";
import s from "./sections.module.css";

export interface Section {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** What it is, in one line, for someone new. */
  readonly line: string;
  /** Its line when the hub serves only its first view, if that differs. */
  readonly lineAlone?: string;
  /** Its views, in the inner row's order, with the inner row's words. */
  readonly views: readonly (readonly [PanelTab, string])[];
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
    views: [
      ["agents", "Agents"],
      ["sessions", "Screens"],
    ],
  },
  {
    id: "shipping",
    label: "Shipping",
    icon: Ship,
    line: "Changes on their way into main: open pull requests, and the line they merge in.",
    views: [
      ["prs", "Pull requests"],
      ["train", "Merge line"],
    ],
  },
  {
    id: "plan",
    label: "Plan",
    icon: ListChecks,
    line: "The lead’s to-do list, ticked off as work lands, and the work it asked your other projects for.",
    views: [
      ["checklist", "To-do"],
      ["asked", "Asked"],
    ],
  },
  {
    id: "artifacts",
    label: "Artifacts",
    icon: FileText,
    line: "Reports the lead and its agents published here, every version kept, and the files sent in the chat.",
    views: [["artifacts", "Artifacts"]],
    tucked: true,
  },
  {
    id: "history",
    label: "History",
    icon: History,
    line: "What happened here while you were away, and what you and the lead decided.",
    views: [
      ["activity", "What happened"],
      ["decisions", "Decisions"],
    ],
  },
];

/** One skill's, which has no tab: its list is in the project's settings. */
export const SKILL: Section = { id: "skills", label: "Skills", icon: BookOpen, line: "What the lead has learned to do: see, edit and undo every change.", views: [["skills", "Skills"]] };

const AGENTS = SECTIONS[0] as Section;

/**
 * The sections the row shows: a section whose every view needs a feature, only once it is served; a tucked one only
 * when `extra` names it (the open section, Artifacts once there is one).
 */
export const shownSections = (features: readonly string[], extra: readonly string[] = []): readonly Section[] =>
  SECTIONS.filter((g) => (g.tucked !== true || extra.includes(g.id)) && g.views.some(([tab]) => served(tab, features)));

export const sectionOf = (tab: PanelTab): Section => (tab === "skills" ? SKILL : (SECTIONS.find((g) => g.views.some(([t]) => t === tab)) ?? AGENTS));

/** `section` with only the views the hub serves (always its first), and the line that fits them. */
export const servedSection = (section: Section, features: readonly string[]): Section => {
  const views = section.views.filter(([tab], i) => i === 0 || served(tab, features));
  return views.length === section.views.length ? section : { ...section, views, line: views.length === 1 ? (section.lineAlone ?? section.line) : section.line };
};

// The view each section showed last, per project, while the app runs: back in Shipping, the merge line is still there.
const lastView = new Map<string, PanelTab>();

/** Notes `tab` as its section's view for `project`. */
export const noteView = (project: ProjectKey, tab: PanelTab): void => {
  lastView.set(`${project.machineId}/${project.projectId}/${sectionOf(tab).id}`, tab);
};

/** The view a section opens on for `project`: the one you last had in it while the hub serves it, else its first. */
export const viewOf = (project: ProjectKey, id: string, features: readonly string[] = []): PanelTab => {
  const section = SECTIONS.find((g) => g.id === id) ?? AGENTS;
  const last = lastView.get(`${project.machineId}/${project.projectId}/${id}`);
  return last !== undefined && served(last, features) ? last : (section.views[0]?.[0] ?? "agents");
};

/** Forgets every section's view (tests start from the first). */
export const forgetViews = (): void => lastView.clear();

/**
 * The sections, as the panel's tabs (inside its Tabs, whose value is a section's id), each tooltip the line for the
 * views the hub serves; `extra` names the tucked ones to show.
 */
export function SectionTabs({ count, features, extra }: { count: (tab: PanelTab) => ReactNode; features: readonly string[]; extra: readonly string[] }) {
  return (
    <TabList aria-label="Panel" className={s.bar}>
      {shownSections(features, extra).map((section) => {
        const g = servedSection(section, features);
        const Icon = g.icon;
        const first = g.views[0]?.[0] ?? "agents";
        return (
          <Tooltip key={g.id} content={g.line} side="bottom">
            <Tab value={g.id} className={s.section} data-section={g.id} aria-label={g.label}>
              <Icon aria-hidden className={s.icon} />
              <span className={s.words}>
                <span className={s.label}>{g.label}</span>
                <span className={s.count}>{count(first)}</span>
              </span>
            </Tab>
          </Tooltip>
        );
      })}
    </TabList>
  );
}

/** A section's line; for one of two views, the inner row of tabs between them (inside a Tabs whose value is a view). */
export function SectionHead({ section, count }: { section: Section; count: (tab: PanelTab) => ReactNode }) {
  return (
    <div className={s.under}>
      <p className={s.line}>{section.line}</p>
      {section.views.length > 1 ? (
        <TabList aria-label={section.label} className={s.switch}>
          {section.views.map(([tab, words]) => (
            <Tab key={tab} value={tab} className={s.option} data-tab={tab}>
              <span className={s.words}>
                {words}
                <span className={s.count}>{count(tab)}</span>
              </span>
            </Tab>
          ))}
        </TabList>
      ) : null}
    </div>
  );
}
