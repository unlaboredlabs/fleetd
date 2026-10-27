// The app frame: the sidebar of projects down the left (the macOS traffic lights sit in its top row, over the window's
// translucent material), the top row beside it (the window's drag region, where a chat puts its title), and the
// screen the route names: a project's lead chat, with its agents, PRs and checklist in the panel on the right (panel.tsx), or
// Status, Time or Settings. Navigation is the hash (routes.ts); `#/` opens the project you last had open.
import { PanelLeft, Search } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { display } from "../../../shared/shortcuts";
import { AppFrame, Button, TopBar } from "../../ui";
import { openPalette, PaletteHost, useCommands, type Command } from "../palette";
import { ProjectsHost } from "../projects";
import { useMetricsSupport } from "../factory/support";
import { useDockBadge, useMainProcess, useMenuState, useModHeld, useNotifications } from "./effects";
import { useHubState } from "./hubFeed";
import { useData, useDataLayer } from "../../src/data/react";
import { homeProject, nextWanting, projectId, routeOf, stepProject } from "./model";
import { useMachinesDown, useSidebarProjects } from "./data";
import { navigate, useRoute } from "./navigation";
import { PANEL_TABS, served } from "../panel/tabs";
import { HOME, listView, panelRoute, type Screen } from "./routes";
import { PanelSlot, PanelToggle, useProjectPanel } from "./panel";
import { ConnectionBanner, GetStarted, needsOnboarding } from "../onboarding";
import { UpdatesHost } from "../updates";
import { Boundary } from "../../src/Boundary";
import { ScreenHost, screenPart } from "./screens";
import { Sidebar } from "./Sidebar";
import { useSidebar } from "./sidebarState";
import s from "./shell.module.css";

const platform = window.fleetd.platform;

const JUMPS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

// Settings' own sidebar takes the projects' place while Settings is open; it ships in Settings' chunk.
const SettingsSidebar = lazy(() => import("../settings/SettingsScreen").then((m) => ({ default: m.SettingsSidebar })));

