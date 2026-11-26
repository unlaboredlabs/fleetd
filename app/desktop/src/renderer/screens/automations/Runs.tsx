// An automation's or a watcher's runs, newest first: when, what started it, its state, and the message it wrote in the
// chat (its first line, which opens it there) or why it was skipped or failed.
import type { ProjectRef } from "../../../shared/contracts";
import { StatusChip, Text } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { errorText } from "../settings/hub";
import { messageHref, runChip, runNote, triggerWord, when } from "./model";
import { dollars } from "./watchModel";
import s from "./automations.module.css";

/** Its runs, newest first, each with its trigger, state, its message in the chat, and a watcher's cost. */
export function Runs({ automationId, projectRef }: { automationId: string; projectRef: ProjectRef }) {
  const runs = useToolQuery("automation_runs", { automationId, limit: 30 });
  if (runs.isError) return <Text tone="danger">{errorText(runs.error)}</Text>;
  if (runs.data === undefined) return <Text tone="quiet">Loading runs…</Text>;
  if (runs.data.runs.length === 0) return <Text tone="quiet">No runs yet.</Text>;
  return (
    <ul className={s.runs} aria-label="Runs">
      {runs.data.runs.map((r) => {
        const chip = runChip(r);
        // A watcher's look shows what it cost beside what it said.
        const cost = r.costUsd !== undefined && r.costUsd > 0 ? dollars(r.costUsd) : null;
        const note = runNote(r);
        return (
          <li key={r.runId} className={s.run}>
            <Text size="xs">{when(r.at)}</Text>
            <Text size="xs" tone="quiet">
              {triggerWord(r.trigger)}
            </Text>
            <StatusChip tone={chip.tone} inRow>
              {chip.label}
            </StatusChip>
            {/* What it said, on one line: its message's first line opens the message in the chat. */}
            <Text size="xs" tone="quiet" className={s.said}>
              {note !== null && r.messageId !== undefined ? (
                <a className={s.saidLink} href={messageHref(projectRef, r.messageId)} title={`${note}\nOpen in the chat`}>
                  {note}
                </a>
              ) : (
                note
              )}
              {note !== null && cost !== null ? " · " : null}
              {cost}
            </Text>
          </li>
        );
      })}
    </ul>
  );
}
