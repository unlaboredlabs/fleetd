// Not needed, for the questions the lead waits on: sends SKIP as your answer. In the last open ask card's row of buttons
// (blocks/Ask.tsx), else under the question's bubbles (Bubble.tsx).
import { Button, Tooltip, type ButtonSize } from "../../ui";

/** What Not needed sends: the lead reads it as your answer. */
export const SKIP = "Not needed: skip that and go on without an answer.";

/** A quiet secondary button: in an ask's card the size its own buttons are (no `size`), a small one under a question. */
export function SkipButton({ skip, size = "sm" }: { skip: () => void; size?: ButtonSize }) {
  return (
    <Tooltip content={`Sends “${SKIP}”`}>
      <Button variant="secondary" size={size} onClick={skip}>
        Not needed, skip it
      </Button>
    </Tooltip>
  );
}
