// The board's part in the palette and the shortcut map (F11): New order and Focus composer while the board is up,
// the "New order: <text>" action and the orders/projects source from anywhere (the frame's strips hold them).
import { useEffect, useMemo, useSyncExternalStore, type RefObject } from "react";
import { registerTextAction, useCommands, useSource, type Command } from "../palette";
import type { ComposerHandle } from "./Composer";
import { PHASE_WORD } from "./words";
import { useDataLayer } from "../../src/data/react";
import { selectBoardData } from "../../src/data/selectors";
import { projectsOf } from "./model";

const go = (hash: string) => {
  window.location.hash = hash;
};

// Text for the composer from outside the board ("New order: …" in the palette), taken once the board shows.
let pending: string | undefined;
const listeners = new Set<() => void>();
const subscribePending = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const askForOrder = (text: string) => {
  pending = text;
  for (const l of listeners) l();
  go("#/");
};

/** While the board is up: ⌘N and ⌘L focus its composer, and text sent from the palette lands in it. */
export const useBoardCommands = (composer: RefObject<ComposerHandle | null>): void => {
  useCommands(
    [
      { id: "order.new", title: "New order", detail: "Write what the fleet should do", group: "actions", run: () => composer.current?.focus() },
      { id: "composer.focus", title: "Focus the composer", group: "actions", run: () => composer.current?.focus() },
    ],
    [],
  );
  const text = useSyncExternalStore(subscribePending, () => pending);
  useEffect(() => {
    if (text === undefined || !composer.current) return;
    composer.current.setText(text);
    pending = undefined;
    // Taken: readers see it gone, so the same text sent again is news.
    for (const l of listeners) l();
  }, [text, composer]);
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
        const projectItems = (projectsOf(d) ?? []).map(
          (p): Command => ({
            id: `project:${p.key}`,
            title: p.title,
            detail: `on ${p.machine}`,
            group: "projects",
            run: () => go(`#/board/${encodeURIComponent(p.machineId)}/${encodeURIComponent(p.projectId)}`),
          }),
        );
        return [...orders, ...projectItems];
      },
    }),
    [layer],
  );
  useSource(source);
};
