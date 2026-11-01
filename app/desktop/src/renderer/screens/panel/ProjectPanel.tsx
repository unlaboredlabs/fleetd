// The panel beside a project's chat, in four sections (Sections.tsx): Agents, Shipping, Plan and History, two of them
// with a view each side of an inner row of tabs. A row opens one agent's live work or one PR in the list's place, with
// a way back above it; one screen takes the whole section, its way back in its own line. Sections, views, rows and Back are all routes (shell/routes.ts), so links from the chat, Status
// and the palette open the same views. Only the open view's pane is mounted and reads from the hub; the counts on the
// tabs read only what is cheap. A Navi's panel has its own sections (Sections.tsx, NAVI_SECTIONS).
import { ChevronLeft } from "lucide-react";
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { Boundary } from "../../src/Boundary";
import { useData } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { isNavi } from "../navi/model";
import { Button, TabPanel, Tabs, cx } from "../../ui";
import { navigate } from "../shell/navigation";
import { hasItem, listView, panelRoute, type PanelView, type ProjectKey } from "../shell/routes";
import { PanesProvider } from "./panes";
import { inSections, noteView, SectionHead, sectionOf, sectionsFor, SectionTabs, servedSection, viewOf } from "./Sections";
import { isPanelTab, PANEL_TABS, served, tabEntry, type CountProps, type PanelTab, type PanelTabEntry, type PaneProps } from "./tabs";
import s from "./panel.module.css";

// Each tab's pane and count, loaded the first time the panel renders them (lazy loads nothing until then).
type Lazy<P> = LazyExoticComponent<ComponentType<P>>;
const PANES = Object.fromEntries(PANEL_TABS.map((t) => [t.id, lazy(() => t.pane().then((c) => ({ default: c })))])) as Readonly<Record<PanelTab, Lazy<PaneProps>>>;
const COUNTS: Readonly<Partial<Record<PanelTab, Lazy<CountProps>>>> = Object.fromEntries(
  PANEL_TABS.flatMap((t: PanelTabEntry) => {
    const load = t.count;
    return load === undefined ? [] : [[t.id, lazy(() => load().then((c) => ({ default: c })))]];
  }),
);

export function ProjectPanel({ project, view: asked, onWide }: { project: ProjectKey; view: PanelView; onWide: (wide: boolean) => void }) {
  const features = useData((st) => st.features);
  const navi = useData((st) => {
    const p = st.projects[projectKey(project)];
    return p !== undefined && isNavi(p);
  });
  const sections = sectionsFor(navi, features);
  // A link to a view this hub doesn't serve opens its section's first; one this kind of project hasn't, its first section.
  const fallback = sectionOf(asked.tab, sections).views[0]?.[0] ?? "agents";
  const view = served(asked.tab, features) && inSections(asked.tab, sections) ? asked : listView(fallback);
  const entry = tabEntry(view.tab);
  const section = servedSection(sectionOf(view.tab, sections), features);
  const Pane = PANES[view.tab];
  noteView(project, view.tab, sections);
  const pick = (tab: string) => {
    if (isPanelTab(tab)) navigate(panelRoute(project, listView(tab)), { replace: true });
  };
  const count = (tab: PanelTab) => <Count id={tab} project={project} active={tab === view.tab} />;
  // One screen has the section's height to itself, with no line or inner tabs above it: its own line has the way back
  // (sessions/SessionView.tsx).
  const alone = hasItem(view) && view.tab === "sessions";
  const body = (
    <>
      {hasItem(view) && entry.back !== undefined && !alone ? (
        <div className={s.back}>
          <Button variant="quiet" size="sm" icon={<ChevronLeft aria-hidden />} onClick={() => navigate(panelRoute(project, listView(view.tab)))}>
            {entry.back}
          </Button>
        </div>
      ) : null}
      <Boundary key={view.tab} part={`the ${entry.label} tab`}>
        <Suspense fallback={<div className={s.loading} aria-busy="true" />}>
          <Pane project={project} view={view} onWide={onWide} />
        </Suspense>
      </Boundary>
    </>
  );
  return (
    <PanesProvider>
      <Tabs className={s.panel} value={section.id} onValueChange={(id) => pick(viewOf(project, id, features, sections))}>
        <div className={s.head}>
          <SectionTabs count={count} features={features} sections={sections} />
        </div>
        <TabPanel value={section.id} className={s.section}>
          {section.views.length > 1 ? (
            <Tabs className={s.section} value={view.tab} onValueChange={pick}>
              {alone ? null : <SectionHead section={section} count={count} />}
              <TabPanel value={view.tab} className={cx(s.body, alone && s.flush)}>
                {body}
              </TabPanel>
            </Tabs>
          ) : (
            <>
              {alone ? null : <SectionHead section={section} count={count} />}
              <div className={cx(s.body, alone && s.flush)}>{body}</div>
            </>
          )}
        </TabPanel>
      </Tabs>
    </PanesProvider>
  );
}

/** A view's count as bare figures, on its word's baseline; nothing while it loads or has no number worth showing. */
function Count({ id, project, active }: { id: PanelTab; project: ProjectKey; active: boolean }) {
  const Load = COUNTS[id];
  if (Load === undefined) return null;
  return (
    <Suspense fallback={null}>
      <Load project={project} active={active} />
    </Suspense>
  );
}
