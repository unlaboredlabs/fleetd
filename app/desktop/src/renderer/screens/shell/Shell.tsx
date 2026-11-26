// The app frame: the sidebar of projects flush down the left, its own soft tone (the macOS traffic lights sit in its
// top row, over the window's translucent material), the top row floating over the screen beside it (the window's drag
// region, where a chat floats its pill as glass: its picture and name, which opens the panel), and the screen the
// route names: a project's lead chat, with its agents, PRs and checklist in the panel on the right (panel.tsx), or
// Status, Time or Settings. Navigation is the hash (routes.ts); `#/` opens the project you last had open. With several
// hubs the screen is on its route's hub, inside that hub's scope, and each hub has a watcher
// (HubWatch) always mounted: its sidebar rows, its notifications and its share of the Dock badge. The sidebar and the
// panel have no toggle icon: ⌘B, ⌥⌘B, the View menu and the palette show and hide them, and the chat's pill opens
// the panel too. ⌘K, not a button, opens the palette.
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { HubId } from "../../../shared/hubs";
import { AppFrame, preloadable, preloadWhenIdle, TopBar, useShownYet } from "../../ui";
import { PaletteHost, useCommands, type Command } from "../palette";
import { NewBot, ProjectsHost } from "../projects";
import { ConnectionsHost } from "../connections/ConnectionsHost";
import { useMetricsSupport } from "../factory/support";
import { useDockBadge, useMainProcess, useMenuState, useModHeld, useNotifications } from "./effects";
import { useHubState } from "./hubFeed";
import { hubKey, HubScope, useData, useDataLayer, useHub, useHubs } from "../../src/data/react";
import { selectNeedsYouTotal } from "../../src/data/selectors";
import type { HubView } from "../../src/data/hubs";
import { homeProject, nextWanting, projectId, routeOf, stepProject, type SidebarProject } from "./model";
import { useSidebarProjects } from "./data";
import { dropRows, publishRows, useHubRows } from "./hubRows";
import { navigate, setRouteHubs, useNamesHub, useRoute, type Routed } from "./navigation";
import { PANEL_TABS, served } from "../panel/tabs";
import { HOME, listView, panelRoute, toHash, type ProjectKey, type Screen } from "./routes";
import { PanelHandleProvider, PanelSlot, useProjectPanel } from "./panel";
import { ConnectionBanner, needsOnboarding } from "../onboarding";
import { RestartLine, UpdatesHost } from "../updates";
import { Boundary } from "../../src/Boundary";
import { preloadScreens, ScreenHost, screenPart, SettingsSheet } from "./screens";
import { Sidebar, SidebarTop } from "./Sidebar";
import { useHeldRows, useSidebar } from "./sidebarState";
import { showHub, shownRows, unfold, useFolded, useSidebarView, viewedHub } from "./sidebarLayout";
import { useSidebarWidth } from "./sidebarWidth";
import { switchHubBy } from "./hubSwipe";
import { SidebarEdge } from "./ResizeEdge";
import { arranged } from "./pins";
import { useAdministers } from "../admin/role";
import s from "./shell.module.css";
import { onWeb } from "../../src/web";

// The banner over a hub that moved to fleetd cloud (rare): it brings the move's sheet and Settings' parts, so it is a
// chunk of its own, asked for at once on the desktop and once the first chat has shown on the web.
const MovedBanner = preloadable(() => import("../admin/MoveToCloud").then((m) => m.MovedBanner));
if (onWeb()) preloadWhenIdle(MovedBanner);
else MovedBanner.preload().catch(() => undefined);
/** On the web, the banner mounts once the first chat has shown (or this long), so it never shares the first load. */
const MOVED_AFTER_CHAT_MAX_MS = 30_000;

const JUMPS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

// The empty home: setup's welcome for an admin while a required step is left, else Get started.
const FirstRun = lazy(() => import("../setup/FirstRun").then((m) => ({ default: m.FirstRun })));

