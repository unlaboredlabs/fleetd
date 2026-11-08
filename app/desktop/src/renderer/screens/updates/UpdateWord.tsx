// Any update in one word ("Update", "Updating…", "Updated", "Put back"; quiet.ts): self-contained, so whatever row
// names the hub places it at its end, and the row's popover leads with UpdateNote.
import type { Quiet } from "./quiet";
import s from "./updates.module.css";

export function UpdateWord({ quiet }: { quiet: Quiet }) {
  return (
    <span className={s.word} data-tone={quiet.word.tone} data-quiet={quiet.kind}>
      {quiet.word.text}
    </span>
  );
}
