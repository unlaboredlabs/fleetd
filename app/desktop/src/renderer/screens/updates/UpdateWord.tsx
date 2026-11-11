// Any update in one word ("Update", "Updating…", "Updated", "Not updated"; quiet.ts): self-contained, so whatever row
// names the hub places it at its end (today under your name in the sidebar, shell/You.tsx).
import type { Quiet } from "./quiet";
import s from "./updates.module.css";

export function UpdateWord({ quiet }: { quiet: Quiet }) {
  return (
    <span className={s.word} data-tone={quiet.word.tone} data-quiet={quiet.kind}>
      {quiet.word.text}
    </span>
  );
}
