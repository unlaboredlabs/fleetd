// Settings › Projects › Project › Setup, its own section under Code (the default setup, once a repo has its own): what runs in each new worktree of a repo with no setup of its
// own before its agent starts (install dependencies, generate code), saved with project_settings_set. Each run shows on the agent's thread, a command at a
// time with the end of its output; a failure fails the agent's start unless the project starts it anyway.
import { useState } from "react";
import { Button, Input, Textarea } from "../../ui";
import type { ProjectSettings as Settings } from "../../../shared/contracts";
import { errorText, useHubCall, useRefetch } from "./hub";
import { GroupNote, SettingsRow, SettingsSection, SwitchRow } from "./parts";
import { changed, draftOf, SETUP_TIMEOUT_MAX_SEC, setupFrom, type SetupDraft } from "./setupModel";
import s from "./settings.module.css";

/** The project's setup, under its repos: each repo without its own runs it. `isDefault`: some repo has its own. */
export function DefaultSetup({ settings, isDefault }: { settings: Settings; isDefault: boolean }) {
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
  const dirty = changed(draft, settings.setup);
  return (
    <SettingsSection
      title={isDefault ? "Default setup" : "Setup"}
      reveal="projects.setup"
      intro={`Runs in each new worktree${isDefault ? " of a repo without setup of its own" : ""}, before its agent starts, with the project's variables: install dependencies, generate code. The output shows on the agent.`}
    >
      <SettingsRow title="Commands" line="One a line, in order, each run with sh -c in the worktree. The first that fails stops the rest.">
        <Textarea
          mono
          aria-label="Commands"
          minRows={2}
          value={draft.commands}
          disabled={busy}
          spellCheck={false}
          placeholder={"pnpm install --frozen-lockfile\npnpm codegen"}
          onChange={(e) => edit({ commands: e.target.value })}
        />
      </SettingsRow>
      <SettingsRow
        title="Time limit per command"
        line={`Seconds, up to ${SETUP_TIMEOUT_MAX_SEC}. A command past it is stopped and counts as failed.`}
        control={<Input inputMode="numeric" aria-label="Time limit per command" className={s.narrow} value={draft.timeout} disabled={busy} onChange={(e) => edit({ timeout: e.target.value })} />}
      />
      <SettingsRow
        title="Skip when unchanged"
        line="Files whose contents decide what setup makes, one a line, such as lockfiles. A worktree set up before with the same commands and the same contents of these is not set up again. None: setup always runs."
      >
        <Textarea
          mono
          aria-label="Skip when unchanged"
          minRows={1}
          value={draft.inputs}
          disabled={busy}
          spellCheck={false}
          placeholder="pnpm-lock.yaml"
          onChange={(e) => edit({ inputs: e.target.value })}
        />
      </SettingsRow>
      <SwitchRow
        title="Start the agent anyway when setup fails"
        line="Off: the agent doesn't start, and its task fails naming the command and the end of its output. On: it starts and hears what failed."
        checked={draft.runAnyway}
        disabled={busy}
        onCheckedChange={(runAnyway) => edit({ runAnyway })}
      />
      {/* Save shows once there is something to save; while it can't save, its line says why. */}
      {dirty ? (
        <SettingsRow
          title="Unsaved changes"
          line={next.ok ? "New worktrees run the saved setup until you save." : <span role="alert">{next.problem}</span>}
          lineTone={next.ok ? "quiet" : "danger"}
          control={
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setDraft(draftOf(settings.setup))}>
                Revert
              </Button>
              <Button variant="primary" disabled={busy || !next.ok} onClick={save}>
                {busy ? "Saving…" : "Save setup"}
              </Button>
            </>
          }
        />
      ) : null}
      {echo ? (
        <GroupNote tone={echo.ok ? "quiet" : "danger"}>
          <span role={echo.ok ? "status" : "alert"}>{echo.text}</span>
        </GroupNote>
      ) : null}
    </SettingsSection>
  );
}
