// Settings › Projects › Project (#/settings/projects?for=<machine>/<project>, the project picked in the sidebar): its
// picture (Picture.tsx), its name, its repos with their default setup (RepoSetting.tsx, SetupSetting.tsx), its
// worktrees, its agents' environment variables, a Navi's integrations (its MCP servers; its linked hubs are in You ›
// Hubs), its browser's sign-ins and a way to its skills (NaviSignins.tsx), the merge train's checks (TrainSetting.tsx), and deleting
// it. Its memory refresh is on its Instructions & memory. Reads project_settings_get; writes project_settings_set,
// project_env_set (through main, which seals each secret to the project machine's key) and project_remove. A secret's
// value is write-only: typed here once, sealed in main, and only its fingerprint ever comes back.
import { useEffect, useState } from "react";
import { Button, Dialog, Field, Input, Radio, RadioGroup, Separator, Switch, Text, Textarea, Truncate } from "../../ui";
import type { ProjectEnvVar, ProjectSettings as Settings, ToolInput } from "../../../shared/contracts";
import type { ProjectEnvRequest } from "../../../shared/ipc";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { RemoveProjectDialog, type RemoveTarget } from "../projects/RemoveProjectDialog";
import { navigate } from "../shell/navigation";
import { parseScope, projectRefOf, scopeKey, type Scope } from "./editor";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { IntegrationsSection } from "./Integrations";
import { isNavi } from "./integrationsModel";
import { NaviSkillsSetting, SigninsSetting } from "./NaviSignins";
import { NoProject, PageHead, Setting } from "./parts";
import { PictureSetting } from "./Picture";
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
import { RepoSetting } from "./RepoSetting";
import { isOwn } from "./repoModel";
import { replaceRoute, type SettingsRoute } from "./route";
import { TrainSetting } from "./TrainSetting";
import s from "./settings.module.css";

type Echo = { ok: boolean; text: string };
type Ref = { machineId: string; projectId: string };

