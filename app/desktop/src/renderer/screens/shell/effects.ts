// The frame's window-level wiring: menu clicks, things main asks it to open, notifications, and the held ⌘ that
// shows the sidebar's jump numbers.
import { useEffect, useRef, useState } from "react";
import { FIRST_HUB, type HubId } from "../../../shared/hubs";
import type { NotifyTarget, OpenTarget } from "../../../shared/app";
import { MENU_COMMANDS } from "../../../shared/menu";
import { closeOverlay, commandFor, runCommand } from "../palette";
// Not in the palette's public surface yet; the menu needs to hear when commands come and go.
import { subscribeRegistry } from "../palette/registry";
import type { HubEvent } from "../../../shared/hub";
import { useDataLayer, useHub, useSeveralHubs, useToolQuery } from "../../src/data/react";
import { selectLeadWorking, selectNeedsYou } from "../../src/data/selectors";
import { useHubRows } from "./hubRows";
import { useHubEvents } from "./hubFeed";
import { currentRoute, navigate } from "./navigation";
import { attentionEvent, FALLBACK_POLICY, Notifier, policyFrom, policyStale, Requests, type DueContext, type Policy } from "./notifier";
import { notificationPrefs, useNotificationPrefs } from "./notificationPrefs";
import { projectId } from "./model";
import { sameProject, type ProjectKey, type Screen } from "./routes";

const platform = window.fleetd.platform;

/** A notification's target on the hub that posted it, the first's too: clicked while another hub is on screen, it opens on its own. */
export const onItsHub = (target: NotifyTarget, hub: HubId): NotifyTarget => (target.kind === "notifications" ? target : { ...target, at: hub });

const screenFor = (target: OpenTarget): Screen => {
  // A hub's notification names its hub; one without (posted before there were several) is the first's.
  const at = target.kind === "chat" || target.kind === "machines" || target.kind === "status" ? (target.at ?? FIRST_HUB) : undefined;
  const on = at === undefined ? {} : { at };
  switch (target.kind) {
    case "chat":
      return { id: "project", project: { machineId: target.machineId, projectId: target.projectId }, message: target.messageId ?? null, ...on };
    case "machines":
      return { id: "settings", tab: "hub.machines", ...on };
    case "status":
      return { id: "status", ...on };
    case "notifications":
      return { id: "settings", tab: "general" };
    case "pair":
      return { id: "onboarding", hub: target.hub, code: target.code };
  }
};

/** That project's chat, on that hub, is in front of you: the window has focus and shows it. */
const lookingAt = (hub: string, project: ProjectKey): boolean => {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  const route = currentRoute();
  return route.id === "project" && route.at === hub && sameProject(route.project, project);
};

/** App menu clicks run the same command as their key; clicked notifications and fleetd:// links open their item. */
export const useMainProcess = (): void => {
  useEffect(() => {
    const offMenu = window.fleetd.app.onMenuCommand((id) => {
      closeOverlay();
      runCommand(id);
    });
    const offOpen = window.fleetd.app.onOpen((target) => {
      closeOverlay();
      navigate(screenFor(target));
    });
    return () => {
      offMenu();
      offOpen();
    };
  }, []);
};

/**
 * Keeps the app menu's items enabled only where their command does something here (no Stop Order on the board).
 * Commands come and go as screens mount, and their `enabled` reads the route, so both trigger a (debounced) report.
 */
export const useMenuState = (): void => {
  useEffect(() => {
    let last = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const enabled = MENU_COMMANDS.filter((id) => commandFor(id) !== undefined);
      const key = enabled.join(" ");
      if (key === last) return;
      last = key;
      void window.fleetd.app.setMenuState(enabled);
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(report, 50);
    };
    report();
    const offRegistry = subscribeRegistry(later);
    window.addEventListener("hashchange", later);
    window.addEventListener("focus", later);
    return () => {
      clearTimeout(timer);
      offRegistry();
      window.removeEventListener("hashchange", later);
      window.removeEventListener("focus", later);
    };
  }, []);
};

