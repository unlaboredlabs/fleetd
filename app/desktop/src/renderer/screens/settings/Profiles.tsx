// Task profiles (W146): Settings › Hub › Providers lists the hub's profiles under the provider each runs on, each with
// its model, effort, fast mode and note, and creates, edits, renames and deletes them (profile_create, profile_update,
// profile_delete: an owner's or admin's). Every project › Agents picks the default and the one leads start on (Default
// profile and Lead runs on: profile_update's `default` and `lead`). Each project's Agents page picks which it allows
// (AllowedProfiles, project_set) and its lead's own (Lead model).
import { useState } from "react";
import type { Effort, Profile, ProfileModel, ProfileName, ProfilesListOutput, ProfileUpdateInput, ProjectRef, ProjectSetInput } from "../../../shared/contracts";
import { Button, Field, Input, Select, Switch, Text, Toggle } from "../../ui";
import { useCloudTeam, useToolQuery } from "../../src/data/react";
import { useAdministers } from "../admin/role";
import { modelShort, providerOf, type AgentProvider } from "../../../shared/agentProviders";
import { GoogleConnect } from "./GoogleSignIn";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import {
  ADD_PROFILE,
  allowedAfter,
  createInput,
  deleteWords,
  draftOf,
  EFFORT_WORD,
  hasFast,
  byProviderOf,
  leadOf,
  newDraft,
  NOTE_MAX,
  problem,
  providerModels,
  runsLine,
  updateInput,
  type ProfileDraft,
} from "./profilesModel";
import { AddButton, DangerButton, GroupNote, Notice, SettingsList, SettingsListRow, SettingsRow, SettingsSection } from "./parts";
import s from "./settings.module.css";
import { settingsPath } from "../../../shared/settingsPages";
import { navigate } from "../shell/navigation";

const noInput = {};
/** The Lead model option that follows the hub's lead profile: no profile can be named it. */
const HUB_LEAD = "@hub";

/** Add profile… opens Providers, where a profile is made under its provider. */
const openProviders = () => navigate({ id: "settings", tab: "hub.providers" });

/**
 * A profile picker's options: the profiles by provider (one claude refused can't be picked, and says why), then Add
 * profile…, which a member sees greyed, with who makes one and where.
 */
function profileOptions(view: ProfilesListOutput, admin: boolean, cloud: boolean, more: (p: Profile) => string = () => "") {
  return [
    ...byProviderOf(view.profiles).map(({ profile: p, group }) => ({
      value: p.name,
      label: (
        <>
          <Text mono>{p.name}</Text>
          <Text size="xs" tone="quiet">{` ${runsLine(view.models, p)}${more(p)}`}</Text>
        </>
      ),
      textValue: p.name,
      group,
      ...(p.refused === undefined ? {} : { disabled: true, title: p.refused }),
    })),
    {
      value: ADD_PROFILE,
      label: "Add profile…",
      textValue: "Add profile…",
      ...(admin ? {} : { disabled: true, title: `An owner or admin adds profiles under each provider in ${settingsPath(cloud, "Providers")}.` }),
    },
  ];
}

/** Which profile is open in Providers' editor: a new one under a provider, or one by id. */
export type Editing = { kind: "new"; provider: AgentProvider["id"] } | { kind: "edit"; id: number };

/**
 * A provider's profiles, under its row on Providers: each a row that opens its editor in the row's place, and a new
 * one's editor at their end once its provider's Add profile is pressed. While the provider isn't connected
 * (`unusable`), each says so: agents can't run on it until it does. With none, No profiles yet: the provider's row's
 * plus is the one way to add one.
 */
export function ProviderProfiles(props: {
  provider: AgentProvider;
  view: ProfilesListOutput;
  unusable: boolean;
  editing: Editing | undefined;
  onEdit: (id: number) => void;
  onDone: (said: string | undefined) => void;
}) {
  const { provider, view, editing } = props;
  const mine = view.profiles.filter((p) => providerOf(p.model).id === provider.id);
  const lead = leadOf(view.profiles)?.id;
  const row = (p: Profile) => (
    <ProfileRow
      key={p.id}
      profile={p}
      lead={p.id === lead}
      models={view.models}
      unusable={props.unusable ? `Unusable until ${provider.name} connects` : undefined}
      onEdit={() => props.onEdit(p.id)}
    />
  );
  // The profile open in the editor takes its row's place: the rows before it, the editor, the rows after it.
  const at = editing?.kind === "edit" ? mine.findIndex((p) => p.id === editing.id) : -1;
  const open = mine[at];
  const before = at === -1 ? mine : mine.slice(0, at);
  const after = at === -1 ? [] : mine.slice(at + 1);
  const adding = editing?.kind === "new" && editing.provider === provider.id;
  const label = `${provider.name} profiles`;
  if (mine.length === 0 && !adding) return <GroupNote>No profiles yet</GroupNote>;
  return (
    <>
      {before.length === 0 ? null : (
        <SettingsList label={label} nested>
          {before.map(row)}
        </SettingsList>
      )}
      {open === undefined ? null : <ProfileForm view={view} provider={provider} saved={open} onDone={props.onDone} />}
      {after.length === 0 ? null : (
        <SettingsList label={label} nested>
          {after.map(row)}
        </SettingsList>
      )}
      {adding ? <ProfileForm view={view} provider={provider} onDone={props.onDone} /> : null}
    </>
  );
}

