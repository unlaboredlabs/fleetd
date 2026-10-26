// The sidebar's one quiet line about updates, above the connection line; nothing when there is nothing to say.
// Still text, never an animation; a click opens the updates sheet.
import { ArrowUp } from "lucide-react";
import { Dot, Truncate } from "../../ui";
import { useUpdatesView } from "./hooks";
import type { Tone } from "./model";
import { setUpdatesOpen } from "./state";
import s from "./updates.module.css";

const COLOR: Readonly<Record<Tone, string>> = { accent: "var(--accent)", warning: "var(--warning)", danger: "var(--danger)", quiet: "var(--faint)" };

/**
 * `variant` (W42 design preview): "pill" (A) sits at the end of the hub's row, a small rounded button in the update's
 * tone; "banner" (B) is the card's first row, above the hub, split from it by a hairline.
 */
export function UpdatesLine({ variant = "pill" }: { variant?: "pill" | "banner" }) {
  const { line } = useUpdatesView();
  if (line === null) return null;
  if (variant === "pill") {
    return (
      <button type="button" className={s.pill} data-updates-line={line.tone} onClick={() => setUpdatesOpen(true)} title={line.text}>
        <ArrowUp aria-hidden className={s.pillIcon} />
        <Truncate size="xs" tone="inherit" expand="none">
          {line.tone === "accent" ? "Update" : line.text}
        </Truncate>
      </button>
    );
  }
  return (
    <button type="button" className={s.line} data-variant={variant} data-updates-line={line.tone} onClick={() => setUpdatesOpen(true)}>
      <Dot color={COLOR[line.tone]} />
      <Truncate size="xs" tone="inherit" expand="none">
        {line.text}
      </Truncate>
    </button>
  );
}
