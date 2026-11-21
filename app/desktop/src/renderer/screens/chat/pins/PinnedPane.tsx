// The panel's Pinned list: every pinned message of the bot's chat, newest pinned first, each opening the chat at it.
// Who pinned it and when sit quietly under it; Unpin shows on the row under the pointer.
import { PinOff } from "lucide-react";
import { useData } from "../../../src/data/react";
import { projectKey } from "../../../src/data/store";
import type { ProjectRef } from "../slots";
import { Button, Text, Tooltip } from "../../../ui";
import { usePersonNames } from "../../admin/names";
import { useHubRole } from "../../admin/role";
import { useNow } from "../../live/clock";
import { goToMessage, usePinActions, usePins, whenOf, whoOf } from "./pins";
import s from "./pins.module.css";

export function PinnedPane({ project: ref }: { project: ProjectRef }) {
  const project = projectKey(ref);
  const pins = usePins(ref);
  const actions = usePinActions(ref, pins);
  const bot = useData((d) => d.projects[project]?.title) ?? "The lead";
  const me = useHubRole().me?.personId;
  const names = usePersonNames();
  const nowMs = useNow(true, 60_000);
  if (pins.length === 0) {
    return (
      <div className={s.list} data-pane="pinned" data-screen="pinned">
        <Text size="sm" tone="quiet">
          No pinned messages.
        </Text>
      </div>
    );
  }
  return (
    <div className={s.list} role="list" data-pane="pinned" data-screen="pinned">
      {pins.map((p) => (
        <div key={p.messageId} role="listitem" className={s.row} tabIndex={0} onClick={() => goToMessage(project, p.messageId)} onKeyDown={(e) => e.key === "Enter" && goToMessage(project, p.messageId)}>
          <span className={s.head}>
            <span className={s.who}>{whoOf(p, bot, me, names)}</span>
            <span className={s.when}>{whenOf(p.createdAt, nowMs)}</span>
          </span>
          <span className={s.body}>{p.text || "Pinned message"}</span>
          <span className={s.by}>
            {p.pinnedBy.personId === me ? "You" : (names.get(p.pinnedBy.personId) ?? p.pinnedBy.name)} pinned it · {whenOf(p.pinnedAt, nowMs)}
          </span>
          {actions === undefined ? null : (
            <span className={s.unpin}>
              <Tooltip content="Unpin">
                <Button
                  variant="quiet"
                  iconOnly
                  aria-label="Unpin"
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.set(p.messageId, false);
                  }}
                >
                  <PinOff />
                </Button>
              </Tooltip>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
