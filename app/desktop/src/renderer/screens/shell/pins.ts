// The sidebar's order (W530): your pinned chats on top, in your order, then every other chat by its newest line
// (latest.ts), newest first, as Messages and the phone order theirs. The pins are the hub's (chat_pins_get / _set,
// W232): the same as on your phone and each of your desktops, at most CHAT_PINS_MAX. You pin or unpin from a row's
// menu, and drag a pinned row (or move it with ⌥↑ / ⌥↓) among the pinned ones. Another device's change (chat.pins,
// which only your devices see) moves them live. The last pins read are kept on this computer too, only so a launch
// shows them before the hub answers.
import { useEffect, useMemo, useState } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import { callKey, type DataLayer } from "../../src/data/queries";
import { useDataLayer, useReadOf, useToolQuery } from "../../src/data/react";
import { ahead, keptPerHub } from "./ahead";
import { projectId } from "./model";

const NONE = {} as const;
const KEPT = "fleetd.sidebarPins";
/** The most chats pinned, as the hub and the phone allow (CHAT_PINS_MAX). */
export const PINS_MAX = 9;

/**
 * `rows` as the sidebar shows them: the ones `pins` names first, as it names them, then the rest by `at` (an ISO time),
 * newest first, then by title: the ones in none of your sections, then each of `sections` (their ids, in your order;
 * sections.ts) with its own. `held`, while the pointer is over the list, keeps the unpinned rows where they were (by
 * key) among their own, so none moves under it; a row it doesn't know goes after them.
 */
export const arranged = <R extends { readonly key: string; readonly at: string; readonly project: { readonly title: string }; readonly section?: string | undefined }>(
  rows: ReadonlyArray<R>,
  pins: readonly string[] | undefined,
  held?: readonly string[],
  sections?: readonly string[],
): R[] => {
  const pinAt = new Map((pins ?? []).map((k, i) => [k, i]));
  const pinned = rows.filter((r) => pinAt.has(r.key)).sort((a, b) => (pinAt.get(a.key) ?? 0) - (pinAt.get(b.key) ?? 0));
  const sectionAt = new Map((sections ?? []).map((id, i) => [id, i]));
  const group = (r: R) => (r.section === undefined ? -1 : (sectionAt.get(r.section) ?? -1));
  const byActivity = rows
    .filter((r) => !pinAt.has(r.key))
    .sort((a, b) => group(a) - group(b) || b.at.localeCompare(a.at) || a.project.title.localeCompare(b.project.title) || a.key.localeCompare(b.key));
  if (held === undefined) return [...pinned, ...byActivity];
  const heldAt = new Map(held.map((k, i) => [k, i]));
  const rank = (r: R) => heldAt.get(r.key) ?? held.length;
  return [...pinned, ...byActivity.sort((a, b) => group(a) - group(b) || rank(a) - rank(b))];
};

const kept = keptPerHub(KEPT, (raw): readonly string[] | undefined => (Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : undefined));

const saved = ahead<ProjectRef[]>({
  send: async (layer, pins) => {
    const out = await layer.call("chat_pins_set", { pins });
    return out.ok ? undefined : out.error.message;
  },
  read: callKey("chat_pins_get", NONE),
  refused: "Couldn’t save your pins",
});

/** This hub's pins for you, by project key: your changes still on their way, else the hub's, else the ones kept from before. */
export const usePins = (): readonly string[] | undefined => {
  const layer = useDataLayer();
  const { hub } = layer;
  const read = useToolQuery("chat_pins_get", NONE).data?.pins;
  const want = saved.useAhead(layer, useReadOf("chat_pins_get", NONE));
  const pins = useMemo(() => read?.map(projectId), [read]);
  const mine = useMemo(() => want?.map(projectId), [want]);
  const [before] = useState(() => kept.read(hub));
  useEffect(() => {
    if (pins !== undefined) kept.keep(hub, pins);
  }, [hub, pins]);
  return mine ?? pins ?? before;
};

/**
 * Saves `pins` on `layer`'s hub. The sidebar takes them at once. Changes made while one is on its way go after it, only
 * the newest of them; a refusal puts the hub's pins back and says why.
 */
export const savePins = (layer: DataLayer, pins: ProjectRef[]): Promise<void> => saved.save(layer, pins);
