// The app frame: the sidebar of projects down the left (the macOS traffic lights sit in its top row, over the window's
// translucent material), the top row beside it (the window's drag region, where a chat puts its title), and the
// screen the route names: a project's lead chat, with its agents, PRs and checklist in the panel on the right (panel.tsx), or
// Status, Time or Settings. Navigation is the hash (routes.ts); `#/` opens the project you last had open. With several
// hubs (docs/design/hubs.md) the screen is on its route's hub, inside that hub's scope, and each hub has a watcher
// (HubWatch) always mounted: its sidebar rows, its notifications and its share of the Dock badge.
import { PanelLeft, Search } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import type { HubId } from "../../../shared/hubs";
import { display } from "../../../shared/shortcuts";
import { AppFrame, Button, TopBar } from "../../ui";
import { openPalette, PaletteHost, useCommands, type Command } from "../palette";
import { ProjectsHost } from "../projects";
import { useMetricsSupport } from "../factory/support";
import { useDockBadge, useMainProcess, useMenuState, useModHeld, useNotifications } from "./effects";
import { useHubState } from "./hubFeed";
import { hubKey, HubScope, useData, useDataLayer, useHub, useHubs } from "../../src/data/react";
import { selectNeedsYouTotal } from "../../src/data/selectors";
import type { HubView } from "../../src/data/hubs";
import { homeProject, nextWanting, projectId, routeOf, stepProject, type SidebarProject } from "./model";
import { useSidebarProjects } from "./data";
import { dropRows, publishRows, useHubRows } from "./hubRows";
import { navigate, setRouteHubs, useRoute, type Routed } from "./navigation";
import { PANEL_TABS, served } from "../panel/tabs";
import { inSections, sectionsFor } from "../panel/Sections";
import { isNavi, sidebarOrder } from "../navi/model";
import { HOME, listView, panelRoute, type ProjectKey, type Screen } from "./routes";
import { PanelSlot, PanelToggle, useProjectPanel } from "./panel";
import { ConnectionBanner, needsOnboarding } from "../onboarding";
import { UpdatesHost } from "../updates";
import { useUpdatesHub } from "../updates/state";
import { Boundary } from "../../src/Boundary";
import { ScreenHost, screenPart } from "./screens";
import { Sidebar } from "./Sidebar";
import { shownRows, useCollapsedHubs, useSidebar } from "./sidebarState";
import { useAdministers } from "../admin/role";
import s from "./shell.module.css";

const platform = window.fleetd.platform;

const JUMPS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

// Settings' own sidebar takes the projects' place while Settings is open; it ships in Settings' chunk.
const SettingsSidebar = lazy(() => import("../settings/SettingsScreen").then((m) => ({ default: m.SettingsSidebar })));
// The empty home: setup's welcome for an admin while a required step is left, else Get started.
const FirstRun = lazy(() => import("../setup/FirstRun").then((m) => ({ default: m.FirstRun })));