const CHECK_EVERY_MS = 15_000;

/**
 * Posts the notification the hub's attention rules and policy allow (needs you, a request finished, a machine down),
 * at most one per coalescing window. Each hub has its own (Shell.tsx's HubWatch), with its own policy: with several,
 * the title starts with the hub's label, and clicking it opens that hub's project.
 * The check is a plain timer: it renders nothing, so an idle window doesn't repaint.
 */
export const useNotifications = (live: boolean): void => {
  const [notifier] = useState(() => new Notifier());
  const { store } = useDataLayer();
  const hub = useHub();
  const several = useSeveralHubs();
  // What the check reads of this render: the hub's label and whether to say it.
  const said = useRef({ label: hub.label, several });
  useEffect(() => {
    said.current = { label: hub.label, several };
  }, [hub.label, several]);
  // The hub's attention policy as the data layer last read it (a decision.recorded event refetches it, so quiet hours
  // set from the phone or the CLI apply at once).
  const policy = useRef<Policy>(FALLBACK_POLICY);
  const [check] = useState(() => () => {
    const now = Date.now();
    const prefs = notificationPrefs();
    const context: DueContext = {
      // A project you have answered meanwhile is dropped; one whose state isn't known yet stays.
      stillNeeded: (p) => selectNeedsYou(projectId(p))(store.getState()) !== false,
      looking: (p) => lookingAt(hub.id, p),
      enabled: (kind) => prefs.kinds[kind],
      nameOf: (p) => store.getState().projects[projectId(p)]?.title,
    };
    const due = notifier.due(now, policy.current, context);
    if (due === null) return;
    const { label, several: named } = said.current;
    // One notification per hub at a time: a later one replaces only its own hub's.
    const tag = hub.id === FIRST_HUB ? "needs-you" : `needs-you-${hub.id}`;
    const target = onItsHub(due.target, hub.id);
    void window.fleetd.app.notify({ tag, ...due, title: named ? `${label} · ${due.title}`.slice(0, 120) : due.title, target, silent: !prefs.sound });
  });
  const [requests] = useState(() => new Requests());
  const [onEvent] = useState(() => (event: HubEvent) => {
    const finished = requests.see(event, (p) => selectLeadWorking(projectId(p))(store.getState()) === true);
    const attention = finished ?? attentionEvent(event);
    if (attention === null) return;
    notifier.push(attention);
    check();
  });
  useHubEvents(onEvent);

  // Fetched once the connection is fresh, and again whenever an event says it changed.
  const { data: status, refetch } = useToolQuery("fleetd_status", {});
  useEffect(() => {
    policy.current = policyFrom(status?.notify) ?? FALLBACK_POLICY;
  }, [status]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      // The hub sends the quiet window under way and the next; past the last one, ask for the next ones.
      if (policyStale(policy.current, Date.now())) void refetch();
      check();
    }, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [live, check, refetch]);
};

/**
 * The Dock badge: how many projects need you, on every hub. While a count isn't known (connecting, resyncing) the
 * last one stays rather than blinking to nothing; main clears it when the window closes.
 */
export const useDockBadge = (): void => {
  const rows = useHubRows();
  const counts = [...rows.values()].map((r) => r.needsYou);
  const total = counts.length === 0 || counts.some((n) => n === undefined) ? undefined : counts.reduce<number>((a, n) => a + (n ?? 0), 0);
  const { badge } = useNotificationPrefs();
  const count = badge ? total : 0;
  useEffect(() => {
    if (count !== undefined) void window.fleetd.app.setBadge(count);
  }, [count]);
};

/** True while ⌘ (Ctrl elsewhere) is held on its own. */
export const useModHeld = (): boolean => {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const update = (event: KeyboardEvent) => {
      const mod = platform === "darwin" ? event.metaKey : event.ctrlKey;
      setHeld(mod && !event.shiftKey && !event.altKey);
    };
    const release = () => setHeld(false);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", release);
    };
  }, []);
  return held;
};
