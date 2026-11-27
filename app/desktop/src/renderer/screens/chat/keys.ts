// The chat's keys: the list is one Tab stop, as Linear's and Slack's are, not two per message. Tabbing in lands on the
// newest bubble in view; ↑/↓ go from bubble to bubble, → into a bubble's own actions (reply, its receipt) and
// ← back; Tab and Shift+Tab leave the list from wherever in it.
import type { FocusEvent, KeyboardEvent } from "react";

const BUBBLE = "[data-bubble]";
/** A bubble's line: the bubble, and beside it its receipt and its actions. */
const LINE = "[data-line]";
const ACTIONS = "[data-line-actions] button, [data-line-actions] [aria-label], [data-receipt-mark]";

const inView = (list: HTMLElement, el: HTMLElement): boolean => {
  const l = list.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.bottom > l.top && r.top < l.bottom;
};

const bubblesOf = (list: HTMLElement): HTMLElement[] => [...list.querySelectorAll<HTMLElement>(BUBBLE)];

const go = (el: HTMLElement | undefined): boolean => {
  if (el === undefined) return false;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
  return true;
};

/** Tabbed into from outside it: the newest bubble in view takes the focus, so the ring shows where you are. */
export function onChatFocus(e: FocusEvent<HTMLElement>): void {
  const list = e.currentTarget;
  if (e.target !== list || (e.relatedTarget instanceof Node && list.contains(e.relatedTarget))) return;
  const shown = bubblesOf(list).filter((b) => inView(list, b));
  shown.at(-1)?.focus({ preventScroll: true });
}

export function onChatKey(e: KeyboardEvent<HTMLElement>): void {
  const list = e.currentTarget;
  const at = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null;
  if (at === null || e.altKey || e.metaKey || e.ctrlKey) return;
  const bubble = at.matches(BUBBLE) ? at : null;
  const line = at.closest<HTMLElement>(LINE);
  if (e.key === "Tab") {
    // From a bubble or its actions (none a Tab stop of its own), Tab goes on from the list itself: out of it, or to
    // what in it is a stop (a card's buttons), never back through each message.
    if (bubble !== null || at.closest("[data-line-actions]") !== null || at.matches("[data-receipt-mark]")) list.focus({ preventScroll: true });
    return;
  }
  if (e.shiftKey) return;
  const all = bubblesOf(list);
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const from = bubble ?? line?.querySelector<HTMLElement>(BUBBLE) ?? null;
    const i = from === null ? -1 : all.indexOf(from);
    const next = from === null ? (e.key === "ArrowUp" ? all.filter((b) => inView(list, b)).at(-1) : undefined) : all[e.key === "ArrowUp" ? i - 1 : i + 1];
    if (go(next)) e.preventDefault();
    return;
  }
  if (e.key === "ArrowRight" && bubble !== null && line !== null) {
    if (go(line.querySelector<HTMLElement>(ACTIONS) ?? undefined)) e.preventDefault();
    return;
  }
  if (e.key === "ArrowLeft" && bubble === null && line !== null) {
    if (go(line.querySelector<HTMLElement>(BUBBLE) ?? undefined)) e.preventDefault();
  }
}
