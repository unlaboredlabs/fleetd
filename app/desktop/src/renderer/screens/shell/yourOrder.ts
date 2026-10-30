// Your own order of the sidebar's projects and Navis (W214): you drag a row or move it with ⌥↑ / ⌥↓ (Sidebar.tsx), and
// each hub keeps the order of its rows for you (sidebar_order_get / _set), so it is the same on each of your desktops
// and after a restart. Nobody else's sidebar follows yours. A project or Navi the order doesn't name yet (a new one)
// goes at the end of its section, in the sidebar's own order (by title). The last order read is kept on this
// computer too, only so a launch shows it before the hub answers.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import { callKey, type DataLayer } from "../../src/data/queries";
import { useDataLayer, useReadOf, useToolQuery } from "../../src/data/react";
import { toast } from "../../ui";
import { projectId } from "./model";

const NONE = {} as const;
const KEPT = "fleetd.sidebarOrder";

/** `rows` in `order` (project keys): the ones it names first, as it names them, then the rest as they were. */
export const ordered = <R extends { readonly key: string }>(rows: ReadonlyArray<R>, order: readonly string[] | undefined): ReadonlyArray<R> => {
  if (order === undefined || order.length === 0) return rows;
  const at = new Map(order.map((k, i) => [k, i]));
  const rank = (r: R) => at.get(r.key) ?? order.length;
  // A stable sort: the rows the order doesn't name keep the sidebar's own order among themselves.
  return [...rows].sort((a, b) => rank(a) - rank(b));
};

/**
 * A hub's whole order after a move in one section: `rows` (that hub's, as they show) with the rows of `moved` (keys,
 * in their new order) put in their places, the others where they are.
 */
export const withMoved = <R extends { readonly key: string }>(rows: ReadonlyArray<R>, moved: readonly string[]): R[] => {
  const at = new Map(moved.map((k, i) => [k, i]));
  const mine = rows.filter((r) => at.has(r.key)).sort((a, b) => (at.get(a.key) ?? 0) - (at.get(b.key) ?? 0));
  let next = 0;
  return rows.map((r) => (at.has(r.key) ? (mine[next++] ?? r) : r));
};

const readKept = (hub: string): readonly string[] | undefined => {
  try {
    const all: unknown = JSON.parse(window.localStorage.getItem(KEPT) ?? "{}");
    const kept: unknown = typeof all === "object" && all !== null ? (all as Record<string, unknown>)[hub] : undefined;
    return Array.isArray(kept) ? kept.filter((k): k is string => typeof k === "string") : undefined;
  } catch {
    return undefined;
  }
};

const keep = (hub: string, order: readonly string[]) => {
  try {
    const all: unknown = JSON.parse(window.localStorage.getItem(KEPT) ?? "{}");
    const next = { ...(typeof all === "object" && all !== null ? all : {}), [hub]: order };
    window.localStorage.setItem(KEPT, JSON.stringify(next));
  } catch {
    // Without storage a launch shows the sidebar's own order until the hub answers.
  }
};

/**
 * Your moves on one hub not yet answered by a read of the order: what the sidebar shows meanwhile. `want` is the
 * newest; `sending` while a set is on its way, one at a time, so the hub takes them in the order you made them; `mark`
 * the layer's read mark (DataLayer.readsStarted) when the last one landed: a read numbered above it includes it, so
 * only that may take over. Until then an older read (the refetch your own earlier move's sidebar.order made) never
 * puts a row back.
 */
interface Saving {
  readonly want: ProjectRef[];
  readonly sending: boolean;
  readonly mark: number | undefined;
}

const savings = new WeakMap<DataLayer, Saving>();
const watchers = new WeakMap<DataLayer, Set<() => void>>();

const setSaving = (layer: DataLayer, next: Saving | undefined) => {
  if (next === undefined) savings.delete(layer);
  else savings.set(layer, next);
  for (const w of watchers.get(layer) ?? []) w();
};

const useSaving = (layer: DataLayer): Saving | undefined =>
  useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        const set = watchers.get(layer) ?? new Set();
        watchers.set(layer, set.add(onChange));
        return () => void set.delete(onChange);
      },
      [layer],
    ),
    () => savings.get(layer),
  );

/** This hub's order for you, by project key: your moves still on their way, else the hub's, else the one kept from before. */
export const useYourOrder = (): readonly string[] | undefined => {
  const layer = useDataLayer();
  const { hub } = layer;
  const read = useToolQuery("sidebar_order_get", NONE).data?.order;
  const readNo = useReadOf("sidebar_order_get", NONE);
  const saving = useSaving(layer);
  const order = useMemo(() => read?.map(projectId), [read]);
  const mine = useMemo(() => saving?.want.map(projectId), [saving?.want]);
  const [kept] = useState(() => readKept(hub));
  useEffect(() => {
    if (order !== undefined) keep(hub, order);
  }, [hub, order]);
  const ahead = saving !== undefined && (saving.mark === undefined || readNo === undefined || readNo <= saving.mark);
  return ahead ? mine : (order ?? kept);
};

/**
 * Saves `order` on `layer`'s hub. The sidebar takes it at once. Moves made while one is on its way go after it, only
 * the newest of them; a refusal puts the hub's order back and says why.
 */
export async function saveOrder(layer: DataLayer, order: ProjectRef[]): Promise<void> {
  const was = savings.get(layer);
  setSaving(layer, { want: order, sending: was?.sending ?? false, mark: undefined });
  if (was?.sending === true) return;
  for (;;) {
    const sent = savings.get(layer)?.want ?? order;
    setSaving(layer, { want: sent, sending: true, mark: undefined });
    const out = await layer.call("sidebar_order_set", { order: sent });
    if (!out.ok) {
      setSaving(layer, undefined);
      void layer.queryClient.invalidateQueries({ queryKey: callKey("sidebar_order_get", NONE) });
      toast({ title: "Couldn’t save the sidebar’s order", description: out.error.message, tone: "danger" });
      return;
    }
    const now = savings.get(layer);
    if (now === undefined || now.want === sent) {
      setSaving(layer, { want: sent, sending: false, mark: layer.readsStarted() });
      return;
    }
  }
}
