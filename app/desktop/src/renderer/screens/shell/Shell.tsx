// The app frame: the top bar (the window's drag region, the traffic lights inset on macOS), the sidebar, the screen
// the route names, the inbox panel and the strips along the bottom. Navigation is the hash (routes.ts).
import { PanelLeft, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { display } from "../../../shared/shortcuts";
import { AppFrame, Button, TopBar } from "../../ui";
import { useAsksLoad, useNeedsYouSource } from "../inbox";
import { openPalette, PaletteHost, useCommands, type Command } from "../palette";
import { ProjectsHost } from "../projects";
import { quietNow, useEscape, useMainProcess, useMenuState, useModHeld, useNotifications } from "./effects";
import { postDigest, useStatusDigest } from "../status/digest";
import { useHubState } from "./hubFeed";
import { InboxPanel } from "./InboxPanel";
import { leadLaneId, selectBoard, selectInbox, selectMachines, selectNeedsYouCount, selectProjects } from "../../src/data/selectors";
import { useData, useDataLayer } from "../../src/data/react";
import { Seen, sidebarOrders, toShellData, type ShellData } from "./model";
import { navigate, useRoute } from "./navigation";
import type { Route, Screen } from "./routes";
import { ConnectionBanner, needsOnboarding } from "../onboarding";
import { ScreenHost, StripsBody } from "./screens";
import { Sidebar } from "./Sidebar";
import s from "./shell.module.css";

const platform = window.fleetd.platform;

/** The frame's view data, from the data layer: recomputed only when one of its inputs changed. */
const useShellData = (): ShellData => {
  const projects = useData(selectProjects);
  const board = useData(selectBoard);
  const inbox = useData(selectInbox);
  const machines = useData(selectMachines);
  const lanes = useData((s) => s.live.lanes);
  return useMemo(
    () =>
      toShellData(
        { projects, board, inbox, machines, leadStatus: (key) => lanes[leadLaneId(key)]?.status },
        // A finished order drops off when the data next changes, not on a timer, so nothing repaints while idle;
        // the clock is read once per data change, which is the point of the memo.
        // eslint-disable-next-line react-hooks/purity
        Date.now(),
      ),
    [projects, board, inbox, machines, lanes],
  );
};

const JUMPS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export function Shell() {
  const route = useRoute();
  // The live feed follows the route: an open order gets its lanes and its lead's text, every other screen the
  // board's (the strips and Machines read it). The layer is the only caller of hub.live and sends only changes.
  const layer = useDataLayer();
  const liveFocus = route.screen.id === "order" ? route.screen.orderId : undefined;
  useEffect(() => {
    layer.setLive(liveFocus === undefined ? { board: true } : { focus: liveFocus });
  }, [layer, liveFocus]);
  const hub = useHubState();
  const data = useShellData();
  // Undefined until this connection's asks loaded: a "0" then would claim nothing needs you.
  const needsYou = useData(selectNeedsYouCount);
  // Only while they are on their way: with the hub unreachable or refusing, nothing is coming, so no skeleton.
  // A failed read is not "loading": the badge goes back to plain "Inbox" (the count is unknown) and the panel says why.
  const asksFailed = useAsksLoad().error !== undefined;
  const countLoading = needsYou === undefined && !asksFailed && (hub?.phase === "live" || hub?.phase === "connecting");
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [seen] = useState(() => new Seen());
  const modHeld = useModHeld();

  useMainProcess();
  useMenuState();
  useNotifications(hub?.phase === "live");
  useStatusDigest(postDigest, quietNow);
  useEscape(route);
  useNeedsYouSource();

  // What was there when the app connected counts as seen; a project you open is seen up to now.
  if (data.projects !== undefined) seen.prime(data.projects);
  const screen = route.screen;
  useEffect(() => {
    if (screen.id !== "board" || screen.project === null) return;
    const key = screen.project;
    const open = data.projects?.find((p) => p.key.machineId === key.machineId && p.key.projectId === key.projectId);
    if (open !== undefined) seen.mark(open.key, open.lastActivityAt);
  }, [screen, data.projects, seen]);

  // Before pairing, after a refused key, or on a hub of another protocol there is nothing to navigate; the
  // onboarding screen has the window to itself.
  const blocked = hub !== null && needsOnboarding(hub);
  const onboarding = blocked || screen.id === "onboarding";
  const shown: Screen = blocked && screen.id !== "gallery" && screen.id !== "onboarding" ? { id: "onboarding", hub: null, code: null } : screen;
  const chrome = !onboarding && shown.id !== "gallery";

  const go = (next: Screen) => navigate({ screen: next, inbox: route.inbox });
  const setInbox = (inbox: Route["inbox"]) => navigate({ ...route, inbox }, { replace: inbox === null });
  const orders = sidebarOrders(data.projects);

  useCommands(
    [
      { id: "sidebar.toggle", title: "Toggle sidebar", group: "actions", enabled: () => chrome, run: () => setSidebarHidden((h) => !h) },
      {
        id: "inbox.toggle",
        title: "Inbox",
        detail: "What needs you",
        group: "go-to",
        keywords: ["needs you", "questions", "asks"],
        enabled: () => chrome,
        run: () => setInbox(route.inbox === null ? { askId: null } : null),
      },
      ...JUMPS.map(
        (n): Command => ({
          id: `order.open.${String(n)}`,
          title: `Open order ${String(n)} in the sidebar`,
          group: "orders",
          searchOnly: true,
          enabled: () => chrome && orders[n - 1] !== undefined,
          run: () => {
            const id = orders[n - 1];
            if (id !== undefined) go({ id: "order", orderId: id, at: null });
          },
        }),
      ),
    ],
    [],
  );

  const top = (
    <TopBar
      leading={
        chrome ? (
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
          <>
            <Button
              variant={needsYou !== undefined && needsYou > 0 ? "secondary" : "quiet"}
              className={needsYou !== undefined && needsYou > 0 ? s.needsYou : undefined}
              aria-busy={countLoading}
              shortcut={display("inbox.toggle", platform)}
              aria-pressed={route.inbox !== null}
              onClick={() => setInbox(route.inbox === null ? { askId: null } : null)}
            >
              {countLoading ? (
                <>
                  Inbox <span className={s.countSkeleton} aria-label="Loading" />
                </>
              ) : needsYou !== undefined && needsYou > 0 ? (
                `${String(needsYou)} need you`
              ) : (
                "Inbox"
              )}
            </Button>
            <Button variant="quiet" icon={<Search />} shortcut={display("palette.toggle", platform)} onClick={() => openPalette()}>
              Commands
            </Button>
          </>
        ) : undefined
      }
    />
  );

  return (
    <div className={s.root} data-screen="shell">
      <AppFrame
        topBar={top}
        sidebar={chrome && !sidebarHidden ? <Sidebar data={data} route={route} seen={seen} hub={hub} jumpHints={modHeld} go={go} /> : undefined}
      >
        <div className={s.body}>
          <div className={s.column}>
            {/* Fixture data must never pass for a live hub. */}
            {window.fleetd.fixture !== null ? (
              <div className={s.fixtureBanner} role="status">
                Sample data, not connected
              </div>
            ) : null}
            {chrome ? <ConnectionBanner /> : null}
            <div className={s.screen}>
              <ScreenHost screen={shown} />
            </div>
            {chrome ? (
              <footer className={s.strips}>
                <StripsBody onOpenMachines={() => go({ id: "machines" })} />
              </footer>
            ) : null}
          </div>
          {chrome && route.inbox !== null ? <InboxPanel count={needsYou} askId={route.inbox.askId} onClose={() => setInbox(null)} /> : null}
        </div>
      </AppFrame>
      <PaletteHost />
      <ProjectsHost />
    </div>
  );
}
