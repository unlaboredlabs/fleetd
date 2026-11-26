// What the sidebar shows (W694, W714): one hub at a time, picked from its name in the hub row; its pins, then its bots,
// your sections under quiet labels. The list's ⋯ orders the bots (the ones that want you first, then newest first; or
// by name) and draws them compact, kept on this computer. Which hub is on show is this window's: opening a bot of
// another hub shows that hub. The rows on show, in order, are what ⌘1–9 count (shownRows). A computer that kept the
// old List or Rail layout (fleetd.sidebarLayout) just shows this. Switching to another hub (its switcher, the swipe,
// the marks, ⇧⌘[ / ⇧⌘]) takes the screen with it (openHub). A section's label folds it (W798): which are folded is
// this device's alone, kept across launches (useFolded), and a folded section's chats are not on show.
import { useSyncExternalStore } from "react";
import { currentRoute, navigate } from "./navigation";
import { HOME } from "./routes";

/** How the hub's bots are ordered under the pins, in each section: the ones that want you first, then newest first
 * (W950); or by name. A computer that kept the old "Needs you first" has Recent, which now does it. */
export type SidebarSort = "recent" | "name";
export const SORTS: ReadonlyArray<{ readonly id: SidebarSort; readonly label: string }> = [
  { id: "recent", label: "Recent" },
  { id: "name", label: "Name" },
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

/**
 * Switch to `hub`: its list, and on screen its home, which is its last chat (Shell.tsx readLast), else its first, else
 * Get started (W794). So the chat on screen is always the sidebar's hub's, never one of the hub just left to write
 * into. The route goes first, so the render the sidebar's change starts draws the new hub's screen beside it.
 */
export const openHub = (hub: string): void => {
  if (currentRoute().at !== hub) navigate({ ...HOME, at: hub });
  showHub(hub);
};

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
  readonly section?: string | undefined;
  readonly project: { readonly title: string };
}

/** Bots in the list's order: the ones that want you first, then as they came (newest first, held while the pointer is
 * over the list); or by name. */
export const sortRows = <P extends Shown>(rows: ReadonlyArray<P>, sort: SidebarSort): ReadonlyArray<P> =>
  sort === "name"
    ? rows.toSorted((a, b) => a.project.title.localeCompare(b.project.title, undefined, { sensitivity: "base" }))
    : rows.some((r) => r.want !== undefined)
      ? rows.toSorted((a, b) => Number(b.want !== undefined) - Number(a.want !== undefined))
      : rows;

const FOLDED = "fleetd.foldedSections";

/** One of your sections on one hub, as the folded ones are kept. */
export const foldKey = (hub: string, section: string): string => `${hub}/${section}`;

const readFolded = (): ReadonlySet<string> => {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(FOLDED) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
};

let folded: ReadonlySet<string> | null = null;
const foldListeners = new Set<() => void>();
const currentFolded = (): ReadonlySet<string> => (folded ??= readFolded());

const setFolded = (key: string, on: boolean): void => {
  const was = currentFolded();
  if (was.has(key) === on) return;
  const next = new Set(was);
  if (on) next.add(key);
  else next.delete(key);
  folded = next;
  try {
    window.localStorage.setItem(FOLDED, JSON.stringify([...next]));
  } catch {
    // Kept for this window only.
  }
  for (const l of foldListeners) l();
};

/** Fold the section, or unfold it: a label's click. */
export const toggleFold = (hub: string, section: string): void => setFolded(foldKey(hub, section), !currentFolded().has(foldKey(hub, section)));

/** Unfold the section: one of its chats is opened from elsewhere (a notification, ⌘K, a hub's last chat). */
export const unfold = (hub: string, section: string): void => setFolded(foldKey(hub, section), false);

/** Your folded sections, by foldKey, on this device. */
export const useFolded = (): ReadonlySet<string> =>
  useSyncExternalStore(
    (onChange) => {
      foldListeners.add(onChange);
      return () => void foldListeners.delete(onChange);
    },
    currentFolded,
  );

/** For tests: read the kept folds again. */
export const resetFolded = (): void => {
  folded = null;
  for (const l of foldListeners) l();
};

const NO_FOLDS: ReadonlySet<string> = new Set();

/**
 * The rows on show, in the order the sidebar draws them: the hub's pins, then its other bots group by group (the chats
 * in no section, then each section, in the order the frame arranged them), each group in the list's order. A folded section's chats are
 * left out, bar the pinned ones (among the pins). ⌘1–9 count these.
 */
export const shownRows = <P extends Shown>(rows: ReadonlyArray<P>, v: SidebarView, hub: string, shut: ReadonlySet<string> = NO_FOLDS): ReadonlyArray<P> => {
  const own = rows.filter((p) => p.hub === hub);
  const rest = own.filter((p) => !p.pinned && (p.section === undefined || !shut.has(foldKey(hub, p.section))));
  const group = new Map<string | undefined, number>();
  for (const p of rest) if (!group.has(p.section)) group.set(p.section, group.size);
  // A stable sort by group keeps each group in the list's order.
  const grouped = sortRows(rest, v.sort).toSorted((a, b) => (group.get(a.section) ?? 0) - (group.get(b.section) ?? 0));
  return [...own.filter((p) => p.pinned), ...grouped];
};
