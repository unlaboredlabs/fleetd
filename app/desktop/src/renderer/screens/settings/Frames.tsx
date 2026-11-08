// The pages Settings gathers in sets, under tabs in the content pane, so the sidebar stays one flat list: a project's
// five (Project, Agents, Instructions & memory, Automations, Prompts), opened from Settings › Projects with a way back
// to it in the window's top row, and Hub › Every project's four. Also the rows of the pane's own lists (the projects, a
// set's prompts): each opens what it names from anywhere on the row, which a trailing chevron marks.
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Tab, TabList, Tabs, Text } from "../../ui";
import { useHub } from "../../src/data/react";
import { navigate } from "../shell/navigation";
import { PageFrame, scopeName, useProjects } from "./parts";
import { parseScope } from "./editor";
import { EVERY_PROJECT, formatRoute, PROJECT_TABS, type Tab as SettingsTab } from "./route";
import { PAGE_LABEL } from "./search";
import s from "./settings.module.css";

/** A set's pages as tabs above the page; picking one opens it. */
function PageTabs({ label, tabs, current, onOpen }: { label: string; tabs: ReadonlyArray<SettingsTab>; current: SettingsTab; onOpen: (tab: SettingsTab) => void }) {
  return (
    <Tabs value={current} activationMode="manual" onValueChange={(v) => onOpen(tabs.find((t) => t === v) ?? current)} className={s.pageTabs}>
      <TabList aria-label={label} className={s.pageTabList}>
        {tabs.map((t) => (
          <Tab key={t} value={t}>
            {PAGE_LABEL[t]}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}

/** One project's pages: its name in the top row with the way back to Projects, its pages as tabs. */
export function ProjectFrame({ project, tab, children }: { project: string; tab: SettingsTab; children: ReactNode }) {
  const projects = useProjects();
  const lead = (
    <Button variant="ghost" size="sm" onClick={() => navigate({ id: "settings", tab: "projects" })}>
      ‹ Projects
    </Button>
  );
  return (
    <PageFrame.Provider value={{ title: scopeName(parseScope(project), projects), lead }}>
      <PageTabs label="Project" tabs={PROJECT_TABS} current={tab} onOpen={(t) => (window.location.hash = formatRoute({ tab: t, for: project }))} />
      {children}
    </PageFrame.Provider>
  );
}

/** Hub › Every project's pages, laid out as a project's are. */
export function EveryProjectFrame({ tab, children }: { tab: SettingsTab; children: ReactNode }) {
  const { id } = useHub();
  return (
    <PageFrame.Provider value={{ title: "Every project" }}>
      <PageTabs label="Every project" tabs={EVERY_PROJECT} current={tab} onOpen={(t) => navigate({ id: "settings", tab: t, at: id })} />
      {children}
    </PageFrame.Provider>
  );
}

/** A list of rows that open what they name. */
export function OpenList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.openList} role="list" aria-label={label}>
      {children}
    </div>
  );
}

/** A row of an OpenList: its name, a quiet line under it, an optional mark before it and words after it. */
export function OpenRow(props: { title: string; detail?: ReactNode; lead?: ReactNode; trailing?: ReactNode; current?: boolean; onOpen: () => void }) {
  return (
    <div role="listitem" className={s.openItem}>
      <button type="button" className={s.openRow} aria-current={props.current === true ? "page" : undefined} onClick={props.onOpen}>
        {props.lead}
        <span className={s.openText}>
          <Text strong>{props.title}</Text>
          {props.detail === undefined ? null : (
            <Text size="xs" tone="quiet">
              {props.detail}
            </Text>
          )}
        </span>
        {props.trailing}
        <ChevronRight className={s.openChevron} aria-hidden />
      </button>
    </div>
  );
}
