// The frame's window-level wiring: menu clicks, things main asks it to open, notifications, and the held ⌘ that
// shows the sidebar's jump numbers.
import { useEffect, useState } from "react";
import type { OpenTarget } from "../../../shared/app";
import { MENU_COMMANDS } from "../../../shared/menu";
import { closeOverlay, commandFor, runCommand } from "../palette";
// Not in the palette's public surface yet; the menu needs to hear when commands come and go.
import { subscribeRegistry } from "../palette/registry";
import type { HubEvent } from "../../../shared/hub";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { selectNeedsYou, selectNeedsYouTotal } from "../../src/data/selectors";
import { useHubEvents } from "./hubFeed";
import { currentRoute, navigate } from "./navigation";
import { attentionEvent, FALLBACK_POLICY, Notifier, policyFrom, policyStale, type DueContext, type Policy } from "./notifier";
import { notificationPrefs, useNotificationPrefs } from "./notificationPrefs";
import { projectId } from "./model";
import { sameProject, type ProjectKey, type Screen } from "./routes";

const platform = window.fleetd.platform;

const screenFor = (target: OpenTarget): Screen => {
  switch (target.kind) {
    case "chat":
      return { id: "project", project: { machineId: target.machineId, projectId: target.projectId }, message: target.messageId ?? null };
    case "machines":
      return { id: "machines" };
    case "status":
      return { id: "status" };
    case "notifications":
      return { id: "settings", tab: "notifications" };
    case "pair":
      return { id: "onboarding", hub: target.hub, code: target.code };
  }
};

/** That project's chat is in front of you: the window has focus and shows it. */
const lookingAt = (project: ProjectKey): boolean => {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  const route = currentRoute();
  return route.id === "project" && sameProject(route.project, project);
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

// The hub's attention policy as the data layer last read it (a decision.recorded event refetches it, so quiet hours
// set from the phone or the CLI apply at once).
let policy: Policy = FALLBACK_POLICY;

/**
 * Posts the "needs you" notification the hub's attention rules and policy allow, at most one per coalescing window.
 * The check is a plain timer: it renders nothing, so an idle window doesn't repaint.
 */
export const useNotifications = (live: boolean): void => {
  const [notifier] = useState(() => new Notifier());
  const { store } = useDataLayer();
  const [check] = useState(() => () => {
    const now = Date.now();
    const prefs = notificationPrefs();
    const context: DueContext = {
      // A project you have answered meanwhile is dropped; one whose state isn't known yet stays.
      stillNeeded: (p) => selectNeedsYou(projectId(p))(store.getState()) !== false,
      looking: lookingAt,
      enabled: (kind) => prefs.kinds[kind],
      nameOf: (p) => store.getState().projects[projectId(p)]?.title,
    };
    const due = notifier.due(now, policy, context);
    if (due !== null) void window.fleetd.app.notify({ tag: "needs-you", ...due, silent: !prefs.sound });
  });
  const [onEvent] = useState(() => (event: HubEvent) => {
    const attention = attentionEvent(event);
    if (attention === null) return;
    notifier.push(attention);
    check();
  });
  useHubEvents(onEvent);

  // Fetched once the connection is fresh, and again whenever an event says it changed.
  const policyQuery = useToolQuery("attention_policy", {});
  const { data: policyOutput, refetch } = policyQuery;
  useEffect(() => {
    policy = policyFrom(policyOutput) ?? FALLBACK_POLICY;
  }, [policyOutput]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      // The hub sends the quiet window under way and the next; past the last one, ask for the next ones.
      if (policyStale(policy, Date.now())) void refetch();
      check();
    }, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [live, check, refetch]);
};

/**
 * The Dock badge: how many projects need you. While the count isn't known (connecting, resyncing) the last one
 * stays rather than blinking to nothing; main clears it when the window closes.
 */
export const useDockBadge = (): void => {
  const total = useData(selectNeedsYouTotal);
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
