// Settings › Bots › Bot › Computer, its own section under Code (it was Setup): what runs in each new worktree of a repo
// before its agent starts (install dependencies, generate code), saved with project_settings_set, and the computer image
// those commands build, which agents start from instead of a clean box plus setup. Each repo has its own: the project's
// directory's is the project's, another repo's is saved with `repo`. The image rebuilds in the background when its
// commands change, and on Rebuild (project_image_rebuild); a missing, building or failed one only means a clean start plus
// setup, as before. Each setup run shows on the agent's thread, a command at a time with the end of its output, each
// within 10 minutes; when one fails the agent starts anyway and is told what failed.
import { useCallback, useState } from "react";
import { Button, Select, Textarea } from "../../ui";
import type { ComputerImage, ProjectSettings as Settings, RepoName } from "../../../shared/contracts";
import { useNow } from "../live";
import { useData, useHub, useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useRefetch } from "./hub";
import { CommandLine } from "../onboarding/Prose";
import { GroupNote, SettingsRow, SettingsSection } from "./parts";
import { AUTO, changed, draftOf, imageLine, pickOptions, pickValue, runsOnHint, setupFrom, whereOf, type SetupDraft } from "./setupModel";
import s from "./settings.module.css";

/** One of the project's other repos' computer, read with `repo`, once the hub answers. */
export function RepoComputer({ settings, repo }: { settings: Settings; repo: RepoName }) {
  const read = useToolQuery("project_settings_get", { machineId: settings.machineId, projectId: settings.projectId, repo });
  const own = read.data?.settings;
  return own === undefined ? null : <Computer settings={own} title={`Computer: ${repo}`} repo={repo} />;
}

/** A repo's computer, its image and its setup: the project's own directory's without `repo`. */
export function Computer({ settings, title, repo, reveal }: { settings: Settings; title: string; repo?: RepoName; reveal?: string }) {
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
        setEcho({ ok: true, text: off ? "Setup is off: agents start from a clean computer." : `Saved. ${out.next ?? "The image rebuilds with them."}` });
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
      hint="What each agent's computer has before it starts. Setup runs once in a clean box, and agents start from the image it leaves."
    >
      {repo === undefined ? <RunsOnRow settings={settings} /> : null}
      <ImageRow settings={settings} repo={repo} commands={(settings.setup.commands ?? []).length} />
      <SettingsRow
        title="Setup"
        hint="One command a line, in order, each run with sh -c in the worktree with the bot's variables, for up to 10 minutes: install tools and dependencies, generate code. The first that fails stops the rest, and the agent starts anyway, told what failed. Never write a secret to disk here: the image would keep it."
      >
        <Textarea
          mono
          aria-label="Setup commands"
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
          line={next.ok ? null : next.problem}
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

/**
 * Where the agents the bot's lead starts run (the lead itself stays on the bot's machine, as the hover says): one pick, each choice a real machine, provider and exact size together ("boat.dev ·
 * 4 vCPU / 8 GB"), or Automatic (its machine's own slots, then the team's hosted sandboxes). Saved as picked. Choices
 * that can't be used now are greyed, and the list says why once under them, with the command that fixes it; a pick that
 * can't be had now says so under the row, since its agents wait for it. No row when there is nothing to pick.
 */
function RunsOnRow({ settings }: { settings: Settings }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const machineName = useData((d) => d.machines[settings.machineId]?.name ?? settings.machineId);
  const cloud = useHub().cloud === true;
  const options = pickOptions(settings, cloud);
  if (options === null) return null;
  const value = pickValue(settings.computer);
  const current = options.find((o) => o.value === value);
  const hint = runsOnHint(settings.machineId, machineName, cloud);
  const pick = (next: string) => {
    if (next === value) return;
    const chosen = options.find((o) => o.value === next);
    if (!chosen) return;
    setBusy(true);
    setProblem(null);
    const input = chosen.pick ? { computer: chosen.pick } : { computerDefault: true };
    hubCall("project_settings_set", { machineId: settings.machineId, projectId: settings.projectId, ...input }).then(
      () => {
        setBusy(false);
        refetch(["project_settings_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  const waiting = value !== AUTO && current?.why !== undefined ? `Its agents wait: ${current.why}.` : null;
  return (
    <SettingsRow
      title="Runs on"
      hint={hint}
      line={problem ?? waiting}
      lineTone={problem !== null || waiting !== null ? "danger" : "quiet"}
      data={{ "data-computer": value }}
      control={
        <Select
          aria-label="Runs on"
          value={value}
          disabled={busy}
          onValueChange={pick}
          options={options.map((o) => ({
            value: o.value,
            textValue: o.label,
            ...(o.why !== undefined && o.value !== value ? { disabled: true } : {}),
            // Each option its label alone; why the ones that can't be used now can't, once under the last of them.
            label: o.label,
            ...(o.note === undefined
              ? {}
              : {
                  note: (
                    <>
                      <span>{o.note.why}</span>
                      {o.note.fix === undefined ? null : <CommandLine command={o.note.fix} />}
                    </>
                  ),
                }),
          }))}
        />
      }
    />
  );
}

/**
 * The image this repo's setup builds: when it was built and its size, or that it is building, or that it failed (its
 * log behind Log), and Rebuild. No row while there are no commands (no image), on a machine that can't build one, nor
 * from a hub too old to say.
 */
function ImageRow({ settings, repo, commands }: { settings: Settings; repo: RepoName | undefined; commands: number }) {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  // Rebuild's own answer, shown until the hub's next read replaces the image it answered over.
  const [mine, setMine] = useState<{ image: ComputerImage; over: ComputerImage | undefined } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const image = mine !== null && mine.over === settings.image ? mine.image : settings.image;
  const nowMs = useNow(image !== undefined, 60_000);
  const line = imageLine(image, commands, nowMs);
  // The log opens at its end, where the build failed.
  const toEnd = useCallback((el: HTMLPreElement | null) => el?.scrollTo({ top: el.scrollHeight }), []);
  if (line === null || image === undefined) return null;
  const rebuild = () => {
    const over = settings.image;
    setBusy(true);
    setProblem(null);
    hubCall("project_image_rebuild", { machineId: settings.machineId, projectId: settings.projectId, ...(repo === undefined ? {} : { repo }) }).then(
      (out) => {
        setBusy(false);
        setMine({ image: out.image, over });
        refetch(["project_settings_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setProblem(errorText(e));
      },
    );
  };
  const failed = image.state === "failed" && image.log !== undefined && image.log !== "";
  const where = whereOf(image);
  return (
    <SettingsRow
      title="Image"
      hint={`Agents start from this image instead of a clean box plus setup. It builds in the background when the setup changes; until it's ready, agents start clean and run setup.${where === null ? "" : ` Kept as ${where}.`}`}
      line={problem ?? line.text}
      lineTone={problem === null ? line.tone : "danger"}
      data={{ "data-image-state": image.state }}
      control={
        <>
          {failed ? (
            <Button variant="ghost" aria-expanded={showLog} onClick={() => setShowLog((v) => !v)}>
              {showLog ? "Hide log" : "Log"}
            </Button>
          ) : null}
          {image.state === "building" || commands === 0 ? null : (
            <Button disabled={busy} onClick={rebuild}>
              {busy ? "Starting…" : "Rebuild"}
            </Button>
          )}
        </>
      }
    >
      {failed && showLog ? (
        <pre className={s.imageLog} aria-label="Image build log" ref={toEnd}>
          {image.log}
        </pre>
      ) : null}
    </SettingsRow>
  );
}
