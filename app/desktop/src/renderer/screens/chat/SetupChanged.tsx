// A project's chat line when its lead changes the project's setup (repo_add, repo_remove, project_setup, W614): one
// quiet line with Open, to where the person reads and edits what changed, and Undo, which puts back what was there
// before. Nothing to approve. The hub re-sends the line marked undone, which replaces the button with a word; only a
// failed Undo is kept here.
import { useState } from "react";
import type { ChatMessage, SetupChanged } from "../../../shared/contracts";
import { Button, Text } from "../../ui";
import { useDataLayer } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { navigate } from "../shell/navigation";
import type { SettingsTab } from "../shell/routes";
import type { ProjectRef } from "./slots";
import { InlineText } from "./text";

/** The project's settings page that shows what a change of this kind changed: its own page for all but these. */
const PAGES: Record<string, SettingsTab> = { instructions: "instructions", env: "project-vault" };

export const pageOf = (changed: SetupChanged): SettingsTab => PAGES[changed.kind] ?? "projects";

export function SetupChangedLine({ project, message, changed }: { project: ProjectRef; message: ChatMessage; changed: SetupChanged }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const undo = () => {
    setBusy(true);
    setFailed(null);
    void layer.call("project_setup_undo", { projectRef: project, messageId: message.messageId }).then((out) => {
      setBusy(false);
      if (!out.ok) setFailed(out.error.fix ? `${out.error.message} ${out.error.fix}` : out.error.message);
    });
  };
  return (
    <>
      <InlineText size="xs" tone="quiet" text={message.text} project={project} />
      <Button size="sm" variant="link" onClick={() => navigate({ id: "settings", tab: pageOf(changed), for: projectKey(project) })}>
        Open
      </Button>
      {changed.undone ? (
        <Text size="xs" tone="quiet">
          Undone
        </Text>
      ) : (
        <Button size="sm" variant="link" disabled={busy} onClick={undo}>
          Undo
        </Button>
      )}
      {failed ? (
        <Text size="xs" tone="danger">
          {failed}
        </Text>
      ) : null}
    </>
  );
}
