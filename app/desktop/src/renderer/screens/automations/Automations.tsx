// Settings → Projects › Automations: one project's automations (the project picked in the sidebar), each a prompt the project's lead runs on a schedule, from a
// webhook or on Run now. Each run opens an order the lead starts on its own; reviews, the merge train and approvals
// still apply. A person makes, edits, pauses, runs and deletes them here and reads their runs, each linked to its
// order. A webhook URL holds its secret, so the hub returns it only when it is made or rotated: shown once, here.
// The nightly memory refresh isn't one of them: it is on the project's Instructions & memory, beside the memory it tidies.
import { useEffect, useState } from "react";
import type { Automation, ProjectRef } from "../../../shared/contracts";
import { Button, Dialog, Field, Input, StatusChip, Switch, Text, Textarea, copyText, type TextTone } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { parseScope, projectRefOf, type Scope } from "../settings/editor";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { AddButton, DangerButton, GroupNote, PageHead, scopeName, SettingsRow, SettingsSection, useProjects } from "../settings/parts";
import { replaceRoute, type SettingsRoute } from "../settings/route";
import settings from "../settings/settings.module.css";
import { describeCron } from "./cron";
import {
  NAME_MAX,
  PROMPT_MAX,
  createInput,
  draftOf,
  emptyDraft,
  hasProblems,
  localZone,
  onceLine,
  orderHref,
  problems,
  runChip,
  runNote,
  triggerWord,
  triggersLine,
  updateInput,
  when,
  type Draft,
} from "./model";
import s from "./automations.module.css";

const READS = ["automation_list", "automation_runs"] as const;

export function Automations({ route }: { route: SettingsRoute }) {
  const live = useLive();
  const projects = useProjects();
  const picked = route.for ? parseScope(route.for) : null;
  const project: Scope | null = picked?.kind === "project" ? picked : null;
  const ref = project ? projectRefOf(project) : undefined;
  const list = useToolQuery("automation_list", { projectRef: ref ?? { machineId: "", projectId: "" } }, { enabled: live && ref !== undefined });
  const [editing, setEditing] = useState<string | null>(null);
  const [url, setUrl] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    replaceRoute({ tab: "automations", for: route.for });
  }, [route.for]);

  if (!live) {
    return (
      <div className={settings.scroll} data-screen="settings.automations">
        <div className={settings.column}>
          <PageHead title="Automations" />
          <SettingsSection>
            <GroupNote>Not connected. Connect to a hub to see its automations.</GroupNote>
          </SettingsSection>
        </div>
      </div>
    );
  }

  const automations = list.data?.automations ?? [];
  const name = project ? scopeName(project, projects) : null;
  return (
    <div className={settings.scroll} data-screen="settings.automations">
      <div className={settings.column}>
        <PageHead title="Automations" />
        {url ? <WebhookUrl {...url} onDone={() => setUrl(null)} /> : null}
        <SettingsSection
          aside={ref && editing === "new" ? undefined : <AddButton label="New automation" disabled={!ref} onClick={() => setEditing("new")} />}
        >
          {list.isLoadingError ? (
            <SettingsRow
              title={<Text tone="danger">{errorText(list.error)}</Text>}
              label="Couldn't read the automations"
              control={<Button onClick={() => void list.refetch()}>Try again</Button>}
            />
          ) : null}
          {ref && editing === "new" ? <Editor projectRef={ref} onClose={() => setEditing(null)} onUrl={(u) => setUrl(u)} /> : null}
          {list.data && automations.length === 0 && editing !== "new" ? <GroupNote>{name ? `${name} has no automations yet.` : "Pick a project."}</GroupNote> : null}
          {list.data === undefined && !list.isLoadingError && ref ? <GroupNote>Loading automations…</GroupNote> : null}
          {automations.length === 0 ? null : (
            <ul className={s.list} aria-label="Automations">
              {automations.map((a) =>
                ref && editing === a.automationId ? (
                  <li key={a.automationId}>
                    <Editor projectRef={ref} automation={a} onClose={() => setEditing(null)} onUrl={(u) => setUrl(u)} />
                  </li>
                ) : (
                  <li key={a.automationId}>
                    <Card automation={a} onEdit={() => setEditing(a.automationId)} onUrl={(u) => setUrl(u)} />
                  </li>
                ),
              )}
            </ul>
          )}
        </SettingsSection>
      </div>
    </div>
  );
}