/** Hands the changes to main, which seals each secret and calls project_env_set; throws the hub's error. */
function useEnvSubmit(ref: Ref) {
  const box = useData((d) => d.machines[ref.machineId]?.boxPubKey);
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
        <PageHead title="Project">Its icon, name, repos, worktrees, its agents&apos; environment and setup, and its merge train.</PageHead>
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
 * changes: while its machine is offline, too old, or can't list them, Delete is off and says why.
 */
function ProjectPage({ settings, refresh, onDeleted }: { settings: Settings; refresh: () => Promise<Settings | undefined>; onDeleted: () => void }) {
  const ref = { machineId: settings.machineId, projectId: settings.projectId };
  const summary = useData((d) => d.projects[projectKey(ref)]);
  const navi = isNavi(summary);
  // A folder rather than a git repo: the hub knows no repo of its own (a Navi's never has one).
  const plain = navi || !(summary?.repos ?? []).some((r) => isOwn(r, ref));
  const [deleting, setDeleting] = useState<RemoveTarget | null>(null);
  const [checking, setChecking] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const unknown = settings.worktrees === undefined ? (settings.worktreesUnknown ?? "its machine hasn't listed its worktrees.") : null;
  const open = async () => {
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
      <PictureSetting project={summary ?? { ...ref, title: settings.title }} />
      <Separator />
      <NameSetting settings={settings} />
      <Separator />
      <RepoSetting settings={settings} />
      <Separator />
      <WorktreeSetting settings={settings} />
      <Separator />
      <EnvSetting env={settings.env} projectRef={ref} />
      <Separator />
      {navi ? (
        <>
          <IntegrationsSection projectRef={ref} />
          <Separator />
          <SigninsSetting projectRef={ref} />
          <Separator />
          <NaviSkillsSetting projectRef={ref} />
          <Separator />
        </>
      ) : null}
      <TrainSetting settings={settings} />
      <Separator />
      <Setting reveal="projects.delete" label="Delete project" help="Stops its agents and removes it from fleetd, with its fleetd worktrees.">
        <Text size="sm" tone="quiet">
          {plain ? "Its folder stays as it is." : "Its checkout, its branches and its pull requests stay as they are."}
        </Text>
        <div className={s.inline}>
          <Button variant="danger" disabled={unknown !== null || checking} onClick={() => void open()}>
            {checking ? "Checking its worktrees…" : "Delete project…"}
          </Button>
        </div>
        {unknown !== null ? (
          <Text size="xs" tone="quiet">
            Deleting needs its machine to list its worktrees first: {unknown}
          </Text>
        ) : null}
        <Problem text={blocked} />
      </Setting>
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

function EchoLine({ echo }: { echo: Echo | null }) {
  if (!echo) return null;
  return (
    <div role={echo.ok ? "status" : "alert"}>
      <Text size="sm" tone={echo.ok ? "quiet" : "danger"}>
        {echo.text}
      </Text>
    </div>
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
  return (
    <Setting reveal="projects.name" label="Name" help="How fleetd shows the project. Its folder keeps its own name.">
      <Truncate size="sm" tone="quiet" mono>
        {settings.workspaceRoot}
      </Truncate>
      <div className={s.inline}>
        <Input aria-label="Project name" value={draft} maxLength={200} onChange={(e) => setDraft(e.target.value)} />
        <Button
          variant="primary"
          disabled={busy || title === "" || title === settings.title}
          onClick={() => save({ machineId: settings.machineId, projectId: settings.projectId, title }, `Renamed to ${title}.`)}
        >
          {busy ? "Saving…" : "Rename"}
        </Button>
      </div>
      <EchoLine echo={echo} />
    </Setting>
  );
}

function WorktreeSetting({ settings }: { settings: Settings }) {
  const { busy, echo, save } = useSave();
  const w = settings.worktrees;
  const unsaved = unsavedWorktrees(settings).length;
  return (
    <Setting reveal="projects.worktrees" label="Worktrees" help="Every agent works in a git worktree of its own, never in your checkout.">
      {w ? (
        <>
          <Text size="sm" tone="quiet">
            New ones go in <code>{w.dir}</code>
            {w.baseBranch ? (
              <>
                , each on a fresh fetch of <code>{w.baseBranch}</code>, the repo's default branch
              </>
            ) : null}
            .
          </Text>
          <Text size="sm" tone="quiet">
            {w.worktrees.length === 0
              ? "None there now."
              : `${w.worktrees.length} there now${unsaved > 0 ? `, ${unsaved} with uncommitted changes` : ""}.`}
          </Text>
        </>
      ) : (
        <Text size="sm" tone="quiet">
          {settings.worktreesUnknown ?? "Its machine hasn't said where they are."}
        </Text>
      )}
      <Switch
        label="Keep finished worktrees"
        description="Off: a reader's worktree goes when its task finishes, and a writer's once its pull request merges. On: they stay on the machine until you delete the project."
        checked={settings.keepWorktrees}
        disabled={busy}
        onCheckedChange={(keep) =>
          save(
            { machineId: settings.machineId, projectId: settings.projectId, keepWorktrees: keep },
            keep ? "Finished worktrees stay." : "Finished worktrees go again.",
          )
        }
      />
      <EchoLine echo={echo} />
    </Setting>
  );
}

/** The nightly memory refresh's switch: on the project's Instructions & memory, beside the memory it tidies. */
export function MemoryRefreshSetting({ settings }: { settings: Settings }) {
  const { busy, echo, save } = useSave();
  return (
    <Setting reveal="projects.memory" label="Refresh every night" help="The lead tidies this project's memory overnight.">
      <Switch
        label="Refresh memory every night"
        description="Around 4:00, on a day with chat or orders, the lead tidies the project's memory: it adds what it missed, merges overlaps and removes what no longer holds. One line in the chat lists the changes, each with Undo."
        checked={settings.memoryRefresh ?? true}
        disabled={busy}
        onCheckedChange={(on) =>
          save(
            { machineId: settings.machineId, projectId: settings.projectId, memoryRefresh: on },
            on ? "Memory is refreshed every night." : "The nightly memory refresh is off.",
          )
        }
      />
      <EchoLine echo={echo} />
    </Setting>
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
  return (
    <Setting
      reveal="projects.env"
      label="Environment variables"
      help="Given to every agent the project starts from now on. A secret's value is never shown again, only its fingerprint."
    >
      {env.length === 0 ? (
        <Text size="sm" tone="quiet">
          None yet.
        </Text>
      ) : (
        <div role="list" aria-label="Environment variables" className={s.stack}>
          {env.map((v) => (
            <div key={v.name} role="listitem" className={s.inline}>
              <Text mono strong size="sm">
                {v.name}
              </Text>
              <Truncate size="sm" tone="quiet" mono>
                {shownValue(v)}
              </Truncate>
              <Button size="sm" variant="ghost" onClick={() => setEditing({ kind: "edit", v })}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing({ kind: "remove", v })}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className={s.inline}>
        <Button onClick={() => setEditing({ kind: "new" })} disabled={env.length >= ENV_MAX}>
          Add variable
        </Button>
        <Button variant="ghost" onClick={() => setEditing({ kind: "paste" })}>
          Paste .env
        </Button>
      </div>
      <EchoLine echo={echo} />
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
    </Setting>
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
      description={kind === "secret" ? "Sealed on this computer to the project's machine. fleetd shows only its fingerprint from now on." : "Shown here and kept by the hub."}
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