/**
 * Every project › Agents' profiles: the default (every bot allows it; reviews and tasks that name no profile run on it)
 * and the one every lead runs on, each picked from the profiles Providers lists under each provider.
 */
export function ProfilePicks() {
  const live = useLive();
  const cloud = useCloudTeam();
  const list = useToolQuery("profiles_list", noInput, { enabled: live });
  const [echo, setEcho] = useState<string | undefined>(undefined);
  const view = list.data;
  return (
    <SettingsSection title="Profiles" hint={`Made under each provider in ${settingsPath(cloud, "Providers")}.`}>
      {!live ? (
        <GroupNote>Connect to the hub to see and change its profiles.</GroupNote>
      ) : view === undefined ? (
        <GroupNote tone={list.error ? "danger" : "quiet"}>{list.error ? `Not read: ${errorText(list.error)}` : "Loading…"}</GroupNote>
      ) : (
        <>
          <ProfilePick view={view} kind="default" reveal="hub.default-profile" onDone={setEcho} />
          <ProfilePick view={view} kind="lead" reveal="hub.lead" onDone={setEcho} />
          {echo === undefined ? null : (
            <GroupNote>
              <span role="status">{echo}</span>
            </GroupNote>
          )}
        </>
      )}
    </SettingsSection>
  );
}

const PICK = {
  default: {
    title: "Default profile",
    hint: "Every bot allows it; every review, helper call and task that names no profile runs on it.",
  },
  lead: {
    title: "Lead runs on",
    hint: "Every bot's lead but those that pick their own on their Agents page. Each running lead switches to it at its next idle moment, keeping its chat. Reviews and tasks that name no profile stay on the default.",
  },
} as const;

/** Default profile, or Lead runs on: the profile every lead starts on, the default until another is picked. Picking
 * the default there has leads follow the default again. */