/** A webhook URL the hub just made: shown once, with Copy. */
function WebhookUrl(props: { name: string; url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <SettingsSection title="Webhook URL">
      <SettingsRow
        title={`Webhook URL for ${props.name}`}
        lineTone="warning"
        hint="POST to it to start a run with the request body as context. Rotate makes a new one and the old one stops working."
        line="It holds a secret and is shown only now: copy it."
      >
        <div data-text="code">
          <Input mono readOnly value={props.url} aria-label="Webhook URL" onFocus={(e) => e.currentTarget.select()} />
        </div>
        <div className={settings.actions}>
          <Button variant="primary" onClick={() => void copyText(props.url).then(() => setCopied(true))}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" onClick={props.onDone}>
            Done
          </Button>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

/** One automation: its triggers, state and last run, its actions, and (opened) its runs. */
function Card(props: { automation: Automation; onEdit: () => void; onUrl: (u: { name: string; url: string }) => void }) {
  const a = props.automation;
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

  const last = a.lastRun;
  const running = last?.state === "running";
  // Its state is its word, coloured: never a chip or a dot.
  const state: { word: string; tone: TextTone } | null = a.paused
    ? { word: "Paused", tone: "quiet" }
    : running
      ? { word: "Running", tone: "accent" }
      : a.doneAt
        ? { word: "Done", tone: "success" }
        : null;
  return (
    <SettingsRow
      title={
        <>
          {a.name}
          {state === null ? null : (
            <Text size="sm" tone={state.tone} className={s.state}>
              {state.word}
            </Text>
          )}
        </>
      }
      label={a.name}
      data={{ "data-automation": a.automationId }}
      line={
        <>
          {triggersLine(a)}
          <br />
          {[
            a.nextRunAt && !a.paused ? `Next run ${when(a.nextRunAt)}` : null,
            last ? `Last run ${when(last.at)}: ${runChip(last).label.toLowerCase()}` : "Not run yet",
          ]
            .filter(Boolean)
            .join(" · ")}
        </>
      }
    >
      <div className={settings.actions}>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const out = await hubCall("automation_run", { automationId: a.automationId });
              return out.run.workstreamId ? "Running. Follow it in the chat." : `Not run: ${out.run.why ?? "skipped"}.`;
            })
          }
        >
          Run now
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            act(async () => {
              await hubCall("automation_pause", { automationId: a.automationId, paused: !a.paused });
              return null;
            })
          }
        >
          {a.paused ? "Resume" : "Pause"}
        </Button>
        <Button disabled={busy} onClick={props.onEdit}>
          Edit
        </Button>
        {a.webhook ? (
          <Button
            disabled={busy}
            onClick={() =>
              act(async () => {
                const out = await hubCall("automation_rotate", { automationId: a.automationId });
                props.onUrl({ name: a.name, url: out.webhookUrl });
                return null;
              })
            }
          >
            Rotate webhook URL
          </Button>
        ) : null}
        <Button variant="ghost" aria-expanded={history} onClick={() => setHistory(!history)}>
          {history ? "Hide runs" : "Runs"}
        </Button>
        <DangerButton disabled={busy} onClick={() => setDeleting(true)}>
          Delete
        </DangerButton>
      </div>
      <div role="status">
        {echo ? (
          <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        ) : null}
      </div>
      {history ? <Runs automationId={a.automationId} /> : null}
      <Dialog
        open={deleting}
        onOpenChange={(open) => !open && setDeleting(false)}
        title={`Delete ${a.name}?`}
        description="Its schedule and webhook stop, and its run history goes. Orders its runs opened stay."
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

