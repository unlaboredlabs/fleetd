// The pages Settings gathers in sets, under tabs in the content pane, so the sidebar stays one flat list: a project's
// five (Project, Agents, Instructions & memory, Automations, Vault), opened from Settings › Projects with a way
// back to it in the window's top row, and Hub › Every project's three.
import type { ReactNode } from "react";
import { Button, Tab, TabList, Tabs } from "../../ui";
import { useData, useHub } from "../../src/data/react";
import { navigate } from "../shell/navigation";
import { PageFrame, scopeName, useProjects } from "./parts";
import { parseScope } from "./editor";
import { EVERY_PROJECT, formatRoute, PROJECT_TABS, type Tab as SettingsTab } from "./route";
import { PAGE_LABEL } from "./search";
import { vaultServed } from "./vaultModel";
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
  // Vault, only on a hub that serves it.
  const vault = useData((st) => vaultServed(st.features));
  const tabs = vault ? PROJECT_TABS : PROJECT_TABS.filter((t) => t !== "project-vault");
  const lead = (
    <Button variant="ghost" size="sm" onClick={() => navigate({ id: "settings", tab: "projects" })}>
      ‹ Projects
    </Button>
  );
  return (
    <PageFrame.Provider value={{ title: scopeName(parseScope(project), projects), lead }}>
      <PageTabs label="Project" tabs={tabs} current={tab} onOpen={(t) => (window.location.hash = formatRoute({ tab: t, for: project }))} />
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