/** The project `#/` opens, kept across launches: the app opens where you left it. */
const LAST_PROJECT = "fleetd.lastProject";
const readLast = (): string | null => {
  try {
    return window.localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
};

export function Shell() {
  const route = useRoute();
  const layer = useDataLayer();
  const hub = useHubState();
  const features = useData((st) => st.features);
  // The route's project, not the resolved home: `#/` becomes a project's own route at once.
  const projects = useSidebarProjects(route.id === "project" ? route.project : null);
  const machinesDown = useMachinesDown();
  const sidebar = useSidebar();
  const modHeld = useModHeld();

  useMainProcess();
  useMenuState();
  useNotifications(hub.phase === "live");
  useDockBadge();

  // `#/` is the last project once the projects are known: shown as that project at once, and the URL follows (replace,
  // so Back doesn't return to the bare `#/`). It is shown from `home`, not from the replaced URL: a hash set back to
  // `#/` before React reads the replace leaves the hash snapshot unchanged, so nothing would render or redirect again.
  const home = route.id === "home" && projects !== undefined ? homeProject(projects, readLast()) : null;
  const screen: Screen = useMemo(
    () =>
      home !== null
        ? { id: "project", project: home, message: null }
        : // A session's own window's route, here: its project, with the session in the panel.
          route.id === "session"
          ? { id: "project", project: route.project, message: null, panel: { tab: "sessions", session: route.session } }
          : route,
    [route, home],
  );
  useEffect(() => {
    if (home !== null) navigate({ id: "project", project: home, message: null }, { replace: true });
  }, [home]);

  // Where Settings' Back returns: the last screen before Settings.
  const away = useRef<Screen>(HOME);
  useEffect(() => {
    if (screen.id !== "settings" && screen.id !== "onboarding") away.current = screen;
  }, [screen]);
  const back = useSettingsBack(screen.id === "settings");

  const open = screen.id === "project" ? screen.project : null;
  // The palette's Agents and Pull requests: the project on screen, else the one `#/` opens.
  const panelProject = open ?? (projects === undefined ? null : homeProject(projects, readLast()));
  const panel = useProjectPanel(screen);
  // The chat on screen is the one open, and the one that streams.
  const openKey = open === null ? null : projectId(open);
  useEffect(() => {
    if (openKey === null) {
      layer.chat.close();
      return;
    }
    layer.chat.open(openKey);
  }, [layer, openKey]);
  useEffect(() => {
    if (open === null) return;
    try {
      window.localStorage.setItem(LAST_PROJECT, projectId(open));
    } catch {
      // Without storage the app opens on the first project instead; nothing else depends on it.
    }
  }, [open]);


  // Before pairing, after a refused key, or on a hub of another protocol there is nothing to navigate; the
  // onboarding screen has the window to itself.
  const blocked = needsOnboarding(hub);
  const onboarding = blocked || screen.id === "onboarding";
  const shown: Screen = blocked && screen.id !== "onboarding" ? { id: "onboarding", hub: null, code: null } : screen;
  const chrome = !onboarding;

  const go = (next: Screen) => navigate(next);
  const step = (by: 1 | -1) => {
    const next = projects === undefined ? null : stepProject(projects, open, by);
    if (next !== null) go({ id: "project", project: next, message: null });
  };

  // A hub from before metrics has no Factory: its entry, menu item, command and shortcut go (factory/support.ts).
  const metrics = useMetricsSupport();
  const factory = metrics !== false;

  useCommands(
    [
      {
        id: "factory.open",
        title: "Factory",
        detail: "What came out: merges per day, order to merged, your minutes, share through fleetd",
        group: "go-to",
        keywords: ["metrics", "merged", "throughput", "lead time", "dashboard"],
        enabled: () => chrome && factory,
        run: () => go({ id: "factory", project: null }),
      },
      { id: "sidebar.toggle", title: "Toggle sidebar", group: "actions", enabled: () => chrome, run: sidebar.toggle },
      { id: "panel.toggle", title: "Toggle the panel", group: "actions", keywords: ["panel", "right", "agents", "prs", "checklist"], enabled: () => chrome && open !== null, run: panel.toggle },
      { id: "project.previous", title: "Previous project", group: "projects", searchOnly: true, enabled: () => chrome && (projects?.length ?? 0) > 0, run: () => step(-1) },
      { id: "project.next", title: "Next project", group: "projects", searchOnly: true, enabled: () => chrome && (projects?.length ?? 0) > 0, run: () => step(1) },
      {
        id: "project.nextNeedsYou",
        title: "Next project that needs you",
        group: "projects",
        keywords: ["waiting", "reply", "approve", "secret", "blocked"],
        enabled: () => chrome && projects !== undefined && nextWanting(projects, open) !== null,
        run: () => {
          const next = projects === undefined ? null : nextWanting(projects, open);
          if (next !== null) go({ id: "project", project: next, message: null });
        },
      },
      // One per panel tab, from its list: a new tab is in the palette too, once the hub serves it.
      ...PANEL_TABS.map(
        (tab): Command => ({
          id: `go:${tab.id}`,
          title: tab.label,
          detail: tab.detail,
          group: "go-to",
          keywords: [...tab.keywords],
          enabled: () => chrome && panelProject !== null && served(tab.id, features),
          run: () => {
            if (panelProject !== null) go(panelRoute(panelProject, listView(tab.id)));
          },
        }),
      ),
      ...JUMPS.map(
        (n): Command => ({
          id: `project.open.${String(n)}`,
          title: `Open project ${String(n)} in the sidebar`,
          group: "projects",
          searchOnly: true,
          enabled: () => chrome && projects?.[n - 1] !== undefined,
          run: () => {
            const p = projects?.[n - 1];
            if (p !== undefined) go({ id: "project", project: routeOf(p), message: null });
          },
        }),
      ),
    ],
    [],
  );

  const toggle = (
    <Button
      variant="quiet"
      iconOnly
      aria-label={sidebar.hidden ? "Show the sidebar" : "Hide the sidebar"}
      title={`${sidebar.hidden ? "Show" : "Hide"} the sidebar (${display("sidebar.toggle", platform)})`}
      aria-pressed={!sidebar.hidden}
      onClick={sidebar.toggle}
    >
      <PanelLeft />
    </Button>
  );
  // Settings' pages are in its sidebar, so it shows whatever the toggle says.
  const settings = shown.id === "settings";
  const showSidebar = chrome && (settings || !sidebar.hidden);

  const top = (
    <TopBar
      leading={chrome && !showSidebar ? toggle : undefined}
      trailing={
        chrome ? (
          <>
            {/* The shortcut is the label: the key you learn, not a word to read every time. */}
            <Button variant="quiet" icon={<Search />} shortcut={display("palette.toggle", platform)} aria-label="Commands" title="Commands" onClick={() => openPalette()} />
            <PanelToggle panel={panel} />
          </>
        ) : undefined
      }
    />
  );

  return (
    <div className={s.root} data-screen="shell">
      <AppFrame
        translucent
        topBar={top}
        sidebarTop={settings ? undefined : toggle}
        sidebar={
          !chrome ? undefined : settings ? (
            <Boundary key="settings" part="the sidebar">
              <Suspense fallback={null}>
                <SettingsSidebar
                  onBack={() => {
                    back();
                    go(away.current);
                  }}
                />
              </Suspense>
            </Boundary>
          ) : showSidebar ? (
            <Boundary key="sidebar" part="the sidebar">
              <Sidebar projects={projects} machinesDown={machinesDown} screen={screen} hub={hub} jumpHints={modHeld} factory={factory} go={go} />
            </Boundary>
          ) : undefined
        }
        aside={chrome && panel.present ? <PanelSlot panel={panel} /> : undefined}
      >
        <div className={s.column}>
          {/* Fixture data must never pass for a live hub. */}
          {window.fleetd.fixture !== null ? (
            <div className={s.fixtureBanner} role="status">
              Sample data, not connected
            </div>
          ) : null}
          {chrome ? <ConnectionBanner /> : null}
          <div className={s.screen}>
            {shown.id === "home" && projects !== undefined && projects.length === 0 ? (
              <div data-screen="home.empty" style={{ display: "contents" }}>
                <GetStarted onAddProject={() => go({ id: "projects.add" })} />
              </div>
            ) : (
              // Keyed by the screen, so going elsewhere after an error opens that screen, not the card.
              <Boundary key={screenPart(shown).key} part={screenPart(shown).words}>
                <ScreenHost screen={shown} />
              </Boundary>
            )}
          </div>
        </div>
      </AppFrame>
      <PaletteHost />
      <ProjectsHost />
      <UpdatesHost />
    </div>
  );
}

/**
 * Focus after Settings' Back: the sidebar control that opened Settings, if that is how it was opened; else the page
 * title, unless the screen gave focus to something itself (the chat's message box). Returns what Back calls first.
 */
function useSettingsBack(inSettings: boolean): () => void {
  // The last element that had focus: by the time Settings shows, its opener has left the DOM.
  const last = useRef<Element | null>(null);
  useEffect(() => {
    const on = (e: FocusEvent) => {
      last.current = e.target instanceof Element ? e.target : null;
    };
    document.addEventListener("focusin", on);
    return () => document.removeEventListener("focusin", on);
  }, []);
  const fromSidebar = useRef(false);
  const returning = useRef(false);
  useEffect(() => {
    if (inSettings) {
      fromSidebar.current = last.current?.closest('[data-opens="settings"]') != null;
      return;
    }
    if (!returning.current) return;
    returning.current = false;
    const frame = requestAnimationFrame(() => {
      const opener = fromSidebar.current ? document.querySelector<HTMLElement>('[data-opens="settings"]') : null;
      if (opener) return opener.focus();
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      const title = document.querySelector<HTMLElement>("main h1, main h2");
      if (title === null) return;
      title.tabIndex = -1;
      title.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [inSettings]);
  return () => {
    returning.current = true;
  };
}

