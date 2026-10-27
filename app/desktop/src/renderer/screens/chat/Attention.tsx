// What needs you, in the top bar after the chat's title, which is otherwise just the title. While the lead waits on
// you: what for, and Show, which brings it into view and marks it; with more than one place to go, each press goes to
// the next and the line says which ("1 of 2"). The palette and the live strip's "waiting on you" row reach the same
// Show through the chat.showWaiting command. Otherwise, while the project is blocked, why: the hub's reason, so you
// know before sending into it, and Resume when its machine's usage pause is the reason. Otherwise what there is to
// look at, which the lead flagged (a showcase, something to try, a risk) or an agent suggested trying: how many, the
// oldest one's reason, Show, which goes to it and counts as seeing it, and Dismiss, then the hub's warning if any.
// Otherwise the hub's warning, which stops nothing (a check red on main). One row with no dot: the words truncate, and Show, Dismiss or Resume stays.
import { Button, Text } from "../../ui";
import { useCommands } from "../palette";
import { HubText } from "../projects/HubText";
import { ResumeButton } from "../status/Resume";
import type { LookAt, Waiting } from "./attentionModel";
import s from "./view.module.css";

export function AttentionLine({
  waiting,
  blocked,
  warning,
  which,
  resume,
  onShow,
  looks,
  onLook,
  onDismiss,
}: {
  waiting: Waiting | undefined;
  blocked: string | undefined;
  /** A red main and whether a fix is under way: the train keeps merging, so it is no block. */
  warning?: string | undefined;
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
        {/* A red main stays in view after it: the look ranks first, and both truncate before their buttons do. */}
        {warning === undefined ? null : (
          <>
            <Text size="xs" tone="quiet" aria-hidden>
              ·
            </Text>
            <Text size="xs" tone="warning" className={s.attentionWords} data-warning>
              <HubText>{warning}</HubText>
            </Text>
          </>
        )}
      </div>
    );
  }
  if (waiting === undefined && blocked === undefined) {
    return warning === undefined ? null : (
      <div className={s.attention} data-attention="warning">
        <Text size="xs" tone="warning" className={s.attentionWords}>
          <HubText>{warning}</HubText>
        </Text>
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
    </div>
  );
}