/** Its runs, newest first, each with its trigger, state and the order it opened. */
function Runs({ automationId }: { automationId: string }) {
  const runs = useToolQuery("automation_runs", { automationId, limit: 30 });
  if (runs.isError) return <Text tone="danger">{errorText(runs.error)}</Text>;
  if (runs.data === undefined) return <Text tone="quiet">Loading runs…</Text>;
  if (runs.data.runs.length === 0) return <Text tone="quiet">No runs yet.</Text>;
  return (
    <ul className={s.runs} aria-label="Runs">
      {runs.data.runs.map((r) => {
        const chip = runChip(r);
        const note = runNote(r);
        return (
          <li key={r.runId} className={s.run}>
            <Text size="xs">{when(r.at)}</Text>
            <Text size="xs" tone="quiet">
              {triggerWord(r.trigger)}
            </Text>
            <StatusChip tone={chip.tone} inRow>
              {chip.label}
            </StatusChip>
            <Text size="xs" tone="quiet">
              {r.workstreamId ? <a href={orderHref(r.workstreamId)}>Order {r.workstreamId}</a> : null}
              {r.workstreamId && note ? " · " : null}
              {note}
            </Text>
          </li>
        );
      })}
    </ul>
  );
}

/** A new automation, or one being edited: name, prompt, schedule with its preview, webhook. */
function Editor(props: { projectRef: ProjectRef; automation?: Automation; onClose: () => void; onUrl: (u: { name: string; url: string }) => void }) {
  const a = props.automation;
  const [draft, setDraft] = useState<Draft>(() => (a ? draftOf(a, localZone()) : emptyDraft(localZone())));
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const issues = problems(draft);
  const shown = tried ? issues : {};
  const preview = draft.scheduled && draft.at === undefined ? describeCron(draft.cron, draft.tz) : null;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const save = () => {
    setTried(true);
    if (hasProblems(issues)) return;
    setBusy(true);
    setError(null);
    const work = async () => {
      if (!a) {
        const out = await hubCall("automation_create", createInput(draft, props.projectRef, requestId));
        if (out.webhookUrl) props.onUrl({ name: out.automation.name, url: out.webhookUrl });
        return;
      }
      const input = updateInput(a, draft);
      if (!input) return;
      const out = await hubCall("automation_update", input);
      if (out.webhookUrl) props.onUrl({ name: out.automation.name, url: out.webhookUrl });
    };
    work().then(
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

  return (
    <SettingsRow
      title={a ? `Edit ${a.name}` : "New automation"}
      hint="Something the lead does on a schedule or from a webhook. Reviews and approvals still apply. A run missed while the hub is down runs once when it is back."
    >
      <Field label="Name" error={shown.name}>
        <Input value={draft.name} maxLength={NAME_MAX} placeholder="Weekly dependency check" onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Prompt" error={shown.prompt}>
        <Textarea
          value={draft.prompt}
          minRows={4}
          maxRows={14}
          maxLength={PROMPT_MAX}
          placeholder="Check the dependencies for updates and open one PR with the safe ones."
          onChange={(e) => set({ prompt: e.target.value })}
        />
      </Field>
      <Switch label="On a schedule" checked={draft.scheduled} onCheckedChange={(on) => set({ scheduled: on })} />
      {draft.scheduled ? (
        <>
          <div className={s.scheduleRow}>
            {draft.at === undefined ? (
              <Field label="Cron" description="Minute, hour, day of month, month, day of week." error={shown.cron}>
                <Input mono value={draft.cron} onChange={(e) => set({ cron: e.target.value })} />
              </Field>
            ) : (
              <Field label="Once at" description="It runs once, then it's done. A new time runs it again." error={shown.cron}>
                <Input type="datetime-local" value={draft.at} onChange={(e) => set({ at: e.target.value })} />
              </Field>
            )}
          </div>
          <Text size="sm" tone={preview === null || preview.ok ? "default" : "danger"} aria-label="Schedule preview">
            {preview ? (preview.ok ? preview.text : preview.error) : draft.at !== undefined ? onceLine(draft.at, draft.tz) : null}
          </Text>

        </>
      ) : null}
      <Switch
        label="Webhook"
        description={a?.webhook ? "Off removes its URL." : "A URL to POST to, shown once when you save."}
        checked={draft.webhook}
        onCheckedChange={(on) => set({ webhook: on })}
      />
      <div className={settings.actions}>
        <Button variant="primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : a ? "Save" : "Create"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={props.onClose}>
          Cancel
        </Button>
      </div>
      <div role="status">{error ? <Text tone="danger">{error}</Text> : null}</div>
    </SettingsRow>
  );
}
