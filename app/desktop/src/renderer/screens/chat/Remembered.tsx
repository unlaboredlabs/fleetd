// Undo on a "Remembered: …" line, so a wrong memory has a way out. The hub re-sends the line marked undone, which
// replaces the button with a word; only a failed Undo is kept here.
import { useState } from "react";
import type { ChatMessage } from "../../../shared/contracts";
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
