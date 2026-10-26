// Settings → Projects → Setup commands: what runs in each new worktree before its agent starts (install
// dependencies, generate code), saved with project_settings_set. Each run shows on the agent's thread, a command at a
// time with the end of its output; a failure fails the agent's start unless the project starts it anyway.
import { useState } from "react";
import { Button, Field, Input, Switch, Text, Textarea } from "../../ui";
import type { ProjectSettings as Settings } from "../../../shared/contracts";
import { errorText, useHubCall, useRefetch } from "./hub";
import { Setting } from "./parts";
import { changed, draftOf, SETUP_TIMEOUT_MAX_SEC, setupFrom, type SetupDraft } from "./setupModel";
import s from "./settings.module.css";

export function SetupSetting({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState<SetupDraft>(() => draftOf(settings.setup));
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const next = setupFrom(draft);
  const edit = (patch: Partial<SetupDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setEcho(null);
  };
  const save = () => {
    if (!next.ok) return;
    setBusy(true);
    setEcho(null);
    hubCall("project_settings_set", { machineId: settings.machineId, projectId: settings.projectId, setup: next.setup }).then(
      (out) => {
        setBusy(false);
        const off = next.setup.commands.length === 0;
        setEcho({ ok: true, text: off ? "Setup is off: new worktrees start as they are." : `Saved. ${out.next ?? "New worktrees run them."}` });
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
      reveal="projects.setup"
      label="Setup commands"
      help="Run in each new worktree before its agent starts, with the project's variables: install dependencies, generate code. The output shows on the agent."
    >
      <Field label="Commands" description="One a line, in order, each run with sh -c in the worktree. The first that fails stops the rest.">
        <Textarea
          mono
          minRows={2}
          value={draft.commands}
          disabled={busy}
          spellCheck={false}
          placeholder={"pnpm install --frozen-lockfile\npnpm codegen"}
          onChange={(e) => edit({ commands: e.target.value })}
        />
      </Field>
      <Field label="Time limit per command" description={`Seconds, up to ${SETUP_TIMEOUT_MAX_SEC}. A command past it is stopped and counts as failed.`}>
        <Input inputMode="numeric" className={s.narrow} value={draft.timeout} disabled={busy} onChange={(e) => edit({ timeout: e.target.value })} />
      </Field>
      <Field
        label="Skip when unchanged"
        description="Files whose contents decide what setup makes, one a line, such as lockfiles. A worktree set up before with the same commands and the same contents of these is not set up again. None: setup always runs."
      >
        <Textarea mono minRows={1} value={draft.inputs} disabled={busy} spellCheck={false} placeholder="pnpm-lock.yaml" onChange={(e) => edit({ inputs: e.target.value })} />
      </Field>
      <Switch
        label="Start the agent anyway when setup fails"
        description="Off: the agent doesn't start, and its task fails naming the command and the end of its output. On: it starts and hears what failed."
        checked={draft.runAnyway}
        disabled={busy}
        onCheckedChange={(runAnyway) => edit({ runAnyway })}
      />
      <div className={s.inline}>
        <Button variant="primary" disabled={busy || !next.ok || !changed(draft, settings.setup)} onClick={save}>
          {busy ? "Saving…" : "Save setup"}
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
