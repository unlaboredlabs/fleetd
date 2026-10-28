// Task profiles (W146): Settings › Hub › Every project › Profiles lists the hub's profiles, each with its model, effort,
// fast mode and note, and creates, edits, renames and deletes them and marks the default (profile_create,
// profile_update, profile_delete: an owner's or admin's). Each project's Agents page picks which it allows
// (AllowedProfiles, project_set).
import { useState } from "react";
import type { Effort, Profile, ProfileModel, ProfileName, ProfilesListOutput, ProjectRef } from "../../../shared/contracts";
import { Button, Checkbox, Field, Input, Select, Switch, Text } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import {
  allowedAfter,
  createInput,
  draftOf,
  EFFORT_WORD,
  hasFast,
  modelChoices,
  newDraft,
  NOTE_MAX,
  problem,
  runsLine,
  updateInput,
  type ProfileDraft,
} from "./profilesModel";
import s from "./settings.module.css";

const noInput = {};

/** Which profile is open in the editor: a new one, or one by id. */
type Editing = { kind: "new" } | { kind: "edit"; id: number };

/** The hub's profiles, each a row with Edit, and New profile; one opens in the editor in its row's place. */
export function ProfilesEditor() {
  const live = useLive();
  const list = useToolQuery("profiles_list", noInput, { enabled: live });
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [echo, setEcho] = useState<string | undefined>(undefined);
  if (!live) return <Text tone="quiet">Connect to the hub to see and change its profiles.</Text>;
  const view = list.data;
  if (view === undefined) return <Text tone="quiet">{list.error ? `Not read: ${errorText(list.error)}` : "Loading…"}</Text>;
  const done = (said: string | undefined) => {
    setEditing(undefined);
    setEcho(said);
  };
  return (
    <div className={s.stack}>
      <div className={s.repoList} aria-label="Profiles" role="list">
        {view.profiles.map((p) =>
          editing?.kind === "edit" && editing.id === p.id ? (
            <div key={p.id} className={s.repoRow} role="listitem">
              <ProfileForm view={view} saved={p} onDone={done} />
            </div>
          ) : (
            <ProfileRow key={p.id} profile={p} models={view.models} onEdit={() => (setEcho(undefined), setEditing({ kind: "edit", id: p.id }))} />
          ),
        )}
      </div>
      {editing?.kind === "new" ? (
        <ProfileForm view={view} onDone={done} />
      ) : (
        <div className={s.actions}>
          <Button variant="secondary" onClick={() => (setEcho(undefined), setEditing({ kind: "new" }))}>
            New profile
          </Button>
          <Text size="xs" tone="quiet">
            {view.modelsFrom === "api" ? "Models as the hub's API key lists them." : "Models from fleetd's own list: the hub has no API key that lists them."}
          </Text>
        </div>
      )}
      <div role="status">
        {echo === undefined ? null : (
          <Text size="xs" tone="quiet">
            {echo}
          </Text>
        )}
      </div>
    </div>
  );
}

function ProfileRow({ profile: p, models, onEdit }: { profile: Profile; models: ReadonlyArray<ProfileModel>; onEdit: () => void }) {
  return (
    <div className={s.repoRow} role="listitem" aria-label={p.name} data-profile={p.name}>
      <div className={s.inline}>
        <Text strong mono>
          {p.name}
        </Text>
        {p.default ? (
          <Text size="xs" tone="quiet">
            default
          </Text>
        ) : null}
        <Text size="sm" tone="quiet">
          {runsLine(models, p)}
        </Text>
        <span style={{ marginLeft: "auto" }}>
          <Button variant="quiet" size="sm" onClick={onEdit} aria-label={`Edit ${p.name}`}>
            Edit
          </Button>
        </span>
      </div>
      {p.note === "" ? null : <Text size="sm">{p.note}</Text>}
      {p.refused === undefined ? null : (
        <Text size="xs" tone="danger">
          {p.refused}
        </Text>
      )}
    </div>
  );
}

