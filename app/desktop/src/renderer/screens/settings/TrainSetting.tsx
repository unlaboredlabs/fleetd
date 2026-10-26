// Settings → Projects → Merge train: which of the repo's checks the train waits for before it merges, and which it
// leaves for after the merge, saved with project_settings_set. The base branch's required checks are always waited for.
import { useState } from "react";
import { Button, Field, Text, Textarea } from "../../ui";
import type { ProjectSettings as Settings } from "../../../shared/contracts";
import { errorText, useHubCall, useRefetch } from "./hub";
import { Setting } from "./parts";
import { trainChanged, trainDraftOf, trainFrom, type TrainDraft } from "./trainModel";
import s from "./settings.module.css";

export function TrainSetting({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState<TrainDraft>(() => trainDraftOf(settings.train));
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const next = trainFrom(draft);
  const edit = (patch: Partial<TrainDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setEcho(null);
  };
  const save = () => {
    if (!next.ok) return;
    setBusy(true);
    setEcho(null);
    hubCall("project_settings_set", { machineId: settings.machineId, projectId: settings.projectId, train: next.train }).then(
      (out) => {
        setBusy(false);
        setEcho({ ok: true, text: `Saved. ${out.next ?? ""}`.trim() });
        refetch(["project_settings_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };
  return (
    <Setting
      reveal="projects.train"
      label="Merge train"
      help="The train merges once the checks the base branch requires pass, with the checks you add here, each waited for until it reports. It never waits for any other check: those are watched on the base branch after the merge, and one that fails there opens a fix order. With none required and none added, it waits for every check."
    >
      <Field label="Also wait for" description="Checks to pass before a merge besides the required ones, one a line, named as GitHub shows them.">
        <Textarea mono minRows={1} value={draft.fast} disabled={busy} spellCheck={false} placeholder="test (ubuntu-latest)" onChange={(e) => edit({ fast: e.target.value })} />
      </Field>
      <Field
        label="After merge only"
        description="Checks that never stop a merge, even when they have already failed, one a line. Any other check outside the list above that has failed by then stops it. A required check is always waited for."
      >
        <Textarea mono minRows={1} value={draft.after} disabled={busy} spellCheck={false} placeholder="e2e (macos-latest)" onChange={(e) => edit({ after: e.target.value })} />
      </Field>
      <div className={s.inline}>
        <Button variant="primary" disabled={busy || !next.ok || !trainChanged(draft, settings.train)} onClick={save}>
          {busy ? "Saving…" : "Save checks"}
        </Button>
      </div>
      {!next.ok ? (
        <div role="alert">
          <Text size="sm" tone="danger">
            {next.problem}
          </Text>
        </div>
      ) : null}
      {echo ? (
        <div role={echo.ok ? "status" : "alert"}>
          <Text size="sm" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        </div>
      ) : null}
    </Setting>
  );
}