/** The project `#/` opens, kept across launches: the app opens where you left it. */
const LAST_PROJECT = "fleetd.lastProject";
const readLast = (): string | null => {
  try {
    return window.localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
};

/** A sidebar row with its hub: its key is the hub's (hubKey), so rows of two hubs never collide. */
export type Placed = SidebarProject & { readonly hub: HubId };

export function Shell() {
  const hubs = useHubs();
  const sidebar = useSidebar();
  setRouteHubs(hubs.map((h) => h.id));
  const route = useRoute();
  // `#/` opens the last project, which may be on another hub than the route's: the screen goes on that project's hub,
  // so the frame, its chat and every read are that hub's, before the redirect names it and after, if it never lands.
  const placed = usePlaced(hubs, route.at);
  const homeRow = route.id === "home" && placed !== undefined ? homeProject(placed, readLast()) : null;
  const at = homeRow?.hub ?? route.at;
  const hub = hubs.find((h) => h.id === at) ?? hubs[0];
  // The project on screen, the same object while it is the same project: each hub's watcher reads by it.
  const homeOpen = useMemo(() => (homeRow === null ? null : routeOf(homeRow)), [homeRow?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (hub === undefined) return null;
  const open = route.id === "project" || route.id === "session" ? route.project : homeRow?.hub === hub.id ? homeOpen : null;
  // Keyed by the hub: a query keeps the client it was made with, so what is on screen starts afresh on another hub
  // rather than reading the one before. The sidebar's shown or hidden is the window's, not a hub's.
  return (
    <HubScope key={hub.id} hub={hub}>
      {hubs.map((h) => (
        <HubScope key={h.id} hub={h}>
          <HubWatch open={h.id === hub.id ? open : null} />
        </HubScope>
      ))}
      <Frame route={{ ...route, at: hub.id }} hubs={hubs} sidebar={sidebar} />
    </HubScope>
  );
}

/**
 * One hub's always-on work, inside its scope: its sidebar rows and needs-you count for the frame (hubRows.ts), and its
 * notifications. The chat on screen is the frame's to open.
 */
function HubWatch({ open }: { open: ProjectKey | null }) {
  const { id } = useHub();
  const state = useHubState();
  const projects = useSidebarProjects(open);
  const needsYou = useData(selectNeedsYouTotal);
  useEffect(() => publishRows(id, { projects, needsYou, state }), [id, projects, needsYou, state]);
  useEffect(() => () => dropRows(id), [id]);
  useNotifications(state.phase === "live");
  return null;
}

/**
 * Every hub's rows in sidebar order, undefined while the screen's own hub's are loading: the Navis of every hub first,
 * then each hub's projects (navi/model.ts's sidebarOrder over them all).
 */
const usePlaced = (hubs: readonly HubView[], on: HubId): ReadonlyArray<Placed> | undefined => {
  const rows = useHubRows();
  return useMemo(() => {
    if (rows.get(on)?.projects === undefined) return undefined;
    return sidebarOrder(hubs.flatMap((h) => (rows.get(h.id)?.projects ?? []).map((p): Placed => ({ ...p, key: hubKey(h.id, p.key), hub: h.id }))));
  }, [rows, hubs, on]);
};

function Frame({ route, hubs, sidebar }: { route: Routed; hubs: readonly HubView[]; sidebar: ReturnType<typeof useSidebar> }) {
  const hub = useHubState();
  const features = useData((st) => st.features);
  const rows = useHubRows();
  const projects = usePlaced(hubs, route.at);
  // ⌘1–9 open the rows the sidebar numbers: those on show, a collapsed hub's left out.
  const [collapsed, toggleHub] = useCollapsedHubs();
  const onShow = projects === undefined ? undefined : shownRows(projects, collapsed, hubs.length > 1);
  const modHeld = useModHeld();

  useMainProcess();
  useMenuState();
  useDockBadge();

  // `#/` is the last project once the projects are known: shown as that project at once, and the URL follows (replace,
  // so Back doesn't return to the bare `#/`). It is shown from `home`, not from the replaced URL: a hash set back to
  // `#/` before React reads the replace leaves the hash snapshot unchanged, so nothing would render or redirect again.
  const homeRow = route.id === "home" && projects !== undefined ? homeProject(projects, readLast()) : null;
  const home: Screen | null = homeRow === null ? null : { id: "project", project: routeOf(homeRow), message: null, at: homeRow.hub };
  const screen: Screen = useMemo(
    () =>
      home !== null
        ? home
        : // A session's own window's route, here: its project, with the session in the panel.
          route.id === "session"
          ? { id: "project", project: route.project, message: null, panel: { tab: "sessions", session: route.session }, at: route.at }
          : route,
    // `home` is rebuilt each render; its row's key says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [route, homeRow?.key],
  );
  useEffect(() => {
    if (home !== null) navigate(home, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeRow?.key]);
  // Where Settings' Back returns: the last screen before it.
  const away = useRef<Screen>(HOME);
  useEffect(() => {
    if (screen.id !== "settings" && screen.id !== "onboarding") away.current = screen;
  }, [screen]);
  const back = useSettingsBack(screen.id === "settings");
  const administers = useAdministers();

  const open = screen.id === "project" ? screen.project : null;
  // The open project's row key: the hub's own key, prefixed with the hub unless it is the first (hubKey).
  const openKey = open === null ? null : hubKey(route.at, projectId(open));
  // The chat on screen is the one open, and the one that streams: the screen as shown, `#/` resolved to its project
  // (the route alone can still say home). The frame is its hub's, so leaving the hub closes it.
  const layer = useDataLayer();
  const chatKey = open === null ? null : projectId(open);
  useEffect(() => {
    if (chatKey === null) {
      layer.chat.close();
      return;
    }
    layer.chat.open(chatKey);
  }, [layer, chatKey]);
  useEffect(() => () => layer.chat.close(), [layer]);
  // The palette's Agents and Pull requests: the project on screen, else the one `#/` opens on this hub.
  const homeHere = projects === undefined ? null : homeProject(projects.filter((p) => p.hub === route.at), readLast());
  const panelProject = open ?? (homeHere === null ? null : routeOf(homeHere));
  // A Navi's panel has its own views: the palette's Go to offers only those a panel for it shows.
  // From the screen's hub's every project, archived Navis too: an archived Navi still open gets a Navi's views, never a
  // code project's.
  const panelKey = panelProject === null ? null : projectId(panelProject);
  const panelNavi = useData((st) => (panelKey === null ? undefined : st.projects[panelKey]));
  const panelSections = sectionsFor(panelNavi !== undefined && isNavi(panelNavi), features);
  const panel = useProjectPanel(screen);
  useEffect(() => {
    if (openKey === null) return;
    try {
      window.localStorage.setItem(LAST_PROJECT, openKey);
    } catch {
      // Without storage the app opens on the first project instead; nothing else depends on it.
    }
  }, [openKey]);

  // Before pairing, after a refused key, or on a hub of another protocol there is nothing to navigate; the
  // onboarding screen has the window to itself. With several hubs, only when none of them can be used: one with a
  // refused key says so in its own status row.
  const blocked = hubs.every((h) => {
    const state = h.id === route.at ? hub : rows.get(h.id)?.state;
    return state === undefined || needsOnboarding(state);
  });
  const onboarding = blocked || screen.id === "onboarding";
  const shown: Screen = blocked && screen.id !== "onboarding" ? { id: "onboarding", hub: null, code: null } : screen;
  const chrome = !onboarding;

  const go = (next: Screen) => navigate(next);
  const goTo = (p: Placed) => go({ id: "project", project: routeOf(p), message: null, at: p.hub });
  const step = (by: 1 | -1) => {
    const next = projects === undefined ? null : stepProject(projects, openKey, by);
    if (next !== null) goTo(next);
  };

  // A hub from before metrics has no Factory output: its menu item, command and shortcut go, and the sidebar's Factory
  // opens on Agent time (factory/support.ts).
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
      {
        id: "hub.people",
        title: "People",
        detail: "Settings › Hub: who is on this hub, their roles, invites and hub links",
        group: "go-to",
        keywords: ["people", "invite", "team", "roles", "admin", "administration", "hub"],
        enabled: () => chrome && administers,
        run: () => go({ id: "settings", tab: "hub.people" }),
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
        enabled: () => chrome && projects !== undefined && nextWanting(projects, openKey) !== null,
        run: () => {
          const next = projects === undefined ? null : nextWanting(projects, openKey);
          if (next !== null) goTo(next);
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
          enabled: () => chrome && panelProject !== null && served(tab.id, features) && inSections(tab.id, panelSections),
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
          enabled: () => chrome && onShow?.[n - 1] !== undefined,
          run: () => {
            const p = onShow?.[n - 1];
            if (p !== undefined) goTo(p);
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
          // The shortcut is the label: the key you learn, not a word to read every time.
          <Button variant="quiet" icon={<Search />} shortcut={display("palette.toggle", platform)} aria-label="Commands" title="Commands" onClick={() => openPalette()} />
        ) : undefined
      }
    />
  );

  return (
    <div className={s.root} data-screen="shell">
      <AppFrame
        translucent
        topBar={top}
        // At the window's top right, open or closed, so the click that opened the panel closes it in the same place.
        corner={chrome && panel.project !== null ? <PanelToggle panel={panel} /> : undefined}
        sidebarTop={settings ? undefined : toggle}
        sidebar={
          !chrome ? undefined : settings ? (
            <Boundary key={shown.id} part="the sidebar">
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
              <Sidebar projects={projects} screen={{ ...screen, at: route.at }} jumpHints={modHeld} collapsed={collapsed} onToggleHub={toggleHub} factory={factory} admin={administers} go={go} />
            </Boundary>
          ) : undefined
        }
        aside={chrome && panel.shown ? <PanelSlot panel={panel} /> : undefined}
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
                <Suspense fallback={null}>
                  <FirstRun onAddProject={() => go({ id: "projects.add" })} />
                </Suspense>
              </div>
            ) : (
              // Keyed by the screen, so going elsewhere after an error opens that screen, not the card.
              <Boundary key={`${route.at}:${screenPart(shown).key}`} part={screenPart(shown).words}>
                <ScreenHost screen={shown} />
              </Boundary>
            )}
          </div>
        </div>
      </AppFrame>
      <PaletteHost />
      <ProjectsHost />
      <UpdatesOf hubs={hubs} on={route.at} />
    </div>
  );
}

/** The updates sheet of the hub whose status row opened it, else of the screen's hub. */
function UpdatesOf({ hubs, on }: { hubs: readonly HubView[]; on: HubId }) {
  const from = useUpdatesHub();
  const hub = hubs.find((h) => h.id === from) ?? hubs.find((h) => h.id === on);
  return hub === undefined ? null : (
    <HubScope key={hub.id} hub={hub}>
      <UpdatesHost />
    </HubScope>
  );
}

/**
 * Focus after Settings' Back: the sidebar control that opened it, if that is how it was opened; else the page title,
 * unless the screen gave focus to something itself (the chat's message box). Returns what Back calls first.
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
  // The sidebar control that opened it, by its data-opens; null when it was opened some other way.
  const fromSidebar = useRef<string | null>(null);
  const returning = useRef(false);
  useEffect(() => {
    if (inSettings) {
      fromSidebar.current = last.current?.closest('[data-opens="settings"]')?.getAttribute("data-opens") ?? null;
      return;
    }
    if (!returning.current) return;
    returning.current = false;
    const frame = requestAnimationFrame(() => {
      const opener = fromSidebar.current === null ? null : document.querySelector<HTMLElement>(`[data-opens="${fromSidebar.current}"]`);
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

