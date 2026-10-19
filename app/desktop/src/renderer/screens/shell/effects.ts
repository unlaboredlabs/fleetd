// The frame's window-level wiring: menu clicks, things main asks it to open, notifications, Esc, and the held ⌘
// that shows the sidebar's jump numbers.
import { useEffect, useState } from "react";
import type { OpenTarget } from "../../../shared/app";
import { MENU_COMMANDS } from "../../../shared/menu";
import { closeOverlay, commandFor, runCommand } from "../palette";
// Not in the palette's public surface yet; the menu needs to hear when commands come and go.
import { subscribeRegistry } from "../palette/registry";
import { onHubEvent } from "./hubFeed";
import { currentRoute, navigate } from "./navigation";
import { attentionEvent, FALLBACK_POLICY, Notifier, policyFrom, policyStale, quietAt, type Policy } from "./notifier";
import { BOARD, type Route } from "./routes";

const platform = window.fleetd.platform;

const routeFor = (target: OpenTarget, from: Route): Route => {
  switch (target.kind) {
    case "ask":
      return { screen: from.screen, inbox: { askId: target.askId } };
    case "inbox":
      return { screen: from.screen, inbox: { askId: null } };
    case "machines":
      return { screen: { id: "machines" }, inbox: null };
    case "status":
      return { screen: { id: "status", scope: { kind: "fleet" } }, inbox: null };
    case "pair":
      return { screen: { id: "onboarding", hub: target.hub, code: target.code }, inbox: null };
  }
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
      navigate(routeFor(target, currentRoute()));
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

// The hub's attention policy as last read; one per window, shared with the other notifications (the Status digest).
let policy: Policy = FALLBACK_POLICY;

/** Inside the hub's quiet hours now: only urgent items may notify. */
export const quietNow = (nowMs: number): boolean => quietAt(policy, nowMs);

/**
 * Posts the "needs you" notification the hub's attention rules and policy allow, at most one per coalescing window.
 * The check is a plain timer: it renders nothing, so an idle window doesn't repaint.
 */
export const useNotifications = (live: boolean): void => {
  const [notifier] = useState(() => new Notifier());

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const refresh = async () => {
      const out = await window.fleetd.hub.call("attention_policy", {});
      if (!cancelled && out.ok) policy = policyFrom(out.output) ?? FALLBACK_POLICY;
    };
    const check = () => {
      const now = Date.now();
      if (policyStale(policy, now)) void refresh();
      // Until the store exposes the open asks, an ask answered within the window still shows.
      const due = notifier.due(now, policy, () => true);
      if (due !== null) void window.fleetd.app.notify({ tag: "needs-you", ...due });
    };
    void refresh();
    const offEvents = onHubEvent((event) => {
      const attention = attentionEvent(event);
      if (attention === null) return;
      notifier.push(attention, 0);
      check();
    });
    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => {
      cancelled = true;
      offEvents();
      clearInterval(timer);
    };
  }, [live, notifier]);
};

/** A field Esc should leave rather than act through (the composer, a search box). */
const editable = (target: EventTarget | null): target is HTMLElement =>
  target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));

/**
 * Esc closes the inbox, else leaves an order for the board. Menus, sheets and the palette take it first, and in a
 * text field (the composer) it only leaves the field, so a half-typed steer never sends you off the order.
 */
export const useEscape = (route: Route): void => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null) return;
      if (editable(event.target)) {
        event.target.blur();
        event.preventDefault();
        return;
      }
      if (route.inbox !== null) navigate({ ...route, inbox: null }, { replace: true });
      else if (route.screen.id === "order") navigate({ screen: BOARD, inbox: null });
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route]);
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
