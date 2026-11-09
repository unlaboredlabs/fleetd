// The sidebar's order (W530): your pinned chats on top, in your order, then every other chat by its newest line
// (latest.ts), newest first, as Messages and the phone order theirs. The pins are the hub's (chat_pins_get / _set,
// W232): the same as on your phone and each of your desktops, at most CHAT_PINS_MAX. You pin or unpin from a row's
// menu, and drag a pinned row (or move it with ⌥↑ / ⌥↓) among the pinned ones. Another device's change (chat.pins,
// which only your devices see) moves them live. The last pins read are kept on this computer too, only so a launch
// shows them before the hub answers.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import { callKey, type DataLayer } from "../../src/data/queries";
import { useDataLayer, useReadOf, useToolQuery } from "../../src/data/react";
import { toast } from "../../ui";
import { projectId } from "./model";

const NONE = {} as const;
const KEPT = "fleetd.sidebarPins";
/** The most chats pinned, as the hub and the phone allow (CHAT_PINS_MAX). */
export const PINS_MAX = 9;

/**
 * `rows` as the sidebar shows them: the ones `pins` names first, as it names them, then the rest by `at` (an ISO time),
 * newest first, then by title. `held`, while the pointer is over the list, keeps the unpinned rows where they were
 * (by key), so none moves under it; a row it doesn't know goes after them.
 */
export const arranged = <R extends { readonly key: string; readonly at: string; readonly project: { readonly title: string } }>(
  rows: ReadonlyArray<R>,
  pins: readonly string[] | undefined,
  held?: readonly string[],
): R[] => {
  const pinAt = new Map((pins ?? []).map((k, i) => [k, i]));
  const pinned = rows.filter((r) => pinAt.has(r.key)).sort((a, b) => (pinAt.get(a.key) ?? 0) - (pinAt.get(b.key) ?? 0));
  const byActivity = rows.filter((r) => !pinAt.has(r.key)).sort((a, b) => b.at.localeCompare(a.at) || a.project.title.localeCompare(b.project.title) || a.key.localeCompare(b.key));
  if (held === undefined) return [...pinned, ...byActivity];
  const heldAt = new Map(held.map((k, i) => [k, i]));
  const rank = (r: R) => heldAt.get(r.key) ?? held.length;
  return [...pinned, ...byActivity.sort((a, b) => rank(a) - rank(b))];
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

const keep = (hub: string, pins: readonly string[]) => {
  try {
    const all: unknown = JSON.parse(window.localStorage.getItem(KEPT) ?? "{}");
    const next = { ...(typeof all === "object" && all !== null ? all : {}), [hub]: pins };
    window.localStorage.setItem(KEPT, JSON.stringify(next));
  } catch {
    // Without storage a launch shows no pins until the hub answers.
  }
};

/**
 * Your changes on one hub not yet answered by a read of the pins: what the sidebar shows meanwhile. `want` is the
 * newest; `sending` while a set is on its way, one at a time, so the hub takes them in the order you made them; `mark`
 * the layer's read mark (DataLayer.readsStarted) when the last one landed: a read numbered above it includes it, so
 * only that may take over. Until then an older read (the refetch your own earlier change's chat.pins made) never
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

/** This hub's pins for you, by project key: your changes still on their way, else the hub's, else the ones kept from before. */
export const usePins = (): readonly string[] | undefined => {
  const layer = useDataLayer();
  const { hub } = layer;
  const read = useToolQuery("chat_pins_get", NONE).data?.pins;
  const readNo = useReadOf("chat_pins_get", NONE);
  const saving = useSaving(layer);
  const pins = useMemo(() => read?.map(projectId), [read]);
  const mine = useMemo(() => saving?.want.map(projectId), [saving?.want]);
  const [kept] = useState(() => readKept(hub));
  useEffect(() => {
    if (pins !== undefined) keep(hub, pins);
  }, [hub, pins]);
  const ahead = saving !== undefined && (saving.mark === undefined || readNo === undefined || readNo <= saving.mark);
  return ahead ? mine : (pins ?? kept);
};

/**
 * Saves `pins` on `layer`'s hub. The sidebar takes them at once. Changes made while one is on its way go after it, only
 * the newest of them; a refusal puts the hub's pins back and says why.
 */
export async function savePins(layer: DataLayer, pins: ProjectRef[]): Promise<void> {
  const was = savings.get(layer);
  setSaving(layer, { want: pins, sending: was?.sending ?? false, mark: undefined });
  if (was?.sending === true) return;
  for (;;) {
    const sent = savings.get(layer)?.want ?? pins;
    setSaving(layer, { want: sent, sending: true, mark: undefined });
    const out = await layer.call("chat_pins_set", { pins: sent });
    if (!out.ok) {
      setSaving(layer, undefined);
      void layer.queryClient.invalidateQueries({ queryKey: callKey("chat_pins_get", NONE) });
      toast({ title: "Couldn’t save your pins", description: out.error.message, tone: "danger" });
      return;
    }
    const now = savings.get(layer);
    if (now === undefined || now.want === sent) {
      setSaving(layer, { want: sent, sending: false, mark: layer.readsStarted() });
      return;
    }
  }
}
