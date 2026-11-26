// The Automations tab's Watching group: the bot's watchers, each a look at one thing (about its software, where it has a
// repo) on a schedule that says one line in the chat only when something is off. A row is what it watches, then how often, its profile and
// its last day's cost, with its on switch; + adds one (a preset the bot can have, or one sentence). Its menu looks now,
// edits how often and the profile, shows its runs, and deletes it.
import { useState } from "react";
import type { Automation, AutomationWatch, KnownWatchEvery, KnownWatchKind, ProfileName, ProjectRef, WatchKind } from "../../../shared/contracts";
import { Button, Dialog, Field, Input, Segmented, Select, Text, Toggle } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { AddButton, GroupNote, RowMenu, SettingsRow, SettingsSection } from "../settings/parts";
import { BOT_ADMIN_ONLY, useBotLocked } from "../settings/botAdmin";
import settings from "../settings/settings.module.css";
import { localZone } from "./model";
import { Runs } from "./Runs";
import s from "./automations.module.css";
import { EVERY_OPTIONS, kindLabel, offered, SENTENCE_MAX, sentenceProblem, watchersAbout, watcherInput, watchLine } from "./watchModel";

const READS = ["automation_list", "automation_runs"] as const;
/** The Select's value for "the bot's default profile". */
const DEFAULT = "__default__";