function ProfilePick({ view, kind, reveal, onDone }: { view: ProfilesListOutput; kind: keyof typeof PICK; reveal: string; onDone: (said: string | undefined) => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const current = kind === "lead" ? leadOf(view.profiles) : view.profiles.find((p) => p.default);
  const words = PICK[kind];
  const cloud = useCloudTeam();
  const pick = (name: string) => {
    if (name === ADD_PROFILE) return openProviders();
    const p = view.profiles.find((q) => q.name === name);
    if (p === undefined || p.id === current?.id) return;
    setBusy(true);
    setError(undefined);
    const input: ProfileUpdateInput = kind === "lead" ? { id: p.id, lead: true } : { id: p.id, default: true };
    call("profile_update", input)
      .then((out) => {
        refetch(["profiles_list", "project_get"]);
        onDone(out.next);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <SettingsRow
      reveal={reveal}
      title={words.title}
      hint={words.hint}
      line={error === undefined ? null : `Not changed: ${error}`}
      lineTone={error === undefined ? undefined : "danger"}
      control={
        <Select
          aria-label={words.title}
          value={current?.name ?? ""}
          disabled={busy}
          options={profileOptions(view, true, cloud, (p) => (kind === "lead" && p.default ? " · default" : ""))}
          onValueChange={pick}
        />
      }
    />
  );
}

function ProfileRow({ profile: p, lead, models, unusable, onEdit }: { profile: Profile; lead: boolean; models: ReadonlyArray<ProfileModel>; unusable: string | undefined; onEdit: () => void }) {
  return (
    <SettingsListRow
      name={<Text mono>{p.name}</Text>}
      label={p.name}
      data={{ "data-profile": p.name, ...(unusable === undefined ? {} : { "data-unusable": "" }) }}
      meta={[p.default ? "default" : null, lead ? "lead" : null].filter((w) => w !== null).join(" · ") || undefined}
      state={unusable === undefined ? undefined : { word: unusable, tone: "warning" }}
      hint={p.note === "" ? undefined : p.note}
      open={{ onClick: onEdit }}
      controls={
        <Text size="sm" tone="quiet">
          {runsLine(models, p)}
        </Text>
      }
    >
      {p.refused === undefined ? null : <Notice tone="danger">{p.refused}</Notice>}
    </SettingsListRow>
  );
}

/** A profile's editor under its provider, on that provider's models: a new one without `saved`. The default can't be
 * deleted, only replaced (Every project › Agents' Default profile). */
function ProfileForm({ view, provider, saved, onDone }: { view: ProfilesListOutput; provider: AgentProvider; saved?: Profile; onDone: (said: string | undefined) => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const models = providerModels(view.models, provider.id, saved?.model);
  const [draft, setDraft] = useState<ProfileDraft>(() => (saved ? draftOf(saved) : newDraft(models)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const set = (change: Partial<ProfileDraft>) => setDraft({ ...draft, ...change });
  const taken = view.profiles.filter((p) => p.id !== saved?.id).map((p) => p.name);
  const wrong = problem(draft, taken);
  const fast = hasFast(view.models, draft.model);
  const update = saved ? updateInput(view.models, saved, draft) : undefined;
  const run = (go: Promise<{ next?: string }>) => {
    setBusy(true);
    setError(undefined);
    go.then(
      (out) => {
        setBusy(false);
        refetch(["profiles_list", "project_get"]);
        onDone(out.next);
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };
  const save = () => {
    if (wrong !== undefined) return;
    if (saved === undefined) run(call("profile_create", createInput(view.models, draft)));
    else if (update !== undefined) run(call("profile_update", update));
  };
  const label = saved ? `Edit ${saved.name}` : `New ${provider.name} profile`;
  return (
    <SettingsRow title={label}>
      <Field label="Name" description="The word the lead names it by: lowercase, no spaces." error={draft.name !== "" && wrong?.field === "name" ? wrong.text : undefined}>
        <Input mono value={draft.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Use for" description="One line: the work the lead should run on it." error={wrong?.field === "note" ? wrong.text : undefined}>
        <Input value={draft.note} maxLength={NOTE_MAX} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      <div className={s.inline}>
        <Field label="Model">
          <Select aria-label="Model" value={draft.model} options={models.map((m) => ({ value: m.id, label: modelShort(m), textValue: m.displayName ?? m.id }))} onValueChange={(model) => set({ model })} />
        </Field>
        <Field label="Reasoning">
          <Select<Effort> aria-label="Reasoning" value={draft.effort} options={view.efforts.map((e) => ({ value: e, label: EFFORT_WORD[e] }))} onValueChange={(effort) => set({ effort })} />
        </Field>
      </div>
      {/* Where Anthropic's models come from, under the two fields so neither stands lower than the other. */}
      {provider.id === "anthropic" && view.modelsFrom === "builtin" ? (
        <Text size="sm" tone="quiet">
          The models are fleetd&apos;s own list until a Claude API key is saved in Setup.
        </Text>
      ) : null}
      <Switch
        label="Fast mode"
        description={fast ? "Faster answers at a higher price per token." : "This model has no fast mode."}
        checked={draft.fast && fast}
        disabled={!fast}
        onCheckedChange={(on) => set({ fast: on })}
      />
      <div className={s.actions}>
        <Button variant="primary" disabled={busy || wrong !== undefined || (saved !== undefined && update === undefined)} onClick={save}>
          {busy ? "Saving…" : saved ? "Save" : "Create profile"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => onDone(undefined)}>
          Cancel
        </Button>
        {saved && !saved.default ? (
          deleting ? (
            <>
              <Text size="sm">{deleteWords(saved, view.profiles.find((p) => p.default)?.name)}</Text>
              <DangerButton disabled={busy} onClick={() => run(call("profile_delete", { id: saved.id }))}>
                Delete
              </DangerButton>
              <Button variant="ghost" disabled={busy} onClick={() => setDeleting(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="quiet" disabled={busy} onClick={() => setDeleting(true)}>
              Delete…
            </Button>
          )
        ) : null}
      </div>
      {/* Why Save can't be pressed, where the fields don't already say. */}
      {busy || deleting ? null : wrong?.field === "name" && draft.name === "" ? (
        <Text size="sm" tone="quiet">
          {wrong.text}
        </Text>
      ) : saved !== undefined && wrong === undefined && update === undefined ? (
        <Text size="sm" tone="quiet">
          Nothing changed yet.
        </Text>
      ) : null}
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="xs" tone="danger">{`Not saved: ${error}`}</Text>
        </p>
      )}
    </SettingsRow>
  );
}

/**
 * A project's Agents page: a checkbox for each of the hub's profiles, checked for each its agents may run on
 * (project_set). The default is always allowed: checked, and can't be unchecked. Under them, Lead model: the profile
 * its lead starts on, the hub's lead profile until it picks its own (project_set leadProfile, any of the hub's but
 * one claude refused), with Restart lead beside it: on the pick, or on the one it runs on, as a stuck lead needs.
 * Profiles alone, by provider: a new one is made on Providers, which the section's plus and the picker's Add profile…
 * open for an admin.
 */
export function AllowedProfiles({ projectRef }: { projectRef: ProjectRef }) {
  const cloud = useCloudTeam();
  const admin = useAdministers();
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const list = useToolQuery("profiles_list", { projectRef }, { enabled: live });
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const view = list.data;
  if (view === undefined) return list.error ? <Text tone="danger">{`Not read: ${errorText(list.error)}`}</Text> : null;
  const allowed = view.allowed ?? [];
  const defaultName = view.profiles.find((p) => p.default)?.name;
  const lead = leadOf(view.profiles);
  const set = (busyWith: string, input: Omit<ProjectSetInput, "machineId" | "projectId">) => {
    setBusy(busyWith);
    setError(undefined);
    call("project_set", { ...projectRef, ...input })
      .then(() => refetch(["profiles_list", "project_get"]))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(undefined));
  };
  const toggle = (name: ProfileName, on: boolean) => set(name, { profiles: allowedAfter(allowed, defaultName, name, on) });
  const pickLead = (name: string) => {
    if (name === (view.leadProfile ?? HUB_LEAD)) return;
    if (name === ADD_PROFILE) return openProviders();
    set("lead", name === HUB_LEAD ? { leadDefault: true } : { leadProfile: name });
  };
  const leadModel = view.profiles.find((p) => p.name === (view.leadProfile ?? lead?.name))?.model;
  const restart = () => set("lead", { leadRestart: true });
  return (
    <SettingsSection
      title="Allowed profiles"
      reveal="agents.profiles"
      aside={admin ? <AddButton label="Add profile" onClick={openProviders} /> : undefined}
      hint={`The task profiles its lead may run agents on. The hub's default is always allowed; the hub's admins make profiles under each provider in ${settingsPath(cloud, "Providers")}.`}
    >
      {view.profiles.map((p) => (
        <SettingsRow
          key={p.id}
          title={
            <span className={s.titleMeta}>
              <Text mono>{p.name}</Text>
              <Text size="sm" tone="quiet">
                {runsLine(view.models, p)}
              </Text>
            </span>
          }
          label={p.name}
          hint={p.default ? `Always allowed: the hub's default.${p.note === "" ? "" : ` ${p.note}`}` : p.note === "" ? undefined : p.note}
          control={
            p.default ? (
              <Text size="sm" tone="quiet">
                Always
              </Text>
            ) : (
              <Toggle aria-label={`Allow ${p.name}`} checked={allowed.includes(p.name)} disabled={!live || busy !== undefined} onCheckedChange={(on) => toggle(p.name, on)} />
            )
          }
        />
      ))}
      {lead === undefined ? null : (
        <SettingsRow
          title="Lead model"
          data={{ "data-lead-profile": view.leadProfile ?? lead.name }}
          control={
            <span className={s.leadControl}>
              {view.leadRestarting ? (
                <Text size="sm" tone="quiet">
                  Restarts after its turn
                </Text>
              ) : (
                <Button size="sm" variant="ghost" disabled={!live || busy !== undefined} onClick={restart}>
                  Restart lead
                </Button>
              )}
              <Select
                aria-label="Lead model"
                value={view.leadProfile ?? HUB_LEAD}
                disabled={!live || busy !== undefined}
                options={[
                  { value: HUB_LEAD, label: `Hub default (${lead.name})`, textValue: `Hub default (${lead.name})` },
                  ...profileOptions(view, admin, cloud),
                ]}
                onValueChange={pickLead}
              />
            </span>
          }
        />
      )}
      {leadModel !== undefined && providerOf(leadModel).id === "google" ? <GoogleConnect project={projectRef} /> : null}
      {error === undefined ? null : <Notice tone="danger">{`Not changed: ${error}`}</Notice>}
    </SettingsSection>
  );
}
