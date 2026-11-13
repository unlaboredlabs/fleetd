// What needs you, in the top bar after the chat's title, which is otherwise just the title. While the lead waits on
// you: what for, and Show, which brings it into view and marks it; with more than one place to go, each press goes to
// the next and the line says which ("1 of 2"). The palette reaches the same
// Show through the chat.showWaiting command. Otherwise, while the project is blocked, why: the hub's reason, so you
// know before sending into it, and Resume when its machine's usage pause is the reason. Otherwise what there is to
// look at, which the lead flagged (a showcase, something to try, a risk) or an agent suggested trying: how many, the
// oldest one's reason, Show, which goes to it and counts as seeing it, and Dismiss. A red main, which stops nothing,
// is the island's (Island.tsx). One row with no dot: the words truncate, and Show, Dismiss or Resume stays.
// Questions (not an approval or a secret, which the lead can't go on without) have an × that hides them from the bar
// until the lead asks again; the chat remembers it (hiddenWait).
import { X } from "lucide-react";
import { Button, Text, Tooltip } from "../../ui";
import { useCommands } from "../palette";
import { ResumeButton } from "./Resume";
import type { LookAt, Waiting } from "./attentionModel";
import s from "./view.module.css";

export function AttentionLine({
  waiting,
  blocked,
  which,
  resume,
  onShow,
  looks,
  onLook,
  onDismiss,
  onHide,
}: {
  waiting: Waiting | undefined;
  blocked: string | undefined;
  /** "1 of 2": the one Show last went to, when there is more than one. */
  which?: string | undefined;
  /** The machine whose usage pause blocks the project. */
  resume?: string | undefined;
  onShow: () => void;
  /** The messages to look at, oldest first. */
  looks?: readonly LookAt[] | undefined;
  /** Show the oldest one, and Dismiss it. */
  onLook?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
  /** Hides the questions it waits on until the lead asks again; only for questions. */
  onHide?: (() => void) | undefined;
}) {
  const canShow = waiting !== undefined && waiting.targets.length > 0;
  const look = looks?.[0];
  useCommands(
    [
      { id: "chat.showWaiting", title: "Show what the lead is waiting on", group: "actions", enabled: () => canShow, run: onShow },
      { id: "chat.showLook", title: "Show the next message to look at", group: "actions", enabled: () => look !== undefined, run: () => onLook?.() },
    ],
    [],
  );
  if (waiting === undefined && blocked === undefined && look !== undefined && looks !== undefined) {
    return (
      <div className={s.attention} data-attention="look">
        <Text size="xs" tone="quiet" className={s.attentionWords}>
          <Text size="xs" strong>
            {`${String(looks.length)} to look at:`}
          </Text>{" "}
          {look.reason}
        </Text>
        <Button variant="link" onClick={onLook}>
          Show
        </Button>
        <Button variant="link" onClick={onDismiss} aria-label={`Dismiss: ${look.reason}`}>
          Dismiss
        </Button>
      </div>
    );
  }
  if (waiting === undefined) {
    return blocked === undefined ? null : (
      <div className={s.attention} data-attention="blocked">
        <Text size="xs" tone="quiet" className={s.attentionWords}>
          <Text size="xs" strong tone="danger">
            {blocked === "" ? "Blocked" : "Blocked:"}
          </Text>
          {blocked === "" ? null : ` ${blocked}`}
        </Text>
        {resume === undefined ? null : <ResumeButton machineId={resume} />}
      </div>
    );
  }
  return (
    <div className={s.attention} data-attention>
      <Text size="xs" tone="quiet" className={s.attentionWords}>
        <Text size="xs" strong>
          Waiting on you:
        </Text>{" "}
        {waiting.what}
      </Text>
      {/* Always there, so the first "1 of 2" is announced. */}
      <span role="status">
        {which !== undefined ? (
          <Text size="xs" tone="quiet" tabular>
            {which}
          </Text>
        ) : null}
      </span>
      {canShow ? (
        <Button variant="link" onClick={onShow}>
          Show
        </Button>
      ) : null}
      {waiting.question !== undefined && onHide !== undefined ? (
        <Tooltip content="Hide until there’s a new question">
          <Button variant="quiet" iconOnly round className={s.attentionHide} aria-label="Hide until there’s a new question" onClick={onHide}>
            <X />
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
}