export function Watching(props: { projectRef: ProjectRef; watchers: Automation[]; watchable: WatchKind[] | undefined }) {
  const live = useLive();
  const profiles = useToolQuery("profiles_list", { projectRef: props.projectRef }, { enabled: live });
  const [editing, setEditing] = useState<string | null>(null);
  const allowed = profiles.data?.allowed ?? [];
  const defaultProfile = profiles.data?.profiles.find((p) => p.default)?.name;
  const kinds = offered(props.watchable, props.watchers);
  // A member sees the watchers and looks now; only an admin makes, changes or stops one.
  const locked = useBotLocked();
  return (
    <SettingsSection
      title="Watching"
      hint={watchersAbout(props.watchable)}
      intro={locked ? BOT_ADMIN_ONLY : undefined}
      aside={editing === "new" || locked ? undefined : <AddButton label="New watcher" disabled={kinds.length === 0} onClick={() => setEditing("new")} />}
      data={{ "data-group": "watching" }}
    >
      {editing === "new" ? (
        <Editor projectRef={props.projectRef} kinds={kinds} allowed={allowed} defaultProfile={defaultProfile} onClose={() => setEditing(null)} />
      ) : null}
      {props.watchers.length === 0 && editing !== "new" ? <GroupNote>Nothing watched yet.</GroupNote> : null}
      {props.watchers.length === 0 ? null : (
        <ul className={s.list} aria-label="Watchers">
          {props.watchers.map((w) => (
            <li key={w.automationId}>
              {editing === w.automationId ? (
                <Editor
                  projectRef={props.projectRef}
                  watcher={w}
                  kinds={[w.watch?.kind as KnownWatchKind]}
                  allowed={allowed}
                  defaultProfile={defaultProfile}
                  onClose={() => setEditing(null)}
                />
              ) : (
                <Row watcher={w} defaultProfile={defaultProfile} locked={locked} onEdit={() => setEditing(w.automationId)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

/** One watcher: its name, its line, its switch and menu; its runs under it when opened. */
function Row(props: { watcher: Automation; defaultProfile: string | undefined; locked: boolean; onEdit: () => void }) {
  const a = props.watcher;
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  const [history, setHistory] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const act = (work: () => Promise<string | null>) => {
    setBusy(true);
    setEcho(null);
    work().then(
      (done) => {
        setBusy(false);
        if (done) setEcho({ ok: true, text: done });
        refetch([...READS]);
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };
  const looking = a.lastRun?.state === "running";
  return (
    <SettingsRow
      title={
        <>
          {a.name}
          {looking ? (
            <Text size="sm" tone="accent" className={s.state}>
              Looking
            </Text>
          ) : null}
        </>
      }
      label={a.name}
      data={{ "data-watcher": a.automationId }}
      line={watchLine(a, props.defaultProfile)}
      control={
        <div className={settings.actions}>
          <Toggle
            aria-label={`Watch ${a.name}`}
            checked={!a.paused}
            disabled={busy || props.locked}
            onCheckedChange={(on) =>
              act(async () => {
                await hubCall("automation_pause", { automationId: a.automationId, paused: !on });
                return null;
              })
            }
          />
          <RowMenu
            label={a.name}
            disabled={busy}
            items={[
              {
                label: "Look now",
                onSelect: () =>
                  act(async () => {
                    const out = await hubCall("automation_run", { automationId: a.automationId });
                    return out.run.state === "running" ? "Looking. It speaks in the chat only if something is off." : `Not now: ${out.run.why ?? "skipped"}.`;
                  }),
              },
              ...(props.locked ? [] : [{ label: "Edit", onSelect: props.onEdit }]),
              { label: history ? "Hide runs" : "Runs", onSelect: () => setHistory(!history) },
              ...(props.locked ? [] : [{ label: "Delete", onSelect: () => setDeleting(true), danger: true }]),
            ]}
          />
        </div>
      }
    >
      {echo ? (
        <div role="status">
          <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        </div>
      ) : null}
      {history ? <Runs automationId={a.automationId} projectRef={a.projectRef} /> : null}
      <Dialog
        open={deleting}
        onOpenChange={(open) => !open && setDeleting(false)}
        title={`Stop watching ${a.name}?`}
        description="It stops looking, and its run history goes. What it said in the chat stays."
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>Keep it</Button>
            <Button
              variant="danger"
              onClick={() => {
                setDeleting(false);
                act(async () => {
                  await hubCall("automation_delete", { automationId: a.automationId });
                  return null;
                });
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </SettingsRow>
  );
}

/** A new watcher (what to watch, how often, the profile) or one being edited (how often and the profile). */
function Editor(props: {
  projectRef: ProjectRef;
  watcher?: Automation;
  kinds: KnownWatchKind[];
  allowed: ProfileName[];
  defaultProfile: string | undefined;
  onClose: () => void;
}) {
  const w = props.watcher;
  const [kind, setKind] = useState<KnownWatchKind>(((w?.watch?.kind as KnownWatchKind | undefined) ?? props.kinds[0]) ?? "other");
  const [sentence, setSentence] = useState("");
  const [every, setEvery] = useState<KnownWatchEvery>((w?.watch?.every as KnownWatchEvery | undefined) ?? (kind === "other" ? "hour" : "15m"));
  const [profile, setProfile] = useState<string>(w?.watch?.profile ?? DEFAULT);
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const problem = w ? undefined : sentenceProblem(kind, sentence);
  const watch: AutomationWatch = { kind, every, ...(profile === DEFAULT ? {} : { profile }) };

  const save = () => {
    setTried(true);
    if (problem !== undefined) return;
    setBusy(true);
    setError(null);
    const work = w
      ? hubCall("automation_update", { automationId: w.automationId, watch })
      : hubCall("automation_create", watcherInput(watch, sentence, props.projectRef, localZone(), requestId));
    work.then(
      () => {
        setBusy(false);
        refetch([...READS]);
        props.onClose();
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };

  const profileOptions = [
    { value: DEFAULT, label: props.defaultProfile ? `${props.defaultProfile} (default)` : "Default" },
    ...props.allowed.filter((p) => p !== props.defaultProfile).map((p) => ({ value: p, label: p })),
  ];
  return (
    <SettingsRow title={w ? `Edit ${w.name}` : "New watcher"}>
      {/* A pick of one (Something else alone, as on a bot with no repo) isn't a choice: no switch. */}
      {w || props.kinds.length < 2 ? null : (
        <Segmented<KnownWatchKind> label="Watch" options={props.kinds.map((k) => ({ value: k, label: kindLabel(k) }))} value={kind} onChange={setKind} />
      )}
      {!w && kind === "other" ? (
        <Field label="What to watch" error={tried ? problem : undefined}>
          <Input
            value={sentence}
            maxLength={SENTENCE_MAX}
            placeholder="Watch the checkout errors in Sentry"
            autoFocus
            onChange={(e) => setSentence(e.target.value)}
          />
        </Field>
      ) : null}
      <Segmented<KnownWatchEvery> label="How often" options={EVERY_OPTIONS} value={every} onChange={setEvery} />
      <Field label="Profile">
        <Select<string> aria-label="Profile" value={profile} onValueChange={setProfile} options={profileOptions} />
      </Field>
      <div className={settings.actions}>
        <Button variant="primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : w ? "Save" : "Watch"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={props.onClose}>
          Cancel
        </Button>
      </div>
      <div role="status">{error ? <Text tone="danger">{error}</Text> : null}</div>
    </SettingsRow>
  );
}
