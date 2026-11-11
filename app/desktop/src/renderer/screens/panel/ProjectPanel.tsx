// The panel beside a project's chat: one row of tabs (Sections.tsx: Agents, Shipping, Plan, History, and Artifacts once
// the project has one) and under it the open tab's one list, nothing between them. One skill opens here with no tab,
// its way back to the list in the project's settings. A row opens one agent's live work, one PR or the decisions in the
// list's place, with a way back above it; one screen takes the whole tab, its way back in its own line. Tabs, rows and
// Back are all routes (shell/routes.ts), so links from the chat, Status and the palette open the same views. Only the
// open tab's pane is mounted and reads from the hub; the counts on the tabs read only what is cheap.
import { ChevronLeft, Settings } from "lucide-react";
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { Boundary } from "../../src/Boundary";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { Button, TabPanel, Tabs, Tooltip, cx } from "../../ui";
import { navigate } from "../shell/navigation";
import { backView, hasItem, listView, panelRoute, projectSkills, type PanelView, type ProjectKey } from "../shell/routes";
import { listOf, sectionOf, SECTIONS, SectionTabs, servedSection, SKILL } from "./Sections";
import { PANEL_TABS, served, tabEntry, type CountProps, type PanelTab, type PanelTabEntry, type PaneProps } from "./tabs";
import s from "./panel.module.css";

// Each tab's pane and count, loaded the first time the panel renders them (lazy loads nothing until then).
type Lazy<P> = LazyExoticComponent<ComponentType<P>>;
const PANES: Readonly<Record<string, Lazy<PaneProps>>> = Object.fromEntries([...SECTIONS, SKILL].map((g) => [g.id, lazy(() => g.pane().then((c) => ({ default: c })))]));
const COUNTS: Readonly<Partial<Record<PanelTab, Lazy<CountProps>>>> = Object.fromEntries(
  PANEL_TABS.flatMap((t: PanelTabEntry) => {
    const load = t.count;
    return load === undefined ? [] : [[t.id, lazy(() => load().then((c) => ({ default: c })))]];
  }),
);

export function ProjectPanel({ project, view: routed, onWide }: { project: ProjectKey; view: PanelView; onWide: (wide: boolean) => void }) {
  const features = useData((st) => st.features);
  // The skills' list is in the project's settings: the panel remembered on it opens on Agents.
  const asked = routed.tab === "skills" && routed.skill === null ? listView("agents") : routed;
  // A link to a view this hub doesn't serve opens its tab's list, or Agents when the hub serves none of it.
  const first = sectionOf(asked.tab).views[0] ?? "agents";
  const view = served(asked.tab, features) ? asked : listView(served(first, features) ? first : "agents");
  const entry = tabEntry(view.tab);
  const section = servedSection(sectionOf(view.tab), features);
  const Pane = PANES[section.id];
  // Artifacts joins the row with the project's first report or file sent in the chat (artifacts.changed and
  // chat.message read the list again), or while it's open.
  const artifacts = useToolQuery("artifacts_list", { projectRef: { machineId: project.machineId, projectId: project.projectId } }, { enabled: served("artifacts", features) });
  const has = (artifacts.data?.artifacts.length ?? 0) + (artifacts.data?.files.length ?? 0) > 0;
  const extra = has ? [section.id, "artifacts"] : [section.id];
  const count = (tab: PanelTab) => <Count id={tab} project={project} active={tab === view.tab} />;
  // One screen has the tab's height to itself: its own line has the way back (sessions/SessionView.tsx).
  const alone = hasItem(view) && view.tab === "sessions";
  const back = backView(view);
  const body = (
    <div className={cx(s.body, alone && s.flush)}>
      {back !== null && entry.back !== undefined && !alone ? (
        <div className={s.back}>
          <Button variant="quiet" size="sm" icon={<ChevronLeft aria-hidden />} onClick={() => navigate(view.tab === "skills" ? projectSkills(project) : panelRoute(project, back))}>
            {entry.back}
          </Button>
        </div>
      ) : null}
      {/* Keyed by the tab, not the view: a link to a place in the open list (its screens, the merge line) moves the
          list, it doesn't read it again. */}
      <Boundary key={section.id} part={`the ${section.label} tab`}>
        <Suspense fallback={<div className={s.loading} aria-busy="true" />}>{Pane === undefined ? null : <Pane project={project} view={view} onWide={onWide} />}</Suspense>
      </Boundary>
    </div>
  );
  return (
    <Tabs className={s.panel} value={section.id} onValueChange={(id) => navigate(panelRoute(project, listView(listOf(id))), { replace: true })}>
      <div className={s.head}>
        <SectionTabs count={count} features={features} extra={extra} />
        <Tooltip content="The project’s settings: its connections, sign-ins, approvals and memory" side="bottom">
          <Button variant="quiet" iconOnly className={s.headTool} aria-label="Project settings" onClick={() => navigate({ id: "settings", tab: "projects", for: projectKey(project) })}>
            <Settings />
          </Button>
        </Tooltip>
      </div>
      {section === SKILL ? (
        // No tab names it, so no tab panel either.
        <div className={s.section}>{body}</div>
      ) : (
        <TabPanel value={section.id} className={s.section}>
          {body}
        </TabPanel>
      )}
    </Tabs>
  );
}

/** A tab's count as bare figures, on its word's baseline; nothing while it loads or has no number worth showing. */
function Count({ id, project, active }: { id: PanelTab; project: ProjectKey; active: boolean }) {
  const Load = COUNTS[id];
  if (Load === undefined) return null;
  return (
    <Suspense fallback={null}>
      <Load project={project} active={active} />
    </Suspense>
  );
}
