// The model and effort behind each task profile: fleet-wide on Administration's hub settings (an admin's write), or
// a project's override in its settings. Reads profiles_get, writes profiles_set one profile at a time. A model claude
// refused shows as an alert under its profile: agents run on the profile's own until it is set again.
import { useState } from "react";
import type { ProfileSetting, ProfilesGetOutput, ProjectRef, TaskProfile } from "../../../shared/contracts";
import { useToolQuery } from "../../src/data/react";
import { Button, Field, Input, Segmented, Text } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { changed, draftOf, EFFORTS, follows, PROFILES, runLine, settingFrom, toSave, type ProfileDraft } from "./profilesModel";
import s from "./settings.module.css";

/** Both profiles at one scope: the fleet's without `projectRef`. `blocked` says why this key can't change it. */
export function ProfilesSetting({ projectRef, blocked }: { projectRef?: ProjectRef; blocked?: string }) {
  const query = useToolQuery("profiles_get", projectRef === undefined ? {} : { projectRef });
  // A hub from before profile settings has no profiles_get: nothing to show but why.
  const got: Partial<ProfilesGetOutput> | undefined = query.data;
  if (got?.runs === undefined || got.defaults === undefined || got.fleet === undefined) {
    return (
      <Text size="sm" tone="quiet">
        {query.error ? `Not read: ${errorText(query.error)}` : query.data === undefined ? "Loading…" : "This hub is too old to set them: update fleetd."}
      </Text>
    );
  }
  const view = got as ProfilesGetOutput;
  return (
    <div className={s.stack}>
      {PROFILES.map((p) => (
        <ProfileRow key={p.profile} view={view} profile={p.profile} projectRef={projectRef} blocked={blocked} />
      ))}
    </div>
  );
}

function ProfileRow(props: { view: ProfilesGetOutput; profile: TaskProfile; projectRef: ProjectRef | undefined; blocked: string | undefined }) {
  const { view, profile, projectRef, blocked } = props;
  const live = useLive();
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const project = projectRef !== undefined;
  const saved: ProfileSetting | undefined = project ? view.project?.[profile] : view.fleet[profile];
  const savedDraft = draftOf(saved);
  const [draft, setDraft] = useState<{ from: ProfileDraft; now: ProfileDraft }>({ from: savedDraft, now: savedDraft });
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  // The hub's newer setting replaces an untouched draft; an edit in progress stays.
  if (JSON.stringify(draft.from) !== JSON.stringify(savedDraft) && JSON.stringify(draft.now) === JSON.stringify(draft.from)) {
    setDraft({ from: savedDraft, now: savedDraft });
  }
  const meta = PROFILES.find((p) => p.profile === profile);
  const label = meta?.label ?? profile;
  const now = draft.now;
  const next = settingFrom(now);
  const follow = follows(view, profile, project);
  const edit = (patch: Partial<ProfileDraft>) => {
    setDraft({ from: draft.from, now: { ...now, ...patch } });
    setEcho(null);
  };
  const save = () => {
    if (!next.ok) return;
    setBusy(true);
    setEcho(null);
    hubCall("profiles_set", { ...(projectRef === undefined ? {} : { projectRef }), [profile]: toSave(next.setting, saved) }).then(
      (out) => {
        setBusy(false);
        setEcho({ ok: true, text: `Saved. ${out.next ?? ""}`.trim() });
        refetch(["profiles_get"]);
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: `Not changed: ${errorText(e)}` });
      },
    );
  };
  const off = !live || busy || blocked !== undefined;
  const followWord = project ? "the fleet's" : "the profile's own";
  return (
    <section className={s.stack} aria-label={`${label} profile`}>
      <div className={s.settingLabel}>
        <Text strong>{label}</Text>
        <Text size="xs" tone="quiet">
          {meta?.help}
        </Text>
      </div>
      <Text size="sm">{`New agents run on ${runLine(view.runs[profile])}.`}</Text>
      {saved?.refused === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="xs" tone="danger">{`${saved.model ?? "This model"} isn't used: ${saved.refused}`}</Text>
        </p>
      )}
      <Field label={`${label} model`} description={`Empty: ${followWord}, ${follow.model}.`} error={next.ok ? undefined : next.problem}>
        <Input mono value={now.model} placeholder={follow.model} disabled={off} maxLength={80} onChange={(e) => edit({ model: e.target.value })} />
      </Field>
      <Segmented
        label={`${label} effort`}
        options={EFFORTS.map((e) => (e.value === "default" ? { value: e.value, label: `Default (${follow.effort})` } : e))}
        value={now.effort}
        disabled={off}
        onChange={(effort) => edit({ effort })}
      />
      <div className={s.actions}>
        <Button variant="primary" disabled={off || !next.ok || !changed(now, saved)} onClick={save}>
          {busy ? "Saving…" : `Save ${label.toLowerCase()}`}
        </Button>
      </div>
      {blocked === undefined ? null : (
        <Text size="xs" tone="quiet">
          {blocked}
        </Text>
      )}
      {echo ? (
        <div role={echo.ok ? "status" : "alert"}>
          <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        </div>
      ) : null}
    </section>
  );
}
