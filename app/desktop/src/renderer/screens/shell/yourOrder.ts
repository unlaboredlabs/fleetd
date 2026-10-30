// Your own order of the sidebar's projects and Navis (W214): you drag a row or move it with ⌥↑ / ⌥↓ (Sidebar.tsx), and
// each hub keeps the order of its rows for you (sidebar_order_get / _set), so it is the same on each of your desktops
// and after a restart. Nobody else's sidebar follows yours. A project or Navi the order doesn't name yet (a new one)
// goes at the end of its section, in the sidebar's own order (by title). The last order read is kept on this
// computer too, only so a launch shows it before the hub answers.
import { useEffect, useMemo, useState } from "react";
import type { ProjectRef, ToolOutput } from "../../../shared/contracts";
import { callKey, type DataLayer } from "../../src/data/queries";
import { useDataLayer, useToolQuery } from "../../src/data/react";
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

/** This hub's order for you, by project key: the hub's, else the one kept from before; undefined when neither has one. */
export const useYourOrder = (): readonly string[] | undefined => {
  const { hub } = useDataLayer();
  const read = useToolQuery("sidebar_order_get", NONE).data?.order;
  const order = useMemo(() => read?.map(projectId), [read]);
  const [kept] = useState(() => readKept(hub));
  useEffect(() => {
    if (order !== undefined) keep(hub, order);
  }, [hub, order]);
  return order ?? kept;
};

/** Saves `order` on `layer`'s hub. The sidebar takes it at once; a refusal puts the order back and says why. */
export async function saveOrder(layer: DataLayer, order: ProjectRef[]): Promise<void> {
  const key = callKey("sidebar_order_get", NONE);
  const before = layer.queryClient.getQueryData<ToolOutput<"sidebar_order_get">>(key);
  layer.queryClient.setQueryData<ToolOutput<"sidebar_order_get">>(key, { order });
  const out = await layer.call("sidebar_order_set", { order });
  if (out.ok) return;
  if (before === undefined) void layer.queryClient.resetQueries({ queryKey: key });
  else layer.queryClient.setQueryData(key, before);
  toast({ title: "Couldn’t save the sidebar’s order", description: out.error.message, tone: "danger" });
}
