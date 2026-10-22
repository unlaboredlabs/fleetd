// The sidebar's one quiet line about updates, above the connection line; nothing when there is nothing to say.
// Still text, never an animation; a click opens the updates sheet.
import { Dot, Truncate } from "../../ui";
import { useUpdatesView } from "./hooks";
import type { Tone } from "./model";
import { setUpdatesOpen } from "./state";
import s from "./updates.module.css";

const COLOR: Readonly<Record<Tone, string>> = { accent: "var(--accent)", warning: "var(--warning)", danger: "var(--danger)", quiet: "var(--faint)" };

export function UpdatesLine() {
  const { line } = useUpdatesView();
  if (line === null) return null;
  return (
    <button type="button" className={s.line} data-updates-line={line.tone} onClick={() => setUpdatesOpen(true)}>
      <Dot color={COLOR[line.tone]} />
      <Truncate size="xs" tone="inherit" expand="none">
        {line.text}
      </Truncate>
    </button>
  );
}
