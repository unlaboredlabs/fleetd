// W42 design preview, the panel's structure. Six tabs became four sections in everyday words, each with an icon, its
// label, a one-line say-what-it-is on hover and under the bar, and where it holds two views a switch between them:
// Agents; Shipping (pull requests, and the merge line they land in); Plan (the checklist); History (what happened,
// and what was decided). Direction A is a bar of the four; B opens on an overview of them and drills in. The routes
// and panes are the same; only the way to them changes. Prototype only, behind localStorage fleetd.design panel=a|b.
import { Bot, ChevronLeft, ChevronRight, History, ListChecks, Ship, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";
import { Button, Tooltip, cx } from "../../ui";
import type { ProjectKey } from "../shell/routes";
import type { PanelTab } from "./tabs";
import s from "./sections.module.css";

export interface Section {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** What it is, in one line, for someone new. */
  readonly line: string;
  /** Its views, in the switch's order, with the switch's words. */
  readonly views: readonly (readonly [PanelTab, string])[];
}

export const SECTIONS: readonly Section[] = [
  { id: "agents", label: "Agents", icon: Bot, line: "The AI workers on this project, and what each is doing right now.", views: [["agents", "Agents"]] },
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
  { id: "plan", label: "Plan", icon: ListChecks, line: "The lead’s to-do list for this project, ticked off as work lands.", views: [["checklist", "To-do"]] },
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

export const sectionOf = (tab: PanelTab): Section => SECTIONS.find((g) => g.views.some(([t]) => t === tab)) ?? (SECTIONS[0] as Section);

type BadgeOf = (tab: PanelTab) => ReactNode;

/** A: the four sections as a bar, icon over label, the open one filled; its line and switch under it. */
export function SectionBar({ active, onPick, badge }: { project: ProjectKey; active: PanelTab; onPick: (tab: PanelTab) => void; badge: BadgeOf }) {
  const open = sectionOf(active);
  return (
    <div className={s.head}>
      <div className={s.bar} role="tablist" aria-label="Panel">
        {SECTIONS.map((g) => {
          const Icon = g.icon;
          const on = g.id === open.id;
          const first = g.views[0]?.[0] ?? "agents";
          return (
            <Tooltip key={g.id} content={g.line} side="bottom">
              <button type="button" role="tab" aria-selected={on} className={cx(s.section, on && s.on)} data-section={g.id} onClick={() => onPick(on ? active : first)}>
                <Icon aria-hidden className={s.icon} />
                <span className={s.labelRow}>
                  <span className={s.label}>{g.label}</span>
                  <span className={s.badge}>{badge(first)}</span>
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>
      <SectionHead section={open} active={active} onPick={onPick} />
    </div>
  );
}

/** The open section's line, and its switch when it holds two views. */
function SectionHead({ section, active, onPick }: { section: Section; active: PanelTab; onPick: (tab: PanelTab) => void }) {
  return (
    <div className={s.under}>
      <p className={s.line}>{section.line}</p>
      {section.views.length > 1 ? (
        <div className={s.switch} role="radiogroup" aria-label={section.label}>
          {section.views.map(([tab, words]) => (
            <button key={tab} type="button" role="radio" aria-checked={tab === active} className={cx(s.option, tab === active && s.optionOn)} onClick={() => onPick(tab)}>
              {words}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** B: the overview the panel opens on: a card per section with its line and count; a card opens it. */
export function Overview({ onPick, badge }: { onPick: (tab: PanelTab) => void; badge: BadgeOf }) {
  return (
    <div className={s.overview} data-screen="panel.overview">
      {SECTIONS.map((g) => {
        const Icon = g.icon;
        const first = g.views[0]?.[0] ?? "agents";
        return (
          <button key={g.id} type="button" className={s.card} data-section={g.id} onClick={() => onPick(first)}>
            <span className={s.cardIcon}>
              <Icon aria-hidden />
            </span>
            <span className={s.cardText}>
              <span className={s.cardTitle}>
                {g.label}
                <span className={s.badge}>{badge(first)}</span>
              </span>
              <span className={s.cardLine}>{g.line}</span>
            </span>
            <ChevronRight aria-hidden className={s.chevron} />
          </button>
        );
      })}
    </div>
  );
}

/** B, inside a section: the way back to the overview, its name, then its line and switch. */
export function SectionTop({ active, onPick, onHome }: { active: PanelTab; onPick: (tab: PanelTab) => void; onHome: () => void }) {
  const open = sectionOf(active);
  const Icon = open.icon;
  return (
    <div className={s.head}>
      <div className={s.crumb}>
        <Button variant="quiet" size="sm" icon={<ChevronLeft aria-hidden />} onClick={onHome}>
          Overview
        </Button>
        <span className={s.crumbTitle}>
          <Icon aria-hidden className={s.icon} />
          {open.label}
        </span>
      </div>
      <SectionHead section={open} active={active} onPick={onPick} />
    </div>
  );
}