/** The project `#/` opens, kept across launches: the app opens where you left it. */
const LAST_PROJECT = "fleetd.lastProject";
/** Each hub's last chat, kept across launches: a hub's home, which switching to it opens (W794). */
const LAST_CHATS = "fleetd.lastChats";
const lastChats = (): Record<string, unknown> => {
  const v: unknown = JSON.parse(window.localStorage.getItem(LAST_CHATS) ?? "{}");
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
};
/**
 * The last chat opened (its row key): on `hub`, else on any. A hub's own is only ever its own, never one kept on another
 * hub or account; the home it opens is matched against the hub's own bots all the same (homeProject).
 */
const readLast = (hub?: HubId): string | null => {
  try {
    if (hub === undefined) return window.localStorage.getItem(LAST_PROJECT);
    const own = lastChats()[hub];
    return typeof own === "string" ? own : null;
  } catch {
    return null;
  }
};
const keepLast = (hub: HubId, key: string): void => {
  window.localStorage.setItem(LAST_PROJECT, key);
  let kept: Record<string, unknown> = {};
  try {
    kept = lastChats();
  } catch {
    // Unreadable: started again.
  }
  window.localStorage.setItem(LAST_CHATS, JSON.stringify({ ...kept, [hub]: key }));
};

/** A sidebar row with its hub: its key is the hub's (hubKey), so rows of two hubs never collide. */
export type Placed = SidebarProject & { readonly hub: HubId };

