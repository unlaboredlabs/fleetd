// What needs you, in the top bar after the chat's title, which is otherwise just the title. While the lead waits on
// you: what for, and Show, which brings it into view and marks it; with more than one place to go, each press goes to
// the next and the line says which ("1 of 2"). The palette and the live strip's "waiting on you" row reach the same
// Show through the chat.showWaiting command. Otherwise, while the project is blocked, why: the hub's reason, so you
// know before sending into it, and Resume when its machine's usage pause is the reason. Otherwise the hub's warning,
// which stops nothing (a check red on main). One row with no dot: the words truncate, and Show or Resume stays.
import { Button, Text } from "../../ui";
import { useCommands } from "../palette";
import { HubText } from "../projects/HubText";
import { ResumeButton } from "../status/Resume";
import type { Waiting } from "./attentionModel";
import s from "./view.module.css";

export function AttentionLine({
  waiting,
  blocked,
  warning,
  which,
  resume,
  onShow,
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
}) {
  const canShow = waiting !== undefined && waiting.targets.length > 0;
  useCommands(
    [{ id: "chat.showWaiting", title: "Show what the lead is waiting on", group: "actions", enabled: () => canShow, run: onShow }],
    [],
  );
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
