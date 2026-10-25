// An ask: the lead's question with its buttons, Approve and Deny or one of its options. A button sends its words as
// your reply (chat_send, from this device's key), so only you answer it. Once answered, the card says what you
// chose; an older ask you answered in words stays open.
import type { AskBlock } from "../../../../shared/contracts";
import { Button, Text } from "../../../ui";
import { useBubbleActions } from "../actions";
import b from "./blocks.module.css";

export function Ask({ ask, answer }: { ask: AskBlock; answer: string | undefined }) {
  const actions = useBubbleActions();
  const options = ask.options ?? ["Approve", "Deny"];
  return (
    <div className={b.card} data-block="ask">
      <Text size="md">{ask.question}</Text>
      {answer !== undefined ? (
        <Text size="xs" tone="quiet">{`You answered: ${answer}`}</Text>
      ) : (
        <div className={b.actions}>
          {options.map((o, i) => (
            <Button key={o} variant={ask.options === undefined ? (i === 0 ? "primary" : "secondary") : "secondary"} disabled={actions === undefined} onClick={() => actions?.send(o)}>
              {o}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
