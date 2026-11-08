// What an update says at the top of the hub row's popover (quiet.ts Note): a title with its time, a sentence or two,
// what's new in a few lines, then its one action and, for an admin, Details (Settings › Hub › Updates).
import { Button, Text } from "../../ui";
import { retryMachine, startUpdate, updateNow } from "./flow";
import { useFlowDeps, useUpdatesView } from "./hooks";
import type { Note, NoteAction } from "./quiet";
import { Line } from "./UpdatesSheet";
import { runApp } from "./UpdatesHost";
import s from "./updates.module.css";

export function UpdateNote({ note, onDetails }: { note: Note; onDetails: () => void }) {
  const deps = useFlowDeps();
  const { lines } = useUpdatesView();
  const run = (action: NoteAction) => {
    if (action === "update") void startUpdate(deps);
    else if (action === "updateNow") void updateNow(deps);
    else if (action === "restartApp") runApp("install");
    else {
      // Each machine that didn't come through, again; with none to retry on its own (the hub's), the whole update.
      const machines = lines.flatMap((l) => (l.retry?.kind === "machine" ? [l.retry.machineId] : []));
      if (machines.length === 0) void startUpdate(deps);
      else for (const id of machines) void retryMachine(deps, id);
    }
  };
  return (
    <div className={s.note} data-update-note>
      <div className={s.noteHead}>
        <Text size="sm" strong tone={note.danger === true ? "danger" : "default"}>
          <Line text={note.title} />
        </Text>
        {note.aside === undefined ? null : (
          <Text size="xs" tone="quiet" tabular>
            {note.aside}
          </Text>
        )}
      </div>
      {note.body === undefined ? null : (
        <Text as="p" size="xs" tone="quiet">
          <Line text={note.body} />
        </Text>
      )}
      {note.notes.length === 0 ? null : (
        <ul className={s.noteLines}>
          {note.notes.map((line) => (
            <li key={line}>
              <Text size="xs">
                <Line text={line} />
              </Text>
            </li>
          ))}
        </ul>
      )}
      {note.action === undefined && !note.details ? null : (
        <div className={s.noteActions}>
          {note.action === undefined ? null : (
            <Button variant={note.action.run === "retry" ? "secondary" : "primary"} onClick={() => run(note.action?.run ?? "update")}>
              {note.action.label}
            </Button>
          )}
          {note.details ? (
            <Button variant="ghost" className={s.noteDetails} onClick={onDetails}>
              Details
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
