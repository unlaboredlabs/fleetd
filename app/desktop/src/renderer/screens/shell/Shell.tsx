// The app frame: the sidebar of projects down the left (the macOS traffic lights sit in its top row, over the window's
// translucent material), the top row beside it (the window's drag region, where a chat puts its title), and the
// screen the route names: a project's lead chat, or Status, Time or Settings. Navigation is the hash (routes.ts);
// `#/` opens the project you last had open.
import { PanelLeft, Search } from "lucide-react";
import { useEffect, useMemo } from "react";
import { display } from "../../../shared/shortcuts";
import { AppFrame, Button, TopBar } from "../../ui";
import { openPalette, PaletteHost, useCommands, type Command } from "../palette";
import { ProjectsHost } from "../projects";
import { useDockBadge, useMainProcess, useMenuState, useModHeld, useNotifications } from "./effects";
import { useHubState } from "./hubFeed";
import { useDataLayer } from "../../src/data/react";
import { homeProject, projectId, stepProject } from "./model";
import { useMachinesDown, useSidebarProjects } from "./data";
import { navigate, useRoute } from "./navigation";
import type { Screen } from "./routes";
import { ConnectionBanner, GetStarted, needsOnboarding } from "../onboarding";
import { ScreenHost } from "./screens";
import { Sidebar } from "./Sidebar";
import { useSidebar } from "./sidebarState";
import s from "./shell.module.css";

const platform = window.fleetd.platform;

const JUMPS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

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
  const sidebar = useSidebar();
  const modHeld = useModHeld();

  useMainProcess();
  useMenuState();
  useNotifications(hub?.phase === "live");
  useDockBadge();

  // `#/` is the last project once the projects are known: shown as that project at once, and the URL follows (replace,
  // so Back doesn't return to the bare `#/`). It is shown from `home`, not from the replaced URL: a hash set back to
  // `#/` before React reads the replace leaves the hash snapshot unchanged, so nothing would render or redirect again.
  const home = route.id === "home" && projects !== undefined ? homeProject(projects, readLast()) : null;
  const screen: Screen = useMemo(() => (home === null ? route : { id: "project", project: home, message: null }), [route, home]);
  useEffect(() => {
    if (home !== null) navigate({ id: "project", project: home, message: null }, { replace: true });
  }, [home]);

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
      { id: "sidebar.toggle", title: "Toggle sidebar", group: "actions", enabled: () => chrome, run: sidebar.toggle },
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
  const showSidebar = chrome && !sidebar.hidden;

  const top = (
    <TopBar
      leading={chrome && !showSidebar ? toggle : undefined}
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
        translucent
        topBar={top}
        sidebarTop={toggle}
        sidebar={showSidebar ? <Sidebar projects={projects} machinesDown={machinesDown} screen={screen} hub={hub} jumpHints={modHeld} go={go} /> : undefined}
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
