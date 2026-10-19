// The board's part in the palette and the shortcut map (F11): New order and Focus composer while the board is up,
// the "New order: <text>" action and the orders/projects source from anywhere (the frame's strips hold them).
import { useEffect, useMemo, useSyncExternalStore, type RefObject } from "react";
import { registerTextAction, useCommands, useSource, type Command } from "../palette";
import type { ComposerHandle } from "./Composer";
import { PHASE_WORD } from "./words";
import { useDataLayer } from "../../src/data/react";
import { selectBoardData } from "../../src/data/selectors";
import { toggleGrouping } from "./grouping";
import { projectsOf } from "./model";

const go = (hash: string) => {
  window.location.hash = hash;
};

// A request for the composer from outside the board, taken once the board shows: text ("New order: …" in the
// palette) to put in it, or none ("New order in storefront") to just focus it, leaving any draft as it is.
let pending: { readonly text?: string } | undefined;
const listeners = new Set<() => void>();
const subscribePending = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
/** Puts `text` in the board composer and opens the board (the palette's "New order: …", an order's Reorder). */
export const askForOrder = (text: string | undefined, where = "#/") => {
  pending = text === undefined ? {} : { text };
  for (const l of listeners) l();
  go(where);
};

/** While the board is up: ⌘N and ⌘L focus its composer, and text sent from the palette lands in it. */
export const useBoardCommands = (composer: RefObject<ComposerHandle | null>): void => {
  useCommands(
    [
      { id: "order.new", title: "New order", detail: "Write what the fleet should do", group: "actions", run: () => composer.current?.focus() },
      { id: "composer.focus", title: "Focus the composer", group: "actions", run: () => composer.current?.focus() },
      { id: "composer.pickProject", title: "Pick the order's project", group: "actions", run: () => composer.current?.pickProject() },
      { id: "composer.pickType", title: "Pick the order's type", group: "actions", run: () => composer.current?.pickType() },
      { id: "composer.attach", title: "Attach a file to the order", group: "actions", run: () => composer.current?.attach() },
      {
        id: "board.toggleGrouping",
        title: "Group by project or status",
        detail: "Switch how the board lists orders",
        group: "actions",
        keywords: ["group", "sort", "status", "project"],
        run: toggleGrouping,
      },
    ],
    [],
  );
  const request = useSyncExternalStore(subscribePending, () => pending);
  useEffect(() => {
    if (request === undefined || !composer.current) return;
    if (request.text === undefined) composer.current.focus();
    else composer.current.setText(request.text);
    pending = undefined;
    // Taken: readers see it gone, so the same text sent again is news.
    for (const l of listeners) l();
  }, [request, composer]);
};

/** From anywhere: the palette's "New order: <text>", and every order and project on the board as items. */
export const useBoardPalette = (): void => {
  useEffect(() => registerTextAction({ title: (text) => `New order: ${text}`, run: askForOrder }), []);
  // Read when the palette opens, straight from the data layer: nothing here subscribes, so nothing redraws.
  const layer = useDataLayer();
  const source = useMemo(
    () => ({
      id: "board",
      items: (): Command[] => {
        const d = selectBoardData(layer.store.getState());
        const orders = (d.orders ?? []).map(
          ({ card: o, phase }): Command => ({
            id: `order:${o.workstreamId}`,
            title: o.title,
            detail: `${o.workstreamId} · ${PHASE_WORD[phase.phase]}`,
            group: "orders",
            run: () => go(`#/order/${encodeURIComponent(o.workstreamId)}`),
          }),
        );
        // "New order in storefront": the board filtered to the project, its composer focused and aimed there.
        const newIn = (projectsOf(d) ?? []).map(
          (p): Command => ({
            id: `order.new:${p.key}`,
            title: `New order in ${p.title}`,
            detail: `on ${p.machine}`,
            group: "actions",
            searchOnly: true,
            run: () => askForOrder(undefined, `#/board/${encodeURIComponent(p.machineId)}/${encodeURIComponent(p.projectId)}`),
          }),
        );
        const projectItems = (projectsOf(d) ?? []).map(
          (p): Command => ({
            id: `project:${p.key}`,
            title: p.title,
            detail: `on ${p.machine}`,
            group: "projects",
            run: () => go(`#/board/${encodeURIComponent(p.machineId)}/${encodeURIComponent(p.projectId)}`),
          }),
        );
        return [...orders, ...projectItems, ...newIn];
      },
    }),
    [layer],
  );
  useSource(source);
};