/** A profile's editor: a new one without `saved`. Its default can't be unmarked or deleted, only replaced. */
function ProfileForm({ view, saved, onDone }: { view: ProfilesListOutput; saved?: Profile; onDone: (said: string | undefined) => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [draft, setDraft] = useState<ProfileDraft>(() => (saved ? draftOf(saved) : newDraft(view.models)));
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
  const label = saved ? `Edit ${saved.name}` : "New profile";
  return (
    <section className={s.stack} aria-label={label}>
      <Text strong>{label}</Text>
      <Field label="Name" description="The word the lead names it by: lowercase, no spaces." error={draft.name !== "" && wrong?.field === "name" ? wrong.text : undefined}>
        <Input mono value={draft.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Use for" description="One line: the work the lead should run on it." error={wrong?.field === "note" ? wrong.text : undefined}>
        <Input value={draft.note} maxLength={NOTE_MAX} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      <div className={s.inline}>
        <Field label="Model">
          <Select
            aria-label="Model"
            value={draft.model}
            options={modelChoices(view.models, saved?.model).map((m) => ({ value: m.id, label: m.displayName ?? m.id, textValue: m.displayName ?? m.id }))}
            onValueChange={(model) => set({ model })}
          />
        </Field>
        <Field label="Reasoning">
          <Select<Effort> aria-label="Reasoning" value={draft.effort} options={view.efforts.map((e) => ({ value: e, label: EFFORT_WORD[e] }))} onValueChange={(effort) => set({ effort })} />
        </Field>
      </div>
      <Switch
        label="Fast mode"
        description={fast ? "Faster answers at a higher price per token." : "This model has no fast mode."}
        checked={draft.fast && fast}
        disabled={!fast}
        onCheckedChange={(on) => set({ fast: on })}
      />
      <Checkbox
        label="The default"
        description={saved?.default ? "Every project allows it; the lead, every review and helper calls run on it. Make another the default to change it." : "Every project allows it; the lead, every review and helper calls run on it."}
        checked={draft.default}
        disabled={saved?.default === true}
        onCheckedChange={(on) => set({ default: on === true })}
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
              <Text size="sm">{`Delete ${saved.name}? No project allows it after.`}</Text>
              <Button variant="danger" disabled={busy} onClick={() => run(call("profile_delete", { id: saved.id }))}>
                Delete
              </Button>
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
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="xs" tone="danger">{`Not saved: ${error}`}</Text>
        </p>
      )}
    </section>
  );
}

/**
 * A project's Agents page: a checkbox for each of the hub's profiles, checked for each its agents may run on
 * (project_set). The default is always allowed: checked, and can't be unchecked.
 */
export function AllowedProfiles({ projectRef }: { projectRef: ProjectRef }) {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const list = useToolQuery("profiles_list", { projectRef }, { enabled: live });
  const [busy, setBusy] = useState<ProfileName | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const view = list.data;
  if (view === undefined) return list.error ? <Text tone="danger">{`Not read: ${errorText(list.error)}`}</Text> : null;
  const allowed = view.allowed ?? [];
  const defaultName = view.profiles.find((p) => p.default)?.name;
  const toggle = (name: ProfileName, on: boolean) => {
    setBusy(name);
    setError(undefined);
    call("project_set", { ...projectRef, profiles: allowedAfter(allowed, defaultName, name, on) })
      .then(() => refetch(["profiles_list", "project_get"]))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(undefined));
  };
  return (
    <div className={s.stack}>
      {view.profiles.map((p) => (
        <Checkbox
          key={p.id}
          label={
            <>
              <Text mono>{p.name}</Text>
              <Text size="xs" tone="quiet">{` ${runsLine(view.models, p)}`}</Text>
            </>
          }
          description={p.default ? `Always allowed.${p.note === "" ? "" : ` ${p.note}`}` : p.note === "" ? undefined : p.note}
          checked={p.default || allowed.includes(p.name)}
          disabled={!live || p.default || busy !== undefined}
          onCheckedChange={(on) => toggle(p.name, on === true)}
        />
      ))}
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="xs" tone="danger">{`Not changed: ${error}`}</Text>
        </p>
      )}
    </div>
  );
}
