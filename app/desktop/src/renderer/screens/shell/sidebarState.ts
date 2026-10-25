// Whether the sidebar (and the panel beside the chat) shows. Below NARROW_PX each hides itself so the chat keeps its
// width in a small window; its toggle still shows it there, until the window is narrowed again. Above it, each shows
// as you last left it.
import { useCallback, useEffect, useState } from "react";
import { isPanelTab, type PanelTab } from "../panel/tabs";

export const NARROW_PX = 1000;

export interface SidebarState {
  readonly narrow: boolean;
  /** Hidden with the toggle while the window was wide. */
  readonly hiddenWide: boolean;
  /** Shown with the toggle while the window was narrow. */
  readonly shownNarrow: boolean;
}

export const sidebarHidden = (s: SidebarState): boolean => (s.narrow ? !s.shownNarrow : s.hiddenWide);

export const withHidden = (s: SidebarState, hidden: boolean): SidebarState =>
  sidebarHidden(s) === hidden ? s : s.narrow ? { ...s, shownNarrow: !hidden } : { ...s, hiddenWide: hidden };

export const toggled = (s: SidebarState): SidebarState => withHidden(s, !sidebarHidden(s));

/** Narrowing hides it again, whatever was shown narrow before; widening goes back to your wide choice. */
export const resized = (s: SidebarState, narrow: boolean): SidebarState => (narrow === s.narrow ? s : { ...s, narrow, shownNarrow: false });

const narrowQuery = () => window.matchMedia(`(max-width: ${String(NARROW_PX - 1)}px)`);

/** The width as it is now: a resize's change event can arrive after a toggle or a link in the same frame. */
const now = (s: SidebarState): SidebarState => resized(s, narrowQuery().matches);

/** A media query, not a resize listener: it fires only when the width crosses. */
function useSideState(hiddenWide: boolean) {
  const [state, setState] = useState<SidebarState>(() => ({ narrow: narrowQuery().matches, hiddenWide, shownNarrow: false }));
  useEffect(() => {
    const query = narrowQuery();
    const onChange = () => setState((s) => resized(s, query.matches));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return [state, setState] as const;
}

/** The sidebar's visibility and its toggle. */
export function useSidebar(): { hidden: boolean; toggle: () => void } {
  const [state, setState] = useSideState(false);
  const toggle = useCallback(() => setState((s) => toggled(now(s))), [setState]);
  return { hidden: sidebarHidden(state), toggle };
}

export interface PanelState {
  readonly hidden: boolean;
  /** The tab it shows when the route names none. */
  readonly tab: PanelTab;
  readonly toggle: () => void;
  readonly show: (tab: PanelTab) => void;
}

const PANEL = "fleetd.panel";

interface SavedPanel {
  readonly open: boolean;
  readonly tab: PanelTab;
}

const readPanel = (): SavedPanel => {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(PANEL) ?? "null");
    if (typeof v === "object" && v !== null && "open" in v && "tab" in v) {
      return { open: v.open === true, tab: isPanelTab(v.tab) ? v.tab : "agents" };
    }
  } catch {
    // Unreadable: it starts open, as on a first launch.
  }
  return { open: true, tab: "agents" };
};

/** The panel beside the chat: open on a first launch, then as you left it in a wide window, kept across launches. */
export function usePanel(): PanelState {
  const [saved] = useState(readPanel);
  const [state, setState] = useSideState(!saved.open);
  const [tab, setTab] = useState(saved.tab);
  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL, JSON.stringify({ open: !state.hiddenWide, tab } satisfies SavedPanel));
    } catch {
      // Without storage it opens as on a first launch; nothing else depends on it.
    }
  }, [state.hiddenWide, tab]);
  const toggle = useCallback(() => setState((s) => toggled(now(s))), [setState]);
  const show = useCallback(
    (next: PanelTab) => {
      setTab(next);
      setState((s) => withHidden(now(s), false));
    },
    [setState],
  );
  return { hidden: sidebarHidden(state), tab, toggle, show };
}
