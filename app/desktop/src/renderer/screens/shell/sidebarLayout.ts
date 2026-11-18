// The sidebar's three layouts (W694), picked in the menu under your name and kept on this computer. None stacks
// collapsible groups; each carries several hubs and your sections its own way:
//   List  every bot of every hub in one list, newest first, each row marked with its hub and section; the pins a
//         row of capsules over it; Screens and the Factory beside your name.
//   Hubs  one hub at a time, picked from its name at the top; its pins, then its bots, your sections as plain words
//         between them; Screens and the Factory over your name.
//   Rail  a slim rail of your hubs down the left edge, Screens, the Factory and you at its foot; beside it the hub's
//         pins and its bots, your sections as tabs over them.
// Which hub Hubs and Rail show, and which section Rail's tabs show, are this window's: opening a bot of another hub
// shows that hub. The rows on show, in order, are what ⌘1–9 count (shownRows).
import { useSyncExternalStore } from "react";

export type SidebarLayout = "list" | "hubs" | "rail";

export const LAYOUTS: ReadonlyArray<{ readonly id: SidebarLayout; readonly label: string; readonly idea: string }> = [
  { id: "list", label: "List", idea: "Every bot in one list, newest first" },
  { id: "hubs", label: "Hubs", idea: "One hub at a time, picked at the top" },
  { id: "rail", label: "Rail", idea: "Your hubs in a rail down the side" },
];

const LAYOUT = "fleetd.sidebarLayout";
export const DEFAULT_LAYOUT: SidebarLayout = "list";

const isLayout = (v: unknown): v is SidebarLayout => LAYOUTS.some((l) => l.id === v);

const read = (): SidebarLayout => {
  try {
    const v = window.localStorage.getItem(LAYOUT);
    return isLayout(v) ? v : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
};

export interface SidebarView {
  readonly layout: SidebarLayout;
  /** The hub Hubs and Rail show; null: the screen's. */
  readonly hub: string | null;
  /** Rail's tab: one of your sections on that hub, by id; null: all its bots. */
  readonly section: string | null;
}

let view: SidebarView | null = null;
const listeners = new Set<() => void>();
const current = (): SidebarView => (view ??= { layout: read(), hub: null, section: null });

const set = (next: Partial<SidebarView>): void => {
  const was = current();
  const merged = { ...was, ...next };
  if (merged.layout === was.layout && merged.hub === was.hub && merged.section === was.section) return;
  view = merged;
  for (const l of listeners) l();
};

export const setLayout = (layout: SidebarLayout): void => {
  try {
    window.localStorage.setItem(LAYOUT, layout);
  } catch {
    // Kept for this window only.
  }
  set({ layout });
};

/** Show `hub` in Hubs and Rail, on all its bots. */
export const showHub = (hub: string): void => set(current().hub === hub ? {} : { hub, section: null });

export const showSection = (section: string | null): void => set({ section });

export const useSidebarView = (): SidebarView =>
  useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
    current,
  );

/** For tests: forget the window's view and read the kept layout again. */
export const resetSidebarView = (): void => {
  view = null;
  for (const l of listeners) l();
};

/** The hub a layout shows: the one picked, while it is still paired, else the screen's. */
export const viewedHub = (v: SidebarView, hubs: ReadonlyArray<{ readonly id: string }>, screenHub: string): string =>
  v.hub !== null && hubs.some((h) => h.id === v.hub) ? v.hub : screenHub;

interface Shown {
  readonly key: string;
  readonly hub: string;
  readonly pinned: boolean;
  readonly at: string;
  readonly section?: string | undefined;
}

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * List's order: the pins, hub by hub in your order of them, then every other bot newest first. While the pointer is
 * over the list (`held`, the keys as they were on show), each keeps its place, and a new one goes last.
 */
export const listOrder = <P extends Shown>(rows: ReadonlyArray<P>, held: readonly string[] | null): ReadonlyArray<P> => {
  const pins = rows.filter((p) => p.pinned);
  const rest = rows.filter((p) => !p.pinned);
  if (held === null) return [...pins, ...rest.toSorted((a, b) => time(b.at) - time(a.at))];
  const at = (p: P) => {
    const i = held.indexOf(p.key);
    return i === -1 ? Infinity : i;
  };
  return [...pins, ...rest.toSorted((a, b) => at(a) - at(b))];
};

/** Rail's tab, as it filters the hub's bots: a pin shows among the pins whatever the tab. */
export const inSection = (p: Shown, section: string | null): boolean => section === null || p.pinned || p.section === section;

/** The rows on show, in the order the layout draws them: ⌘1–9 count these. */
export const shownRows = <P extends Shown>(rows: ReadonlyArray<P>, v: SidebarView, hub: string, held: readonly string[] | null = null): ReadonlyArray<P> => {
  if (v.layout === "list") return listOrder(rows, held);
  const own = rows.filter((p) => p.hub === hub);
  return v.layout === "rail" ? listOrder(own.filter((p) => inSection(p, v.section)), held) : own;
};
