// Settings › Projects › Project (#/settings/projects?for=<machine>/<project>, the project picked in the sidebar): its
// picture (Picture.tsx), its bot's color (BotColor.tsx), its name, Only me, its repos with their default setup (RepoSetting.tsx, SetupSetting.tsx),
// its agents' environment variables (on a hub with a vault, a line linking to its Vault tab), linked hubs (LinkedHubs.tsx), approvals (Approvals.tsx) and integrations (its
// MCP servers), its browser's sign-ins and a way to its skills
// (Signins.tsx), its card and purchases (Payments.tsx), archiving it and deleting it. Its memory refresh is on its
// Instructions & memory. Reads project_settings_get; writes project_settings_set, project_env_set (through main, which
// seals each secret to the project machine's key), project_archive and project_remove. A secret's value is write-only: typed here once,
// sealed in main, and only its fingerprint ever comes back.
import { useEffect, useState } from "react";
import { Button, Dialog, Field, Input, Radio, RadioGroup, Switch, Text, Textarea, Truncate } from "../../ui";
import type { MemoryRefreshJob, ProjectEnvVar, ProjectSettings as Settings, ToolInput } from "../../../shared/contracts";
import { refreshRuns, refreshSchedule } from "../automations/model";
import type { ProjectEnvRequest } from "../../../shared/ipc";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { RemoveProjectDialog, type RemoveTarget } from "../projects/RemoveProjectDialog";
import { archiveProject } from "../projects/actions";
import { isOnlyMe } from "../projects/model";
import { LinkedHubs } from "../hubLinks/LinkedHubs";
import { when } from "../live/when";
import { navigate } from "../shell/navigation";
import { parseScope, projectRefOf, scopeKey, type Scope } from "./editor";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { McpServersSection } from "./Integrations";
import { ApprovalsSetting } from "./Approvals";
import { PaymentsSetting } from "./Payments";
import { SigninsSetting, SkillsSetting } from "./Signins";
import { AddButton, DangerButton, NoProject, PageHead, SettingsList, SettingsListRow, SettingsRow, SettingsSection, SwitchRow } from "./parts";
import { PictureSetting } from "./Picture";
import { BotColorSetting } from "./BotColor";
import {
  countAfter,
  ENV_MAX,
  nameProblem,
  parseDotEnv,
  shownValue,
  totalProblem,
  unsavedWorktrees,
  valueProblem,
  withKind,
  type EnvKind,
  type PastedVar,
} from "./projectModel";
import { RepoSection } from "./RepoSetting";
import { isOwn } from "./repoModel";
import { replaceRoute, type SettingsRoute } from "./route";
import s from "./settings.module.css";
import { boxOf } from "./claudeModel";
import { vaultServed } from "./vaultModel";

type Echo = { ok: boolean; text: string };
type Ref = { machineId: string; projectId: string };

/** Hands the changes to main, which seals each secret and calls project_env_set; throws the hub's error. */
function useEnvSubmit(ref: Ref) {
  const box = useData((d) => boxOf(d.machines[ref.machineId]));
  const { hub } = useDataLayer();
  const refetch = useRefetch();
  return async (set: ProjectEnvRequest["set"], remove: ProjectEnvRequest["remove"]) => {
    const out = await window.fleetd.secret.projectEnv(hub, { ...ref, ...(box === undefined ? {} : { boxPubKey: box }), set, remove });
    if (!out.ok) throw new CallError(out.error);
    refetch(["project_settings_get"]);
  };
}

