import { createContext, Fragment, useContext, useMemo, type ReactNode } from "react";
import { shownWords, splitRefs, type Ref } from "../../../shared/refs";

/**
 * How the app draws one of fleetd's ids in text (screens/refs RefChip: the thing's name, opening it). `inRow`: inside a
 * clickable row, where the chip only names it and the row keeps the click.
 */
export type RenderRef = (ref: Ref, inRow: boolean) => ReactNode;

/** The app's RenderRef; without one (a test, a window with no hub) ids show as written. */
export const RefsContext = createContext<RenderRef | undefined>(undefined);

/** One id as the app draws it, or as written with none. */
export function RefMark({ of, inRow = false }: { of: Ref; inRow?: boolean }) {
  const render = useContext(RefsContext);
  return <>{render === undefined ? of.id : render(of, inRow)}</>;
}

/** Plain words with fleetd's ids in them as chips, and a person's mention as their name. `inRow` inside a clickable row (RenderRef). */
export function RefText({ text, inRow = false }: { text: string; inRow?: boolean }) {
  const render = useContext(RefsContext);
  const runs = useMemo(() => splitRefs(text), [text]);
  if (render === undefined) return <>{shownWords(text)}</>;
  if (runs.length === 1 && typeof runs[0] === "string") return <>{runs[0]}</>;
  return (
    <>
      {runs.map((r, i) => (typeof r === "string" ? <Fragment key={i}>{r}</Fragment> : <Fragment key={i}>{render(r, inRow)}</Fragment>))}
    </>
  );
}
