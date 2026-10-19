// The palette's "Needs you" group: each open ask, opening the inbox on it. Read from the data layer only while the
// palette is open (F11's Source contract). The shell mounts it once with useNeedsYouSource().
import { useMemo } from "react";
import { useSource, type Command } from "../palette";
import { useDataLayer } from "../../src/data/react";
import { selectInbox } from "../../src/data/selectors";

/** The current route with the inbox open on one ask (F1's route table: <route>?inbox&ask=<askId>). */
export const inboxHash = (hash: string, askId: string): string => {
  const path = hash.replace(/^#/u, "").split("?")[0] || "/board";
  return `#${path}?inbox&ask=${encodeURIComponent(askId)}`;
};

export const useNeedsYouSource = (): void => {
  const { store } = useDataLayer();
  const source = useMemo(
    () => ({
      id: "needs-you",
      items: (): Command[] =>
        (selectInbox(store.getState()) ?? []).map(({ ask }) => ({
          id: `ask:${ask.askId}`,
          title: ask.text.replace(/`/gu, ""),
          group: "needs-you",
          detail: ask.blocks === "nothing" ? "Needs your answer" : `Blocks ${ask.blocks}`,
          // The batch and number the palette's reply mode ("1 go") resolves, as the hub will apply it.
          ...(ask.batchId === undefined || ask.number === undefined ? {} : { ask: { batchId: ask.batchId, number: ask.number } }),
          run: () => {
            window.location.hash = inboxHash(window.location.hash, ask.askId);
          },
        })),
      subscribe: (onChange: () => void) => store.subscribe(onChange),
    }),
    [store],
  );
  useSource(source);
};
