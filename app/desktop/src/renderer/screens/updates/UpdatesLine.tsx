// The sidebar's word about updates, at the end of the hub's row: a small pill in the update's tone ("Update" when one
// is ready to take, else what is happening, "Downloading 40%"); nothing when there is nothing to say. Still, never an
// animation; a click opens the updates sheet.
import { ArrowUp } from "lucide-react";
import { Truncate } from "../../ui";
import { useUpdatesView } from "./hooks";
import { setUpdatesOpen } from "./state";
import s from "./updates.module.css";

export function UpdatesLine() {
  const { line } = useUpdatesView();
  if (line === null) return null;
  return (
    <button type="button" className={s.pill} data-updates-line={line.tone} onClick={() => setUpdatesOpen(true)} title={line.text} aria-label={line.text}>
      <ArrowUp aria-hidden className={s.pillIcon} />
      <Truncate size="xs" tone="inherit" expand="none">
        {line.tone === "accent" ? "Update" : line.text}
      </Truncate>
    </button>
  );
}
