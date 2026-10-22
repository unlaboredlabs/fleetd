// The app frame: the top bar (the window's drag region, the traffic lights inset on macOS), the sidebar of projects,
// and the screen the route names: a project's lead chat, or Status, Time or Settings. Navigation is the hash
// (routes.ts); `#/` opens the project you last had open.
import { PanelLeft, Search } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { display } from "../../../shared/shortcuts";
import { AppFrame, Button, EmptyState, TopBar } from "../../ui";
import { openPalette, PaletteHost, useCommands, type Command } from "../palette";
import { ProjectsHost } from "../projects";
import { useMainProcess, useMenuState, useModHeld, useNotifications } from "./effects";
import { useHubState } from "./hubFeed";
import { useDataLayer } from "../../src/data/react";
import { homeProject, projectId, stepProject } from "./model";
import { useMachinesDown, useSidebarProjects } from "./data";
import { navigate, useRoute } from "./navigation";
import { HOME, type Screen } from "./routes";
import { ConnectionBanner, needsOnboarding } from "../onboarding";
import { ScreenHost } from "./screens";
import { Sidebar } from "./Sidebar";
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
  // The live feed: the board's lanes, which the chat's agent strip reads. The layer is the only caller of hub.live
  // and sends only changes.
  const layer = useDataLayer();
  useEffect(() => {
    layer.setLive({ board: true });
  }, [layer]);
  const hub = useHubState();
  const projects = useSidebarProjects();
  const machinesDown = useMachinesDown();
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const modHeld = useModHeld();

  useMainProcess();
  useMenuState();
  useNotifications(hub?.phase === "live");

  // `#/` is the last project once the projects are known: shown as that project at once, and the URL follows (replace,
  // so Back doesn't return to the bare `#/`). It is shown from `home`, not from the replaced URL: a hash set back to
  // `#/` before React reads the replace leaves the hash snapshot unchanged, so nothing would render or redirect again.
  const home = route.id === "home" && projects !== undefined ? homeProject(projects, readLast()) : null;
  const screen: Screen = useMemo(() => (home === null ? route : { id: "project", project: home, message: null }), [route, home]);
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
  // One chat streams at a time: the one on screen.
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
  const blocked = hub !== null && needsOnboarding(hub);
  const onboarding = blocked || screen.id === "onboarding";
  const shown: Screen = blocked && screen.id !== "gallery" && screen.id !== "onboarding" ? { id: "onboarding", hub: null, code: null } : screen;
  const chrome = !onboarding && shown.id !== "gallery";

  const go = (next: Screen) => navigate(next);
  const step = (by: 1 | -1) => {
    const next = projects === undefined ? null : stepProject(projects, open, by);
    if (next !== null) go({ id: "project", project: next, message: null });
  };

  useCommands(
    [
      { id: "sidebar.toggle", title: "Toggle sidebar", group: "actions", enabled: () => chrome, run: () => setSidebarHidden((h) => !h) },
      { id: "project.previous", title: "Previous project", group: "projects", searchOnly: true, enabled: () => chrome && (projects?.length ?? 0) > 0, run: () => step(-1) },
      { id: "project.next", title: "Next project", group: "projects", searchOnly: true, enabled: () => chrome && (projects?.length ?? 0) > 0, run: () => step(1) },
      ...JUMPS.map(
        (n): Command => ({
          id: `project.open.${String(n)}`,
          title: `Open project ${String(n)} in the sidebar`,
          group: "projects",
          searchOnly: true,
          enabled: () => chrome && projects?.[n - 1] !== undefined,
          run: () => {
            const p = projects?.[n - 1];
            if (p !== undefined) go({ id: "project", project: p.key, message: null });
          },
        }),
      ),
    ],
    [],
  );

  const top = (
    <TopBar
      leading={
        chrome && shown.id !== "settings" ? (
          <Button
            variant="quiet"
            iconOnly
            aria-label={sidebarHidden ? "Show the sidebar" : "Hide the sidebar"}
            title={`${sidebarHidden ? "Show" : "Hide"} the sidebar (${display("sidebar.toggle", platform)})`}
            aria-pressed={!sidebarHidden}
            onClick={() => setSidebarHidden((h) => !h)}
          >
            <PanelLeft />
          </Button>
        ) : undefined
      }
      trailing={
        chrome ? (
          <Button variant="quiet" icon={<Search />} shortcut={display("palette.toggle", platform)} onClick={() => openPalette()}>
            Commands
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <div className={s.root} data-screen="shell">
      <AppFrame
        topBar={top}
        sidebar={
          !chrome ? undefined : shown.id === "settings" ? (
            // Settings' pages are in it, so it stays while Settings is open.
            <Suspense fallback={null}>
              <SettingsSidebar
                onBack={() => {
                  back();
                  go(away.current);
                }}
              />
            </Suspense>
          ) : sidebarHidden ? undefined : (
            <Sidebar projects={projects} machinesDown={machinesDown} screen={screen} hub={hub} jumpHints={modHeld} go={go} />
          )
        }
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
                <EmptyState
                  title="Add a project to chat with its lead"
                  actions={
                    <Button variant="primary" onClick={() => go({ id: "projects.add" })}>
                      Add a project
                    </Button>
                  }
                >
                  Each project has a lead. Tell it what you want; it runs the agents and asks you only what it needs.
                </EmptyState>
              </div>
            ) : (
              <ScreenHost screen={shown} />
            )}
          </div>
        </div>
      </AppFrame>
      <PaletteHost />
      <ProjectsHost />
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

