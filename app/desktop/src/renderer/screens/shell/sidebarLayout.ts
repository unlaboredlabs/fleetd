// What the sidebar shows (W694, W714): one hub at a time, picked from its name in the hub row; its pins, then its bots,
// your sections under quiet labels. The list's ⋯ orders the bots (newest first, by name, or the ones that want you
// first) and draws them compact, kept on this computer. Which hub is on show is this window's: opening a bot of
// another hub shows that hub. The rows on show, in order, are what ⌘1–9 count (shownRows). A computer that kept the
// old List or Rail layout (fleetd.sidebarLayout) just shows this.
import { useSyncExternalStore } from "react";

/** How the hub's bots are ordered under the pins, in each section: newest first, by name, or the ones that want you first. */
export type SidebarSort = "recent" | "name" | "needs";
export const SORTS: ReadonlyArray<{ readonly id: SidebarSort; readonly label: string }> = [
  { id: "recent", label: "Recent" },
  { id: "name", label: "Name" },
  { id: "needs", label: "Needs you first" },
];

const LIST = "fleetd.sidebarList";

const isSort = (v: unknown): v is SidebarSort => SORTS.some((s) => s.id === v);

const readList = (): { sort: SidebarSort; compact: boolean } => {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(LIST) ?? "{}");
    const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
    return { sort: isSort(o["sort"]) ? o["sort"] : "recent", compact: o["compact"] === true };
  } catch {
    return { sort: "recent", compact: false };
  }
};

export interface SidebarView {
  /** The hub on show; null: the screen's. */
  readonly hub: string | null;
  readonly sort: SidebarSort;
  /** One line a bot: its picture, its name and its mark. */
  readonly compact: boolean;
}

let view: SidebarView | null = null;
const listeners = new Set<() => void>();
const current = (): SidebarView => (view ??= { hub: null, ...readList() });

const set = (next: Partial<SidebarView>): void => {
  const was = current();
  const merged = { ...was, ...next };
  if (merged.hub === was.hub && merged.sort === was.sort && merged.compact === was.compact) return;
  view = merged;
  for (const l of listeners) l();
};

/** The list's order and density, from its ⋯ menu. */
export const setListView = (next: Partial<Pick<SidebarView, "sort" | "compact">>): void => {
  const { sort, compact } = { ...current(), ...next };
  try {
    window.localStorage.setItem(LIST, JSON.stringify({ sort, compact }));
  } catch {
    // Kept for this window only.
  }
  set({ sort, compact });
};

/** Show `hub`. */
export const showHub = (hub: string): void => set({ hub });

export const useSidebarView = (): SidebarView =>
  useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
    current,
  );

/** For tests: forget the window's view and read the kept one again. */
export const resetSidebarView = (): void => {
  view = null;
  for (const l of listeners) l();
};

/** The hub on show: the one picked, while it is still paired, else the screen's. */
export const viewedHub = (v: SidebarView, hubs: ReadonlyArray<{ readonly id: string }>, screenHub: string): string =>
  v.hub !== null && hubs.some((h) => h.id === v.hub) ? v.hub : screenHub;

interface Shown {
  readonly key: string;
  readonly hub: string;
  readonly pinned: boolean;
  readonly want?: unknown;
  readonly project: { readonly title: string };
}

/** Bots in the list's order: as they came (newest first, held while the pointer is over the list), by name, or the ones that want you first. */
export const sortRows = <P extends Shown>(rows: ReadonlyArray<P>, sort: SidebarSort): ReadonlyArray<P> =>
  sort === "name"
    ? rows.toSorted((a, b) => a.project.title.localeCompare(b.project.title, undefined, { sensitivity: "base" }))
    : sort === "needs"
      ? rows.toSorted((a, b) => Number(b.want !== undefined) - Number(a.want !== undefined))
      : rows;

/** The rows on show, in order: the hub's pins, then its other bots in the list's order. ⌘1–9 count these. */
export const shownRows = <P extends Shown>(rows: ReadonlyArray<P>, v: SidebarView, hub: string): ReadonlyArray<P> => {
  const own = rows.filter((p) => p.hub === hub);
  return [...own.filter((p) => p.pinned), ...sortRows(own.filter((p) => !p.pinned), v.sort)];
};
