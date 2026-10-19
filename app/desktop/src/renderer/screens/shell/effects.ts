// The frame's window-level wiring: menu clicks, things main asks it to open, notifications, Esc, and the held ⌘
// that shows the sidebar's jump numbers.
import { useEffect, useRef, useState } from "react";
import type { OpenTarget } from "../../../shared/app";
import { closeOverlay, runCommand } from "../palette";
import { onHubEvent } from "./hubFeed";
import { currentRoute, navigate } from "./navigation";
import { attentionEvent, FALLBACK_POLICY, Notifier, policyFrom, policyStale, type Policy } from "./notifier";
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

const CHECK_EVERY_MS = 15_000;

/**
 * Posts the "needs you" notification the hub's attention rules and policy allow, at most one per coalescing window.
 * The check is a plain timer: it renders nothing, so an idle window doesn't repaint.
 */
export const useNotifications = (live: boolean): void => {
  const [notifier] = useState(() => new Notifier());
  const policy = useRef<Policy>(FALLBACK_POLICY);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const refresh = async () => {
      const out = await window.fleetd.hub.call("attention_policy", {});
      if (!cancelled && out.ok) policy.current = policyFrom(out.output) ?? FALLBACK_POLICY;
    };
    const check = () => {
      const now = Date.now();
      if (policyStale(policy.current, now)) void refresh();
      // Until the store exposes the open asks, an ask answered within the window still shows.
      const due = notifier.due(now, policy.current, () => true);
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
  }, [live, notifier, policy]);
};

/** Esc closes the inbox, else leaves an order for the board. Menus, sheets and the palette take it first. */
export const useEscape = (route: Route): void => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null) return;
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
