// An automation's or a watcher's runs, newest first: when, what started it, its state, and the order it opened or the
// line it said.
import { StatusChip, Text } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { errorText } from "../settings/hub";
import { orderHref, runChip, runNote, triggerWord, when } from "./model";
import { dollars } from "./watchModel";
import s from "./automations.module.css";

/** Its runs, newest first, each with its trigger, state, the order it opened, and a watcher's line and cost. */
export function Runs({ automationId }: { automationId: string }) {
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
        const note = [runNote(r), cost].filter(Boolean).join(" · ") || null;
        return (
          <li key={r.runId} className={s.run}>
            <Text size="xs">{when(r.at)}</Text>
            <Text size="xs" tone="quiet">
              {triggerWord(r.trigger)}
            </Text>
            <StatusChip tone={chip.tone} inRow>
              {chip.label}
            </StatusChip>
            <Text size="xs" tone="quiet">
              {r.workstreamId ? <a href={orderHref(r.workstreamId)}>Order {r.workstreamId}</a> : null}
              {r.workstreamId && note ? " · " : null}
              {note}
            </Text>
          </li>
        );
      })}
    </ul>
  );
}

