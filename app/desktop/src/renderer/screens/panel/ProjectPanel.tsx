// The panel beside a project's chat: a tab each for its agents (or every project's), its pull requests, its checklist
// and whatever else tabs.ts lists, in that list's order. A row opens one agent's live work or one PR in the list's
// place, with a way back above it. Tabs, rows and Back are all routes (shell/routes.ts), so links from the chat,
// Status and the palette open the same views. Only the open tab's pane is mounted and reads from the hub; the counts
// on the bar read only what is cheap. The bar fits the panel's width (tabFit.ts): labels, then icons, then More.
import { ChevronLeft, MoreHorizontal } from "lucide-react";
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ComponentType, type LazyExoticComponent } from "react";
import { Boundary } from "../../src/Boundary";
import { Button, designPick, Menu, MenuContent, MenuItem, MenuTrigger, Tab, TabList, TabPanel, Tabs } from "../../ui";
import { navigate } from "../shell/navigation";
import { hasItem, listView, panelRoute, type PanelView, type ProjectKey } from "../shell/routes";
import { PanesProvider } from "./panes";
import { Overview, SectionBar, SectionTop } from "./Sections";
import { fitTabs, type TabFit } from "./tabFit";
import { isPanelTab, PANEL_TABS, tabEntry, type CountProps, type PanelTab, type PanelTabEntry, type PaneProps } from "./tabs";
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

export function ProjectPanel({ project, view, onWide }: { project: ProjectKey; view: PanelView; onWide: (wide: boolean) => void }) {
  const entry = tabEntry(view.tab);
  const Pane = PANES[view.tab];
  const pick = (tab: string) => {
    if (isPanelTab(tab)) navigate(panelRoute(project, listView(tab)), { replace: true });
  };
  // W42 design preview: the panel as four sections (Sections.tsx), A a bar of them, B an overview first.
  const design = designPick("panel", "off");
  const [home, setHome] = useState(true);
  const badge = (tab: PanelTab) => <PlainCount id={tab} project={project} active={tab === view.tab} />;
  if (design === "b" && home) {
    return (
      <PanesProvider>
        <div className={s.panel}>
          <Overview
            badge={badge}
            onPick={(tab) => {
              setHome(false);
              pick(tab);
            }}
          />
        </div>
      </PanesProvider>
    );
  }
  return (
    <PanesProvider>
      <Tabs className={s.panel} value={view.tab} onValueChange={pick}>
        {design === "a" ? (
          <SectionBar project={project} active={view.tab} onPick={pick} badge={badge} />
        ) : design === "b" ? (
          <SectionTop active={view.tab} onPick={pick} onHome={() => setHome(true)} />
        ) : (
          <TabBar project={project} active={view.tab} onPick={pick} />
        )}
        {hasItem(view) && entry.back !== undefined ? (
          <div className={s.back}>
            <Button variant="quiet" size="sm" icon={<ChevronLeft aria-hidden />} onClick={() => navigate(panelRoute(project, listView(view.tab)))}>
              {entry.back}
            </Button>
          </div>
        ) : null}
        <TabPanel value={view.tab} className={s.body}>
          <Boundary key={view.tab} part={`the ${entry.label} tab`}>
            <Suspense fallback={<div className={s.loading} aria-busy="true" />}>
              <Pane project={project} view={view} onWide={onWide} />
            </Suspense>
          </Boundary>
        </TabPanel>
      </Tabs>
    </PanesProvider>
  );
}

type TabDef = (typeof PANEL_TABS)[number];

const EVERY: TabFit = { labels: true, shown: PANEL_TABS.map((_, i) => i), more: [] };
const same = (a: TabFit, b: TabFit) => a.labels === b.labels && a.shown.join() === b.shown.join();
const widthsIn = (row: Element | null): number[] => [...(row?.children ?? [])].map((el) => (el as HTMLElement).offsetWidth);

/**
 * The tabs as fit the bar. A hidden copy holds every tab both ways, labels and icons, so the bar measures what each
 * would take before it shows it and never flickers between the two.
 */
