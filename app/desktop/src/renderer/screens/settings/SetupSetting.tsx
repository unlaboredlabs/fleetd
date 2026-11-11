// Settings › Projects › Project › Setup, its own section under Code: what runs in each new worktree of a repo before its
// agent starts (install dependencies, generate code), saved with project_settings_set. Each repo has its own: the
// project's directory's is the project's, another repo's is saved with `repo`. Each run shows on the agent's thread, a
// command at a time with the end of its output, each within 10 minutes; when one fails the agent starts anyway and is
// told what failed.
import { useState } from "react";
import { Button, Textarea } from "../../ui";
import type { ProjectSettings as Settings, RepoName } from "../../../shared/contracts";
import { useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useRefetch } from "./hub";
import { GroupNote, SettingsRow, SettingsSection } from "./parts";
import { changed, draftOf, setupFrom, type SetupDraft } from "./setupModel";

/** One of the project's other repos' setup, read with `repo`, once the hub answers. */
export function RepoSetup({ settings, repo }: { settings: Settings; repo: RepoName }) {
  const read = useToolQuery("project_settings_get", { machineId: settings.machineId, projectId: settings.projectId, repo });
  const own = read.data?.settings;
  return own === undefined ? null : <Setup settings={own} title={`Setup: ${repo}`} repo={repo} />;
}

/** A repo's setup: the project's own directory's without `repo`. */
export function Setup({ settings, title, repo, reveal }: { settings: Settings; title: string; repo?: RepoName; reveal?: string }) {
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
    hubCall("project_settings_set", { machineId: settings.machineId, projectId: settings.projectId, ...(repo === undefined ? {} : { repo }), setup: next.setup }).then(
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
      title={title}
      reveal={reveal}
      hint="Runs in each new worktree, before its agent starts, with the project's variables: install dependencies, generate code. The output shows on the agent."
    >
      <SettingsRow
        title="Commands"
        hint="One a line, in order, each run with sh -c in the worktree, for up to 10 minutes. The first that fails stops the rest, and the agent starts anyway, told what failed."
      >
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
        title="Skip when unchanged"
        hint="Files whose contents decide what setup makes, one a line, such as lockfiles. A worktree set up before with the same commands and the same contents of these is not set up again. None: setup always runs."
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
      {/* Save shows once there is something to save; while it can't save, its line says why. */}
      {dirty ? (
        <SettingsRow
          title="Unsaved changes"
          hint="New worktrees run the saved setup until you save."
          line={next.ok ? null : <span role="alert">{next.problem}</span>}
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