export function ProjectSettings({ route }: { route: SettingsRoute }) {
  const live = useLive();
  const scope: Scope | null = route.for ? parseScope(route.for) : null;
  const ref = scope ? projectRefOf(scope) : undefined;
  const key = scope ? scopeKey(scope) : null;

  useEffect(() => {
    replaceRoute({ tab: "projects", for: key });
  }, [key]);

  const read = useToolQuery("project_settings_get", { machineId: ref?.machineId ?? "", projectId: ref?.projectId ?? "" }, { enabled: live && ref !== undefined });

  if (!live) {
    return (
      <div className={s.scroll} data-screen="settings.projects">
        <div className={s.column}>
          <PageHead title="Projects" />
          <Text tone="quiet">Not connected. Connect to a hub to change its projects' settings.</Text>
        </div>
      </div>
    );
  }
  const settings = read.data?.settings ?? null;
  return (
    <div className={s.scroll} data-screen="settings.projects">
      <div className={s.column}>
        <PageHead title="Project" />
        {ref === undefined ? <NoProject /> : null}
        {read.isLoadingError ? (
          <div className={s.inline}>
            <Text tone="danger">{errorText(read.error)}</Text>
            <Button onClick={() => void read.refetch()}>Try again</Button>
          </div>
        ) : null}
        {settings && ref && settings.projectId === ref.projectId && settings.machineId === ref.machineId ? (
          <ProjectPage key={key} settings={settings} refresh={async () => (await read.refetch()).data?.settings} onDeleted={() => navigate({ id: "settings", tab: "projects" })} />
        ) : ref && !read.isLoadingError ? (
          <Text tone="quiet">Loading…</Text>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Delete opens only on a fresh list of the project's worktrees, so the confirm names every one with uncommitted
 * changes: while its machine is offline, too old, or can't list them, Delete is off and says why. A project whose
 * machine was removed has no worktrees anywhere: its Delete only forgets it in fleetd (RemoveProjectDialog's `gone`).
 */
function ProjectPage({ settings, refresh, onDeleted }: { settings: Settings; refresh: () => Promise<Settings | undefined>; onDeleted: () => void }) {
  const ref = { machineId: settings.machineId, projectId: settings.projectId };
  const summary = useData((d) => d.projects[projectKey(ref)]);
  const vault = useData((d) => vaultServed(d.features));
  // A folder rather than a git repo: the hub knows no repo of its own.
  const plain = !(summary?.repos ?? []).some((r) => isOwn(r, ref));
  const [deleting, setDeleting] = useState<RemoveTarget | null>(null);
  const [checking, setChecking] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const gone = useData((d) => d.fresh && d.machines[settings.machineId] === undefined);
  const unknown = gone || settings.worktrees !== undefined ? null : (settings.worktreesUnknown ?? "its machine hasn't listed its worktrees.");
  const open = async () => {
    if (gone) {
      setDeleting({ ...ref, title: settings.title, path: settings.workspaceRoot, deleting: { unsaved: [], plain } });
      return;
    }
    setChecking(true);
    setBlocked(null);
    const fresh = await refresh().catch(() => undefined);
    setChecking(false);
    if (fresh?.worktrees === undefined) {
      setBlocked(`Its worktrees can't be listed now: ${fresh?.worktreesUnknown ?? "the hub didn't answer."} Delete once they can, so no uncommitted work goes unseen.`);
      return;
    }
    setDeleting({
      ...ref,
      title: fresh.title,
      path: fresh.workspaceRoot,
      deleting: { unsaved: unsavedWorktrees(fresh).map((w) => ({ path: w.path, branch: w.branch })), plain },
    });
  };
  return (
    <>
      <SettingsSection title="Project">
        <PictureSetting project={summary ?? { ...ref, title: settings.title }} />
        <BotColorSetting project={summary ?? { ...ref, title: settings.title }} />
        <NameSetting settings={settings} />
        <OnlyMeSetting settings={settings} onlyMe={isOnlyMe(summary)} />
      </SettingsSection>
      <RepoSection settings={settings}>
        {vault ? <EnvInVault count={settings.env.length} projectRef={ref} /> : <EnvSetting env={settings.env} projectRef={ref} />}
      </RepoSection>
      <SettingsSection title="Safety">
        <ApprovalsSetting projectRef={ref} />
      </SettingsSection>
      <SettingsSection title="What its lead can use">
        <LinkedHubs project={ref} />
        <McpServersSection projectRef={ref} />
        <SigninsSetting projectRef={ref} kept={settings.signinsKept} />
        <SkillsSetting projectRef={ref} />
        <PaymentsSetting projectRef={ref} />
      </SettingsSection>
      <SettingsSection title="Archive or delete">
        <ArchiveSetting projectRef={ref} title={settings.title} archivedAt={summary?.archivedAt} />
        <SettingsRow
          reveal="projects.delete"
          title="Delete project"
          line={
            unknown !== null
              ? `Deleting needs its machine to list its worktrees first: ${unknown}`
              : gone
                ? `${settings.machineId} was removed from this hub, so no machine holds its files: deleting only forgets it in fleetd.`
                : `Stops it and erases everything fleetd keeps for it, its worktrees too. ${plain ? "Its folder stays unless you tick it when you delete." : "Its checkout stays unless you tick it when you delete; its branches and pull requests stay either way."}`
          }
          control={
            <DangerButton disabled={unknown !== null || checking} onClick={() => void open()}>
              {checking ? "Checking its worktrees…" : "Delete project…"}
            </DangerButton>
          }
        >
          <Problem text={blocked} />
        </SettingsRow>
      </SettingsSection>
      <RemoveProjectDialog project={deleting} onClose={() => setDeleting(null)} onRemoved={onDeleted} />
    </>
  );
}

function useSave() {
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const save = (input: ToolInput<"project_settings_set">, done: string) => {
    setBusy(true);
    setEcho(null);
    hubCall("project_settings_set", input).then(
      () => {
        setBusy(false);
        setEcho({ ok: true, text: done });
        refetch(["project_settings_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };
  return { busy, echo, save };
}

/** What a save did, as its row's line (its `lineTone` the echo's): read out as it appears. */
function EchoText({ echo }: { echo: Echo }) {
  return (
<span role={echo.ok ? "status" : "alert"}>{echo.text}</span>
  );
}

function Problem({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <div role="alert">
      <Text tone="danger">{text}</Text>
    </div>
  );
}

function NameSetting({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState(settings.title);
  const { busy, echo, save } = useSave();
  const title = draft.trim();
  // Rename shows once the name differs; an empty one says why it can't be saved.
  const dirty = draft !== settings.title;
  return (
    <SettingsRow
      reveal="projects.name"
      title="Name"
      lineTone={echo !== null && !echo.ok ? "danger" : "quiet"}
      line={
        <>
          <span className={s.lineBlock}>
            {echo !== null ? <EchoText echo={echo} /> : dirty && title === "" ? "A project needs a name." : "How fleetd shows the project. Its folder keeps its own name."}
          </span>
          <Truncate size="sm" tone="quiet" mono>
            {settings.workspaceRoot}
          </Truncate>
        </>
      }
      control={
        <>
          <Input aria-label="Project name" className={s.nameField} value={draft} maxLength={200} onChange={(e) => setDraft(e.target.value)} />
          {dirty ? (
            <Button
              variant="primary"
              disabled={busy || title === "" || title === settings.title}
              onClick={() => save({ machineId: settings.machineId, projectId: settings.projectId, title }, `Renamed to ${title}.`)}
            >
              {busy ? "Saving…" : "Rename"}
            </Button>
          ) : null}
        </>
      }
    />
  );
}

/** Only me: only its owner sees and uses it. Its owner, or an admin, may change it; the hub says so to anyone else. */
function OnlyMeSetting({ settings, onlyMe }: { settings: Settings; onlyMe: boolean }) {
  const { busy, echo, save } = useSave();
  return (
    <SwitchRow
      reveal="projects.only-me"
      title="Only me"
      line={
        echo !== null ? (
          <EchoText echo={echo} />
        ) : onlyMe ? (
          "Only you see it. Turn it off to share it with everyone on this hub."
        ) : (
          "Everyone on this hub sees it. Turn it on to keep it to yourself."
        )
      }
      lineTone={echo !== null && !echo.ok ? "danger" : "quiet"}
      checked={onlyMe}
      disabled={busy}
      onCheckedChange={(on) => save({ machineId: settings.machineId, projectId: settings.projectId, onlyMe: on }, on ? "Only you see it now." : "Everyone on this hub sees it now.")}
    />
  );
}

/** Archive: out of the sidebar with its lead stopped and everything kept; Bring back puts it back as it was. */
function ArchiveSetting({ projectRef, title, archivedAt }: { projectRef: Ref; title: string; archivedAt: string | undefined }) {
  const layer = useDataLayer();
  const [busy, setBusy] = useState(false);
  // Day-grained, so nothing ticks.
  const [now] = useState(() => Date.now());
  const archived = archivedAt !== undefined;
  const act = async () => {
    setBusy(true);
    await archiveProject(layer, { ...projectRef, title }, !archived);
    setBusy(false);
  };
  return (
    <SettingsRow
      reveal="projects.archive"
      title="Archive"
      line={
        archived
          ? `Archived ${when(archivedAt, now)}. Its lead doesn’t start until you bring it back.`
          : "Takes it out of the sidebar and stops its lead. Its chat, memory, folder and settings stay, and it comes back as it was."
      }
      control={
        <Button variant={archived ? "primary" : "secondary"} disabled={busy} onClick={() => void act()}>
          {busy ? (archived ? "Bringing it back…" : "Archiving…") : archived ? "Bring back" : "Archive"}
        </Button>
      }
    />
  );
}

/**
 * The nightly memory refresh: on the project's Instructions & memory, beside the memory it tidies, with its hour and
 * runs (automation_list's job, when the hub lists it) and Run now.
 */
export function MemoryRefreshSetting({ settings, job }: { settings: Settings; job: MemoryRefreshJob | undefined }) {
  const { busy, echo, save } = useSave();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [ran, setRan] = useState<Echo | null>(null);
  const on = settings.memoryRefresh ?? true;
  const running = job?.lastRun?.state === "running";
  const run = () => {
    setRan(null);
    hubCall("memory_refresh_run", { projectRef: { machineId: settings.machineId, projectId: settings.projectId } }).then(
      (out) => {
        setRan({ ok: true, text: out.why ? `Not run: ${out.why}` : "Refreshing: a line in the chat lists what it changed." });
        refetch(["automation_list"]);
      },
      (e: unknown) => setRan({ ok: false, text: errorText(e) }),
    );
  };
  return (
    <>
      <SwitchRow
        reveal="projects.memory"
        title="Refresh memory every night"
        line={
          echo !== null ? (
            <EchoText echo={echo} />
          ) : (
            "On a day with chat or orders, the lead adds what it missed, merges overlaps and removes what no longer holds. One line in the chat lists the changes, each with Undo."
          )
        }
        lineTone={echo !== null && !echo.ok ? "danger" : "quiet"}
        checked={on}
        disabled={busy}
        onCheckedChange={(next) =>
          save(
            { machineId: settings.machineId, projectId: settings.projectId, memoryRefresh: next },
            next ? "Memory is refreshed every night." : "The nightly memory refresh is off.",
          )
        }
      />
      <SettingsRow
        title="Refresh now"
        lineTone={ran !== null && !ran.ok ? "danger" : "quiet"}
        line={
          ran !== null ? (
            <EchoText echo={ran} />
          ) : !on ? (
            "Turn the nightly refresh on to run it."
          ) : job ? (
            `${refreshSchedule(job)} · ${refreshRuns(job)}`
          ) : (
            "Runs the nightly refresh once, now."
          )
        }
        control={
          <Button variant="secondary" disabled={!on || running} onClick={run}>
            {running ? "Refreshing…" : "Run now"}
          </Button>
        }
      />
    </>
  );
}

/** On a hub with a vault, the project's variables live in its Vault tab: one line here says so and links there. */
function EnvInVault({ count, projectRef }: { count: number; projectRef: Ref }) {
  return (
    <SettingsRow
      reveal="projects.env"
      title="Environment variables"
      line={`Given to every agent the project starts, and kept in the project's vault now. ${count === 0 ? "None yet." : `${String(count)} ${count === 1 ? "variable" : "variables"}.`}`}
      control={
        <Button variant="secondary" onClick={() => navigate({ id: "settings", tab: "project-vault", for: `${projectRef.machineId}/${projectRef.projectId}` })}>
          Open Vault
        </Button>
      }
    />
  );
}

type Editing = { kind: "new" } | { kind: "edit"; v: ProjectEnvVar } | { kind: "paste" } | { kind: "remove"; v: ProjectEnvVar };

function EnvSetting({ env, projectRef }: { env: ReadonlyArray<ProjectEnvVar>; projectRef: Ref }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [echo, setEcho] = useState<Echo | null>(null);
  const submit = useEnvSubmit(projectRef);
  const done = (text: string) => {
    setEditing(null);
    setEcho({ ok: true, text });
  };
  const full = env.length >= ENV_MAX;
  return (
    <SettingsRow
      reveal="projects.env"
      title="Environment variables"
      line={
        echo !== null ? (
          <EchoText echo={echo} />
        ) : full ? (
          `Given to every agent the project starts. It holds the most it can, ${String(ENV_MAX)}: remove one to add another.`
        ) : (
          "Given to every agent the project starts. Secrets are never shown again."
        )
      }
      lineTone={echo !== null && !echo.ok ? "danger" : "quiet"}
      control={
        <>
          <Button variant="ghost" onClick={() => setEditing({ kind: "paste" })}>
            Paste .env
          </Button>
          <AddButton label="Add variable" disabled={full} onClick={() => setEditing({ kind: "new" })} />
        </>
      }
    >
      {env.length === 0 ? null : (
        <SettingsList label="Environment variables">
          {env.map((v) => (
            <SettingsListRow
              key={v.name}
              label={v.name}
              name={
                <Text mono size="sm">
                  {v.name}
                </Text>
              }
              controls={
                <>
                  <Button variant="ghost" onClick={() => setEditing({ kind: "edit", v })}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing({ kind: "remove", v })}>
                    Remove
                  </Button>
                </>
              }
            >
              <Truncate size="sm" tone="quiet" mono>
                {shownValue(v)}
              </Truncate>
            </SettingsListRow>
          ))}
        </SettingsList>
      )}
      {editing?.kind === "new" || editing?.kind === "edit" ? (
        <EnvEditor
          env={env}
          editing={editing.kind === "edit" ? editing.v : null}
          taken={env.map((v) => v.name)}
          onClose={() => setEditing(null)}
          onSave={async (v) => {
            await submit([v], []);
            done(`Saved ${v.name}. New agents get it.`);
          }}
        />
      ) : null}
      {editing?.kind === "paste" ? (
        <PasteEnv
          env={env}
          onClose={() => setEditing(null)}
          onSave={async (vars) => {
            await submit(vars, []);
            done(`Saved ${vars.length} ${vars.length === 1 ? "variable" : "variables"}. New agents get them.`);
          }}
        />
      ) : null}
      {editing?.kind === "remove" ? (
        <ConfirmRemove
          v={editing.v}
          onClose={() => setEditing(null)}
          onRemove={async () => {
            await submit([], [editing.v.name]);
            done(`Removed ${editing.v.name}. Agents already running keep it until they next start.`);
          }}
        />
      ) : null}
    </SettingsRow>
  );
}

/** Runs `save`, keeping the dialog open with the hub's error when it fails. */
function useAttempt() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = (save: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    save().then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };
  return { busy, error, attempt };
}

function EnvEditor(props: {
  env: ReadonlyArray<ProjectEnvVar>;
  editing: ProjectEnvVar | null;
  taken: readonly string[];
  onClose: () => void;
  onSave: (v: ProjectEnvRequest["set"][number]) => Promise<void>;
}) {
  const was = props.editing;
  const [name, setName] = useState(was?.name ?? "");
  const [kind, setKind] = useState<EnvKind>(was?.kind === "secret" ? "secret" : "plain");
  // A secret's value never comes back: editing one means typing a new one.
  const [value, setValue] = useState(was?.kind === "plain" ? (was.value ?? "") : "");
  const { busy, error, attempt } = useAttempt();
  const n = name.trim();
  const nameIssue = was ? null : n !== "" && props.taken.includes(n) ? `${n} is already set: edit it instead.` : n === "" ? null : nameProblem(n);
  const valueIssue = valueProblem(value, kind) ?? (n === "" ? null : totalProblem(props.env, [{ name: n, value }]));
  const ready = n !== "" && nameIssue === null && valueIssue === null && !busy;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && props.onClose()}
      title={was ? `Edit ${was.name}` : "Add a variable"}
      description={kind === "secret" ? "Kept encrypted on the hub's machines. Never shown again." : "Shown here and kept by the hub."}
      footer={
        <>
          <Button onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} onClick={() => attempt(() => props.onSave({ kind, name: n, value }))}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <Field label="Name" error={nameIssue}>
          <Input mono value={name} disabled={was !== null || busy} autoComplete="off" spellCheck={false} placeholder="DATABASE_URL" onChange={(e) => setName(e.target.value)} />
        </Field>
        <RadioGroup className={s.radios} value={kind} onValueChange={(v) => setKind(v === "secret" ? "secret" : "plain")} aria-label="Kind">
          <Radio value="plain" label="Plain" />
          <Radio value="secret" label="Secret" />
        </RadioGroup>
        <Field
          label="Value"
          error={value === "" ? null : valueIssue}
          description={was?.kind === "secret" ? `Saved, fingerprint ${was.fingerprint ?? "unknown"}. Type a new value to replace it.` : undefined}
        >
          {/* Any number of lines, so a certificate chain or a key file pastes as it is; a secret's characters show as dots. */}
          <Textarea
            mono
            className={kind === "secret" ? s.secretValue : undefined}
            data-secret={kind === "secret" ? "" : undefined}
            value={value}
            minRows={1}
            maxRows={12}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <Problem text={error} />
      </div>
    </Dialog>
  );
}

function PasteEnv(props: { env: ReadonlyArray<ProjectEnvVar>; onClose: () => void; onSave: (vars: ProjectEnvRequest["set"]) => Promise<void> }) {
  const [text, setText] = useState("");
  const [kinds, setKinds] = useState<Readonly<Record<string, EnvKind>>>({});
  const { busy, error, attempt } = useAttempt();
  const vars: PastedVar[] = parseDotEnv(text).map((v) => {
    const kind = kinds[v.name];
    return kind === undefined ? v : withKind(v, kind);
  });
  const good = vars.filter((v) => v.problem === null);
  const over = countAfter(props.env, good.map((v) => v.name)) > ENV_MAX;
  const total = totalProblem(props.env, good);
  const replaced = good.filter((v) => props.env.some((e) => e.name === v.name)).length;
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => !open && !busy && props.onClose()}
      title="Paste a .env"
      description="Names that look like credentials start as secrets. A variable already set is replaced."
      footer={
        <>
          <Button onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || good.length === 0 || over || total !== null}
            onClick={() => attempt(() => props.onSave(good.map((v) => ({ kind: v.kind, name: v.name, value: v.value }))))}
          >
            {busy ? "Saving…" : `Add ${good.length} ${good.length === 1 ? "variable" : "variables"}`}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <Textarea mono aria-label=".env contents" value={text} minRows={6} maxRows={16} placeholder={"DATABASE_URL=postgres://localhost/app\nSTRIPE_KEY=sk_test_…"} onChange={(e) => setText(e.target.value)} />
        {vars.length > 0 ? (
          <div role="list" aria-label="Variables to add" className={s.stack}>
            {vars.map((v) => (
              <div key={v.name} role="listitem" className={s.inline}>
                <Text mono size="sm" strong>
                  {v.name}
                </Text>
                <Switch
                  label="Secret"
                  checked={v.kind === "secret"}
                  disabled={busy}
                  onCheckedChange={(on) => setKinds({ ...kinds, [v.name]: on ? "secret" : "plain" })}
                />
                {v.problem ? (
                  <Text size="xs" tone="danger">
                    {v.problem}
                  </Text>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {replaced > 0 ? (
          <Text size="sm" tone="quiet">
            {replaced} already set: {replaced === 1 ? "it is" : "they are"} replaced.
          </Text>
        ) : null}
        {over ? (
          <Text size="sm" tone="danger">
            A project takes at most {ENV_MAX} variables.
          </Text>
        ) : null}
        {total !== null ? (
          <Text size="sm" tone="danger">
            {total}
          </Text>
        ) : null}
        <Problem text={error} />
      </div>
    </Dialog>
  );
}

function ConfirmRemove(props: { v: ProjectEnvVar; onClose: () => void; onRemove: () => Promise<void> }) {
  const { busy, error, attempt } = useAttempt();
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && props.onClose()}
      title={`Remove ${props.v.name}?`}
      description={props.v.kind === "secret" ? "Its value is gone from the machine; set it again to bring it back." : "New agents of the project start without it."}
      footer={
        <>
          <Button onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => attempt(props.onRemove)}>
            {busy ? "Removing…" : "Remove"}
          </Button>
        </>
      }
    >
      <Problem text={error} />
    </Dialog>
  );
}