function TabBar({ project, active, onPick }: { project: ProjectKey; active: PanelTab; onPick: (tab: PanelTab) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<TabFit>(EVERY);
  const at = Math.max(0, PANEL_TABS.findIndex((t) => t.id === active));

  useLayoutEffect(() => {
    const room = bar.current;
    const copy = measure.current;
    if (room === null || copy === null) return;
    const run = () => {
      const [full, icon] = [copy.querySelector("[data-row='full']"), copy.querySelector("[data-row='icon']")];
      const more = copy.querySelector<HTMLElement>("[data-more]")?.offsetWidth ?? 0;
      const gap = parseFloat(getComputedStyle(full ?? copy).columnGap) || 0;
      const next = fitTabs({ full: widthsIn(full), icon: widthsIn(icon), gap, more }, room.clientWidth, at);
      setFit((was) => (same(was, next) ? was : next));
    };
    run();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(run);
    watch.observe(room);
    watch.observe(copy);
    return () => watch.disconnect();
  }, [at]);

  return (
    <div className={s.head}>
      <div ref={bar} className={s.bar}>
        <TabList aria-label="Panel" className={s.tabs}>
          {fit.shown.map((i) => {
            const tab = PANEL_TABS[i];
            if (tab === undefined) return null;
            return (
              <Tab key={tab.id} value={tab.id} className={s.tab} aria-label={fit.labels ? undefined : tab.label} title={fit.labels ? undefined : tab.label} data-tab={tab.id}>
                <Face tab={tab} project={project} active={tab.id === active} labels={fit.labels} />
              </Tab>
            );
          })}
        </TabList>
        {fit.more.length > 0 ? (
          <Menu>
            <MenuTrigger asChild>
              <Button variant="quiet" iconOnly aria-label="More tabs" title="More tabs" className={s.more}>
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              {fit.more.map((i) => {
                const tab = PANEL_TABS[i];
                if (tab === undefined) return null;
                const Icon = tab.icon;
                return (
                  <MenuItem key={tab.id} icon={<Icon aria-hidden className={s.icon} />} hint={<Badge id={tab.id} project={project} active={false} />} onSelect={() => onPick(tab.id)}>
                    {tab.label}
                  </MenuItem>
                );
              })}
            </MenuContent>
          </Menu>
        ) : null}
      </div>
      <div ref={measure} className={s.measure} aria-hidden="true" inert>
        <div data-row="full" className={s.tabs}>
          {PANEL_TABS.map((tab) => (
            <span key={tab.id} className={s.tab} data-state={tab.id === active ? "active" : undefined}>
              <Face tab={tab} project={project} active={tab.id === active} labels />
            </span>
          ))}
        </div>
        <div data-row="icon" className={s.tabs}>
          {PANEL_TABS.map((tab) => (
            <span key={tab.id} className={s.tab} data-state={tab.id === active ? "active" : undefined}>
              <Face tab={tab} project={project} active={tab.id === active} labels={false} />
            </span>
          ))}
        </div>
        <span data-more className={s.moreSize} />
      </div>
    </div>
  );
}

function Face({ tab, project, active, labels }: { tab: TabDef; project: ProjectKey; active: boolean; labels: boolean }) {
  const Icon = tab.icon;
  return (
    <>
      <Icon aria-hidden className={s.icon} />
      {labels ? <span className={s.label}>{tab.label}</span> : null}
      <Badge id={tab.id} project={project} active={active} />
    </>
  );
}

/** A tab's count, if it has one; nothing while it loads or has no number worth showing. */
function Badge({ id, project, active }: { id: PanelTab; project: ProjectKey; active: boolean }) {
  const Count = COUNTS[id];
  if (Count === undefined) return null;
  return (
    <span className={s.count}>
      <Suspense fallback={null}>
        <Count project={project} active={active} />
      </Suspense>
    </span>
  );
}

/** A tab's count as bare figures, for the sections' row, where it sits on the word's baseline. */
function PlainCount({ id, project, active }: { id: PanelTab; project: ProjectKey; active: boolean }) {
  const Count = COUNTS[id];
  if (Count === undefined) return null;
  return (
    <Suspense fallback={null}>
      <Count project={project} active={active} />
    </Suspense>
  );
}
