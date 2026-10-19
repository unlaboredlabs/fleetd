// The palette's "Needs you" group: each open ask, opening the inbox on it. Shaped as F11's registry Source
// (screens/palette/registry.ts); F1 registers it with useSource once, where it mounts the panel host. `ask`
// ({batchId, number}) lets the palette's reply mode ("1 go 2 nvm") show which question each number answers, in the
// batch the hub will apply it to.
import { inboxStore } from "./store";

/** The current route with the inbox open on one ask (F1's route table: <route>?inbox&ask=<askId>). */
export const inboxHash = (hash: string, askId: string): string => {
  const path = hash.replace(/^#/u, "").split("?")[0] || "/board";
  return `#${path}?inbox&ask=${encodeURIComponent(askId)}`;
};

export const needsYouSource = {
  id: "needs-you",
  items: () => {
    const state = inboxStore().get();
    return state.open.map((ask) => ({
      id: `ask:${ask.askId}`,
      title: ask.text,
      group: "needs-you" as const,
      ...(ask.batchId === undefined || ask.number === undefined ? {} : { ask: { batchId: ask.batchId, number: ask.number } }),
      detail: ask.blocks === "nothing" ? "Needs your answer" : `Blocks ${ask.blocks}`,
      run: () => {
        window.location.hash = inboxHash(window.location.hash, ask.askId);
      },
    }));
  },
  subscribe: (onChange: () => void) => inboxStore().subscribe(onChange),
};