export function Shell() {
  const hubs = useHubs();
  const sidebar = useSidebar();
  setRouteHubs(hubs.map((h) => h.id));
  const route = useRoute();
  useEffect(preloadScreens, []);
  // `#/` opens the last project, which may be on another hub than the route's: the screen goes on that project's hub,
  // so the frame, its chat and every read are that hub's, before the redirect names it and after, if it never lands.
  // A home that names its hub stays on it, even when the last project is another hub's.
  const named = useNamesHub();
  const placed = usePlaced(hubs, route.at);
  const homes = named ? placed?.filter((p) => p.hub === route.at) : placed;
  const homeRow = route.id === "home" && homes !== undefined ? homeProject(homes, readLast(named ? route.at : undefined)) : null;
  const at = homeRow?.hub ?? route.at;
  // Under Settings the app stays on the hub it was on, whichever hub the sheet is on (it has that hub's scope): a
  // switch of the hub a Hub page manages never remounts the frame, and the sheet in it, as the other hub's.
  const [under, setUnder] = useState(at);
  if (route.id !== "settings" && under !== at) setUnder(at);
  const hub = hubs.find((h) => h.id === (route.id === "settings" ? under : at)) ?? hubs.find((h) => h.id === at) ?? hubs[0];
  // The project on screen, the same object while it is the same project: each hub's watcher reads by it.
  const homeOpen = useMemo(() => (homeRow === null ? null : routeOf(homeRow)), [homeRow?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Where closing Settings returns: the last route before it, on its hub. Kept here, outside the hub's frame, so
  // Settings opened on another hub (a bot's settings in List, a Hub page's hub) still returns to the chat it left.
  const [away, setAway] = useState<Screen>(HOME);
  const left: Screen = { ...route, at };
  if (route.id !== "settings" && route.id !== "onboarding" && toHash(left) !== toHash(away)) setAway(left);
  const view = useSidebarView();
  if (hub === undefined) return null;
  const sheetHub = hubs.find((h) => h.id === route.at) ?? hub;
  const open = route.id === "project" || route.id === "session" ? route.project : homeRow?.hub === hub.id ? homeOpen : null;
  // Keyed by the hub: a query keeps the client it was made with, so what is on screen starts afresh on another hub
  // rather than reading the one before. The sidebar's shown or hidden is the window's, not a hub's. New bot is outside
  // it, on the hub on view unless it picks another: neither its Adds to nor the bot it opens on another hub remounts it.
  return (
    <>
      <HubScope key={hub.id} hub={hub}>
        {hubs.map((h) => (
          <HubScope key={h.id} hub={h}>
            <HubWatch open={h.id === hub.id ? open : null} />
          </HubScope>
        ))}
        <Frame route={{ ...route, at: hub.id }} away={away} hubs={hubs} sidebar={sidebar} sheetHub={sheetHub} />
      </HubScope>
      <NewBot on={viewedHub(view, hubs, hub.id)} />
    </>
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
 * Every hub's rows in sidebar order, undefined while the screen's own hub's are loading: each hub's projects, hub after
 * hub, in your order of them.
 */
const usePlaced = (hubs: readonly HubView[], on: HubId): ReadonlyArray<Placed> | undefined => {
  const rows = useHubRows();
  // While the pointer is over the sidebar's list, its rows keep their places (sidebarState.ts holdRows).
  const held = useHeldRows();
  return useMemo(() => {
    if (rows.get(on)?.projects === undefined) return undefined;
    return hubs.flatMap((h) => {
      const placed = (rows.get(h.id)?.projects ?? []).map((p): Placed => ({ ...p, key: hubKey(h.id, p.key), hub: h.id }));
      if (held === null) return placed;
      // Each hub's rows come in their order: the pins, the chats in none of your sections, then section by section.
      const sections = [...new Set(placed.flatMap((p) => (p.pinned || p.section === undefined ? [] : [p.section])))];
      return arranged(placed, placed.filter((p) => p.pinned).map((p) => p.key), held, sections);
    });
  }, [rows, hubs, on, held]);
};

function Frame({ route, away, hubs, sidebar, sheetHub }: { route: Routed; away: Screen; hubs: readonly HubView[]; sidebar: ReturnType<typeof useSidebar>; sheetHub: HubView }) {
  const hub = useHubState();
  const features = useData((st) => st.features);
  // A restart's held view (data/store.ts RESTART_HOLD_MS): what shows is as it was, so it steps back a little.
  const held = useData((st) => st.fresh && st.hub.phase !== "live");
  const rows = useHubRows();
  const projects = usePlaced(hubs, route.at);
  // ⌘1–9 open the rows the sidebar numbers: those on show (sidebarLayout.ts), in its order.
  const view = useSidebarView();
  const viewHub = viewedHub(view, hubs, route.at);
  const folded = useFolded();
  const onShow = useMemo(() => (projects === undefined ? undefined : shownRows(projects, view, viewHub, folded)), [projects, view, viewHub, folded]);
  // A bot opened on another hub (the palette, a notification) brings its hub on show.
  useEffect(() => showHub(route.at), [route.at]);
  const modHeld = useModHeld();
  const [sidebarPx, setSidebarPx] = useSidebarWidth();

  useMainProcess();
  useMenuState();
  useDockBadge();

  // `#/` is the last project once the projects are known: shown as that project at once, and the URL follows (replace,
  // so Back doesn't return to the bare `#/`). It is shown from `home`, not from the replaced URL: a hash set back to
  // `#/` before React reads the replace leaves the hash snapshot unchanged, so nothing would render or redirect again.
  // Settings is a sheet over the app: under it stays the screen it opened from (the home chat, on a link to it), when
  // that is on this hub; opened on another hub, this hub's own home chat, never another hub's in this hub's frame.
  // Where closing it returns is `away` (Shell), the last route before it.
  const sheet = route.id === "settings";
  const beneath = away.at === undefined || away.at === route.at ? away : HOME;
  const base = sheet ? { ...beneath, at: route.at } : route;
  const named = useNamesHub();
  const own = sheet || named;
  const homeRow = base.id === "home" && projects !== undefined ? homeProject(own ? projects.filter((p) => p.hub === route.at) : projects, readLast(own ? route.at : undefined)) : null;
  const home: Screen | null = homeRow === null ? null : { id: "project", project: routeOf(homeRow), message: null, at: homeRow.hub };
  const screen: Screen = useMemo(
    () =>
      home !== null
        ? home
        : // A session's own window's route, here: its project, with the session in the panel.
          base.id === "session"
          ? { id: "project", project: base.project, message: null, panel: { tab: "sessions", session: base.session }, at: route.at }
          : base,
    // `home` is rebuilt each render; its row's key says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [route, homeRow?.key],
  );
  useEffect(() => {
    if (home !== null && !sheet) navigate(home, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeRow?.key]);
  const back = useSettingsBack(sheet);
  const administers = useAdministers();

  const open = screen.id === "project" ? screen.project : null;
  // The open project's row key: the hub's own key, prefixed with the hub unless it is the first (hubKey).
  const openKey = open === null ? null : hubKey(route.at, projectId(open));
  // The chat on screen is the one open, and the one that streams: the screen as shown, `#/` resolved to its project
  // (the route alone can still say home). The frame is its hub's, so leaving the hub closes it.
  const layer = useDataLayer();
  const chatKey = open === null ? null : projectId(open);
  // A bot this hub doesn't list never opens: an address or link kept from another workspace or account (a new
  // person's first screen, W890) goes to this hub's home instead, Get started on one with no bot yet. One the hub
  // listed while it was open and no longer does was removed: its chat says so, with a way back (ChatScreen).
  const listed = useData((st) => chatKey !== null && chatKey in st.projects);
  const fresh = useData((st) => st.fresh);
  const [seen, setSeen] = useState<string | null>(null);
  if (listed && seen !== chatKey) setSeen(chatKey);
  const gone = chatKey !== null && fresh && !listed;
  const stray = gone && seen !== chatKey;
  useEffect(() => {
    if (stray && !sheet) navigate({ id: "home", at: route.at }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stray]);
  const streamed = stray ? null : chatKey;
  // At commit, not after the paint: its first read (chat_history) is on the way to the chat's rows.
  useLayoutEffect(() => {
    if (streamed === null) {
      layer.chat.close();
      return;
    }
    layer.chat.open(streamed);
  }, [layer, streamed]);
  useEffect(() => () => layer.chat.close(), [layer]);
  // The palette's Agents and Pull requests: the project on screen, else the one `#/` opens on this hub.
  const homeHere = projects === undefined ? null : homeProject(projects.filter((p) => p.hub === route.at), readLast(route.at));
  const panelProject = open ?? (homeHere === null ? null : routeOf(homeHere));
  const panel = useProjectPanel(screen);
  // What shows under the Settings sheet isn't a chat you opened: it never becomes the one `#/` opens.
  useEffect(() => {
    if (openKey === null || sheet || !listed) return;
    try {
      keepLast(route.at, openKey);
    } catch {
      // Without storage the app opens on the first project instead; nothing else depends on it.
    }
  }, [openKey, sheet, route.at, listed]);
  // A chat opened in a folded section (a notification, ⌘K, a hub's last chat) unfolds it, so it shows where it lives:
  // once each time it is opened, so its section folded while it is open stays folded.
  const openRow = openKey === null || sheet ? undefined : projects?.find((p) => p.key === openKey);
  const unfoldFor = openRow === undefined || openRow.pinned || openRow.section === undefined ? null : `${openRow.hub}\0${openRow.section}`;
  const unfolded = useRef<string | null>(null);
  useEffect(() => {
    unfolded.current = null;
  }, [openKey]);
  useEffect(() => {
    if (unfoldFor === null || unfoldFor === unfolded.current) return;
    unfolded.current = unfoldFor;
    const [hubId = "", section = ""] = unfoldFor.split("\0");
    unfold(hubId, section);
  }, [openKey, unfoldFor]);

  // Before pairing, after a refused key, or on a hub of another protocol there is nothing to navigate; the
  // onboarding screen has the window to itself. With several hubs, only when none of them can be used: one with a
  // refused key says so in its own status row.
  // On the web the hubs are the account's teams, never unpaired, and a refused one sends the tab to Sign in (src/web).
  const blocked = !onWeb() && hubs.every((h) => {
    const state = h.id === route.at ? hub : rows.get(h.id)?.state;
    return state === undefined || needsOnboarding(state);
  });
  // Get started has the window to itself too: sign-in's column carried on, no sidebar or panel around it.
  const onboarding = blocked || screen.id === "onboarding" || screen.id === "start";
  const shown: Screen = blocked && screen.id !== "onboarding" ? { id: "onboarding", hub: null, code: null } : screen;
  const chrome = !onboarding;
  const movedBanner = useShownYet(MOVED_AFTER_CHAT_MAX_MS) || !onWeb();
  // Settings opens over Get started too, which links to it (Connect Claude): it has the window to itself, not the sheet.
  const settings = sheet && (chrome || screen.id === "start");

  const go = (next: Screen) => navigate(next);
  const goTo = (p: Placed) => go({ id: "project", project: routeOf(p), message: null, at: p.hub });
  const step = (by: 1 | -1) => {
    const next = projects === undefined ? null : stepProject(projects, openKey, by);
    if (next !== null) goTo(next);
  };

  const stepHubs = (by: 1 | -1) => switchHubBy(hubs.map((h) => h.id), viewHub, by);

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
        detail: "Who is on it, their roles and invites",
        group: "go-to",
        keywords: ["people", "invite", "team", "roles", "admin", "administration", "hub"],
        enabled: () => chrome && administers,
        run: () => go({ id: "settings", tab: "hub.people" }),
      },
      { id: "sidebar.toggle", title: "Toggle sidebar", group: "actions", enabled: () => chrome, run: sidebar.toggle },
      { id: "panel.toggle", title: "Toggle the panel", group: "actions", keywords: ["panel", "right", "agents", "prs", "checklist"], enabled: () => chrome && open !== null, run: panel.toggle },
      // With several hubs, the one before or after the one on show, round the ends, on the sidebar's slide.
      { id: "hub.previous", title: "Previous hub", group: "go-to", keywords: ["hub", "switch", "space"], enabled: () => chrome && hubs.length > 1, run: () => stepHubs(-1) },
      { id: "hub.next", title: "Next hub", group: "go-to", keywords: ["hub", "switch", "space"], enabled: () => chrome && hubs.length > 1, run: () => stepHubs(1) },
      { id: "project.previous", title: "Previous bot", group: "projects", searchOnly: true, enabled: () => chrome && (projects?.length ?? 0) > 0, run: () => step(-1) },
      { id: "project.next", title: "Next bot", group: "projects", searchOnly: true, enabled: () => chrome && (projects?.length ?? 0) > 0, run: () => step(1) },
      {
        id: "project.nextNeedsYou",
        title: "Next bot that needs you",
        group: "projects",
        keywords: ["waiting", "reply", "approve", "secret", "blocked"],
        enabled: () => chrome && projects !== undefined && nextWanting(projects, openKey) !== null,
        run: () => {
          const next = projects === undefined ? null : nextWanting(projects, openKey);
          if (next !== null) goTo(next);
        },
      },
      // One per panel tab, from its list: a new tab is in the palette too, once the hub serves it.
      ...PANEL_TABS.filter((tab) => !("itemOnly" in tab)).map(
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
          title: `Open bot ${String(n)} in the sidebar`,
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

  const showSidebar = chrome && !sidebar.hidden;
  // Its width is the frame's variable: a drag moves it on the root alone, and only its end renders the frame again.
  const root = useRef<HTMLDivElement>(null);

  // The chat's conversation scrolls under the top row; every other screen starts below it.
  const under = chrome && shown.id === "project";
  const top = <TopBar />;
  // The chat's pill opens and closes the panel.
  const handle = useMemo(() => ({ shown: panel.shown, toggle: panel.toggle }), [panel.shown, panel.toggle]);

  return (
    <div ref={root} className={s.root} data-screen="shell" style={{ "--sidebar-w": `${String(sidebarPx)}px` } as CSSProperties}>
      <PanelHandleProvider value={handle}>
      <AppFrame
        translucent
        topBar={top}
        under={under}
        sidebarTop={<SidebarTop go={go} hub={viewHub} />}
        sidebarOpen={!sidebar.hidden}
        sidebarEdge={<SidebarEdge root={root} width={sidebarPx} onSet={setSidebarPx} />}
        sidebar={
          !chrome ? undefined : showSidebar ? (
            <Boundary key="sidebar" part="the sidebar">
              <Sidebar projects={projects} shown={onShow} screen={{ ...screen, at: route.at }} jumpHints={modHeld} view={view} hub={viewHub} factory={factory} go={go} />
            </Boundary>
          ) : undefined
        }
        // A removed bot's agents, PRs and plan are gone with it: its chat says so, with no panel beside it.
        aside={chrome && panel.shown && !gone ? <PanelSlot panel={panel} sidebarPx={showSidebar ? sidebarPx : 0} /> : undefined}
        asideOpen={panel.open && !gone}
      >
        <div className={s.column} data-under={under || undefined}>
          {/* Over the chat they float under the top row, as it does, rather than push the conversation down as they
              come and go with the link. */}
          <div className={s.banners} data-floats="">
            {/* Fixture data must never pass for a live hub. */}
            {window.fleetd.fixture !== null ? (
              <div className={s.fixtureBanner} role="status">
                Sample data, not connected
              </div>
            ) : null}
            {chrome ? <RestartLine /> : null}
            {chrome ? <ConnectionBanner /> : null}
            {chrome && movedBanner ? (
              <Suspense fallback={null}>
                <MovedBanner />
              </Suspense>
            ) : null}
          </div>
          <div className={s.screen} data-held={held || undefined}>
            {stray ? null : shown.id === "home" && projects !== undefined && !projects.some((p) => p.hub === route.at) ? (
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
      </PanelHandleProvider>
      {settings ? (
        <Boundary key="settings" part="Settings">
          <Suspense fallback={null}>
            <SettingsSheet
              hub={sheetHub}
              onClose={() => {
                back();
                // Back to the chat it left; from a link straight to Settings, to the chat `#/` opens, by its own URL.
                go(away.id === "home" && beneath === away && home !== null ? home : away);
              }}
            />
          </Suspense>
        </Boundary>
      ) : null}
      <PaletteHost />
      <ProjectsHost />
      <ConnectionsHost />
      <UpdatesOf hubs={hubs} on={route.at} />
    </div>
  );
}

/** Every hub's updates, each followed on its own so its row says its own; the commands are the screen's hub's. */
function UpdatesOf({ hubs, on }: { hubs: readonly HubView[]; on: HubId }) {
  return (
    <>
      {hubs.map((hub) => (
        <HubScope key={hub.id} hub={hub}>
          <UpdatesHost commands={hub.id === on} />
        </HubScope>
      ))}
    </>
  );
}

/**
 * Focus after Settings' Back: the sidebar control that opened it, if that is how it was opened; else the page title,
 * unless the screen gave focus to something itself (the chat's message box). Returns what Back calls first.
 */
function useSettingsBack(inSettings: boolean): () => void {
  // The last element outside the sheet that had focus: by the time Settings shows, its opener has left the DOM, and
  // the sheet, preloaded, may have focused its search in the same commit.
  const last = useRef<Element | null>(null);
  useEffect(() => {
    const on = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-sheet="settings"]') !== null) return;
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
      // Settings opened from the card under your name, which has closed since: your name.
      const opener =
        fromSidebar.current === null
          ? null
          : (document.querySelector<HTMLElement>(`[data-opens="${fromSidebar.current}"]`) ??
            (fromSidebar.current === "settings" ? document.querySelector<HTMLElement>('[data-opens="you"]') : null));
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

