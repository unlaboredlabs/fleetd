// The quiet line above the composer while the lead waits on you: what for, and Show, which brings it into view.
// The palette and the live strip's "waiting on you" row reach the same Show through the chat.showWaiting command.
import { Button, Dot, Text } from "../../ui";
import { useCommands } from "../palette";
import type { Waiting } from "./attentionModel";
import s from "./view.module.css";

export function AttentionLine({ waiting, onShow }: { waiting: Waiting | undefined; onShow: () => void }) {
  const canShow = waiting?.target !== undefined;
  useCommands(
    [{ id: "chat.showWaiting", title: "Show what the lead is waiting on", group: "actions", enabled: () => canShow, run: onShow }],
    [],
  );
  if (waiting === undefined) return null;
  return (
    <div className={s.attention} data-attention>
      <Dot color="var(--warning)" />
      <Text size="xs" tone="quiet">
        <Text size="xs" strong>
          The lead is waiting on you:
        </Text>{" "}
        {waiting.what}
        {canShow ? (
          <>
            {" "}
            <Button variant="link" onClick={onShow}>
              Show
            </Button>
          </>
        ) : null}
      </Text>
    </div>
  );
}
