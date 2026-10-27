// Undo on a "Remembered: …" or "Forgot: …" line, so a wrong memory has a way out, and the night's "Memory refreshed"
// line with its changes, each with Undo, and Undo all. The hub re-sends the line marked undone, which replaces a
// button with a word; only a failed Undo is kept here.
import { useState } from "react";
import type { ChatMessage, MemoryRefreshed, RememberedItem } from "../../../shared/contracts";
import { Button, Text } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import type { ProjectRef } from "./slots";

export function RememberedUndo({ project, message }: { project: ProjectRef; message: ChatMessage }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (message.remembered === undefined) return null;
  if (message.remembered.undone) {
    return (
      <Text size="xs" tone="quiet">
        Undone
      </Text>
    );
  }
  const undo = () => {
    setBusy(true);
    setFailed(null);
    void layer.call("memory_undo", { projectRef: project, messageId: message.messageId }).then((out) => {
      setBusy(false);
      if (!out.ok) setFailed(out.error.fix ? `${out.error.message} ${out.error.fix}` : out.error.message);
    });
  };
  return (
    <>
      <Button size="sm" variant="link" disabled={busy} onClick={undo}>
        Undo
      </Button>
      {failed ? (
        <Text size="xs" tone="danger">
          {failed}
        </Text>
      ) : null}
    </>
  );
}

/** `+` an entry added, `~` one put in place of another, `−` one removed. */
export const sign = (item: RememberedItem): string => (item.forgotten ? "−" : item.replaced !== undefined ? "~" : "+");

/** "MEMORY.md", "deploys.md" or "user.md". */
export const fileOf = (item: RememberedItem): string => (item.scope === "user" ? "user.md" : item.topic !== undefined ? `${item.topic}.md` : "MEMORY.md");

function useUndo(project: ProjectRef, message: ChatMessage) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const undo = (item?: number) => {
    setBusy(true);
    setFailed(null);
    const input = item === undefined ? { projectRef: project, messageId: message.messageId } : { projectRef: project, messageId: message.messageId, item };
    void layer.call("memory_undo", input).then((out) => {
      setBusy(false);
      if (!out.ok) setFailed(out.error.fix ? `${out.error.message} ${out.error.fix}` : out.error.message);
    });
  };
  return { busy, failed, undo };
}

/**
 * Under a "Memory refreshed" line: each change it lists, what it was, and its Undo, then how many more it made; Undo
 * all while two or more can be undone.
 */
export function RefreshedChanges({ project, message, refreshed }: { project: ProjectRef; message: ChatMessage; refreshed: MemoryRefreshed }) {
  const { busy, failed, undo } = useUndo(project, message);
  const unlisted = (refreshed.total ?? refreshed.items.length) - refreshed.items.length;
  // The changes past what the line lists can still be undone, all together.
  const open = refreshed.items.filter((i) => !i.undone).length + (refreshed.items.every((i) => i.undone) ? 0 : unlisted);
  return (
    <div role="list" aria-label="Memory changes" data-entry="memory-refreshed">
      {refreshed.items.map((item, n) => (
        <div role="listitem" key={n}>
          <Text size="xs" tone="quiet">
            {sign(item)} {fileOf(item)}: {item.text}
            {item.replaced !== undefined ? ` (was: ${item.replaced})` : ""}
            {item.reason !== undefined ? ` (${item.reason})` : ""}
          </Text>{" "}
          {item.undone ? (
            <Text size="xs" tone="quiet">
              Undone
            </Text>
          ) : (
            <Button size="sm" variant="link" disabled={busy} onClick={() => undo(n)}>
              Undo
            </Button>
          )}
        </div>
      ))}
      {unlisted > 0 ? (
        <div role="listitem">
          <Text size="xs" tone="quiet">
            and {unlisted} more
          </Text>
        </div>
      ) : null}
      {open > 1 ? (
        <Button size="sm" variant="link" disabled={busy} onClick={() => undo()}>
          Undo all
        </Button>
      ) : null}
      {failed ? (
        <Text size="xs" tone="danger">
          {failed}
        </Text>
      ) : null}
    </div>
  );
}
