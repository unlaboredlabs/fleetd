// The app frame: the top bar (the window's drag region, the traffic lights inset on macOS), the sidebar, the screen
// the route names, the inbox panel and the strips along the bottom. Navigation is the hash (routes.ts).
import { PanelLeft, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { display } from "../../../shared/shortcuts";
import { AppFrame, Button, TopBar } from "../../ui";
import { useNeedsYouSource } from "../inbox";
import { openPalette, PaletteHost, useCommands, type Command } from "../palette";
import { useEscape, useMainProcess, useMenuState, useModHeld, useNotifications } from "./effects";
import { useHubState } from "./hubFeed";
import { InboxPanel } from "./InboxPanel";
import { EMPTY_SHELL_DATA, Seen, sidebarOrders, type ShellData } from "./model";
import { navigate, useRoute } from "./navigation";
import type { Route, Screen } from "./routes";
import { ScreenHost, StripsBody } from "./screens";
import { Sidebar } from "./Sidebar";
import s from "./shell.module.css";

const platform = window.fleetd.platform;

/** The frame's view data. E1's store selector replaces this; until then the frame shows its empty states. */
const useShellData = (): ShellData => EMPTY_SHELL_DATA;

const JUMPS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export function Shell() {
  const route = useRoute();
  const hub = useHubState();
  const data = useShellData();
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [seen] = useState(() => new Seen());
  const modHeld = useModHeld();

  useMainProcess();
  useMenuState();
  useNotifications(hub?.phase === "live");
  useEscape(route);
  useNeedsYouSource();

  // What was there when the app connected counts as seen; a project you open is seen up to now.
  seen.prime(data.projects);
  const screen = route.screen;
  useEffect(() => {
    if (screen.id !== "board" || screen.project === null) return;
    const key = screen.project;
    const open = data.projects.find((p) => p.key.machineId === key.machineId && p.key.projectId === key.projectId);
    if (open !== undefined) seen.mark(open.key, open.lastActivityAt);
  }, [screen, data.projects, seen]);

  // Before pairing there is nothing to navigate; the onboarding screen has the window to itself.
  const onboarding = hub?.phase === "unpaired" || screen.id === "onboarding";
  const shown: Screen = hub?.phase === "unpaired" && screen.id !== "gallery" && screen.id !== "onboarding" ? { id: "onboarding", hub: null, code: null } : screen;
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
              variant={data.needsYou > 0 ? "secondary" : "quiet"}
              className={data.needsYou > 0 ? s.needsYou : undefined}
              shortcut={display("inbox.toggle", platform)}
              aria-pressed={route.inbox !== null}
              onClick={() => setInbox(route.inbox === null ? { askId: null } : null)}
            >
              {data.needsYou > 0 ? `${String(data.needsYou)} need you` : "Inbox"}
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
            <div className={s.screen}>
              <ScreenHost screen={shown} />
            </div>
            {chrome ? (
              <footer className={s.strips}>
                <StripsBody onOpenMachines={() => go({ id: "machines" })} />
              </footer>
            ) : null}
          </div>
          {chrome && route.inbox !== null ? <InboxPanel count={data.needsYou} askId={route.inbox.askId} onClose={() => setInbox(null)} /> : null}
        </div>
      </AppFrame>
      <PaletteHost />
    </div>
  );
}
