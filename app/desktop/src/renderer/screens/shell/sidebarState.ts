// Whether the sidebar (and the panel beside the chat) shows. Below NARROW_PX each hides itself so the chat keeps its
// width in a small window; its toggle still shows it there, until the window is narrowed again. Above it, each shows
// as you last left it.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
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
      // Skills' list moved to the project's settings.
      return { open: v.open === true, tab: isPanelTab(v.tab) && v.tab !== "skills" ? v.tab : "agents" };
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

const COLLAPSED = "fleetd.collapsedHubs";
const FOLDED = "fleetd.foldedSections";

const readSet = (name: string): ReadonlySet<string> => {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(name) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
};

/** A set of ids you toggle, kept under `name` across launches on this computer. */
function useKeptSet(name: string): readonly [ReadonlySet<string>, (id: string) => void] {
  const [set, setSet] = useState(() => readSet(name));
  const toggle = useCallback(
    (id: string) => {
      setSet((was) => {
        const next = new Set(was);
        if (!next.delete(id)) next.add(id);
        try {
          window.localStorage.setItem(name, JSON.stringify([...next]));
        } catch {
          // Kept for this window only.
        }
        return next;
      });
    },
    [name],
  );
  return [set, toggle] as const;
}

/** The sidebar's hub groups you collapsed, by hub id, kept across launches. */
export const useCollapsedHubs = (): readonly [ReadonlySet<string>, (hub: string) => void] => useKeptSet(COLLAPSED);

/** One of your sections on one hub, as the folded ones are kept (sections.ts). */
export const foldKey = (hub: string, section: string): string => `${hub}/${section}`;

/** Your sections you folded, by foldKey, kept across launches as the hub groups are: this computer's alone. */
export const useFoldedSections = (): readonly [ReadonlySet<string>, (key: string) => void] => useKeptSet(FOLDED);

/**
 * The sidebar's rows on show, in order: with several hubs, a collapsed group's projects are hidden, and so are a
 * folded section's chats, bar the pinned ones (among the pins). ⌘1–9 count these, in the sidebar's numbers and in the
 * commands alike.
 */
export const shownRows = <P extends { readonly hub: string; readonly pinned: boolean; readonly section?: string | undefined }>(
  rows: ReadonlyArray<P>,
  collapsed: ReadonlySet<string>,
  several: boolean,
  folded: ReadonlySet<string>,
): ReadonlyArray<P> => rows.filter((p) => !(several && collapsed.has(p.hub)) && (p.pinned || p.section === undefined || !folded.has(foldKey(p.hub, p.section))));

/**
 * The sidebar's rows held where they are while the pointer is over its list (Sidebar.tsx): a chat with new activity
 * keeps its place until the pointer leaves, then glides to it, so a row never moves under a click. Row keys, in the
 * order they were on show; null while nothing holds them.
 */
let held: readonly string[] | null = null;
const holders = new Set<() => void>();

export const holdRows = (keys: readonly string[] | null): void => {
  if (held === keys) return;
  held = keys;
  for (const h of holders) h();
};

export const useHeldRows = (): readonly string[] | null =>
  useSyncExternalStore(
    (onChange) => {
      holders.add(onChange);
      return () => void holders.delete(onChange);
    },
    () => held,
  );
