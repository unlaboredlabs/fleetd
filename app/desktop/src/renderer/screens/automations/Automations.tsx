// Settings → Automations: one project's automations, each a prompt the project's lead runs on a schedule, from a
// webhook or on Run now. Each run opens an order the lead starts on its own; reviews, the merge train and approvals
// still apply. A person makes, edits, pauses, runs and deletes them here and reads their runs, each linked to its
// order. A webhook URL holds its secret, so the hub returns it only when it is made or rotated: shown once, here.
import { useEffect, useState } from "react";
import type { Automation, ProjectRef } from "../../../shared/contracts";
import { Button, Dialog, Field, Input, StatusChip, Switch, Text, Textarea, copyText } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { parseScope, projectRefOf, scopeKey, type Scope } from "../settings/editor";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { PageHead, ScopeSelect, scopeName, useProjects } from "../settings/parts";
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
  const [picked, setPicked] = useState<Scope | null>(() => (route.for ? parseScope(route.for) : null));
  const first = projects?.[0];
  const project: Scope | null =
    picked?.kind === "project" ? picked : first ? { kind: "project", ref: { machineId: first.machineId, projectId: first.projectId } } : null;
  const ref = project ? projectRefOf(project) : undefined;
  const list = useToolQuery("automation_list", { projectRef: ref ?? { machineId: "", projectId: "" } }, { enabled: live && ref !== undefined });
  const [editing, setEditing] = useState<string | null>(null);
  const [url, setUrl] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    replaceRoute({ tab: "automations", for: picked?.kind === "project" ? scopeKey(picked) : null });
  }, [picked]);

  if (!live) {
    return (
      <div className={settings.scroll} data-screen="settings.automations">
        <div className={settings.column}>
          <PageHead title="Automations" />
          <Text tone="quiet">Not connected. Connect to a hub to see its automations.</Text>
        </div>
      </div>
    );
  }

  const automations = list.data?.automations ?? [];
  const name = project ? scopeName(project, projects) : null;
  return (
    <div className={settings.scroll} data-screen="settings.automations">
      <div className={settings.column}>
        <PageHead
          title="Automations"
          aside={<ScopeSelect id="automations-for" className={settings.scopeSelect} value={project} projects={projects} onChange={(p) => (setPicked(p), setEditing(null))} />}
        >
          A prompt the lead runs on a schedule, from a webhook, or when you press Run now. Each run opens an order the lead starts on its own; reviews and
          approvals still apply.
        </PageHead>
        {url ? <WebhookUrl {...url} onDone={() => setUrl(null)} /> : null}
        {list.isLoadingError ? (
          <div className={settings.inline}>
            <Text tone="danger">{errorText(list.error)}</Text>
            <Button onClick={() => void list.refetch()}>Try again</Button>
          </div>
        ) : null}
        {ref && editing === "new" ? (
          <Editor projectRef={ref} onClose={() => setEditing(null)} onUrl={(u) => setUrl(u)} />
        ) : (
          <div className={settings.actions}>
            <Button variant="primary" disabled={!ref} onClick={() => setEditing("new")}>
              New automation
            </Button>
          </div>
        )}
        {list.data && automations.length === 0 && editing !== "new" ? (
          <Text tone="quiet">{name ? `${name} has no automations yet.` : "Pick a project."}</Text>
        ) : null}
        {list.data === undefined && !list.isLoadingError && ref ? <Text tone="quiet">Loading automations…</Text> : null}
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
      </div>
    </div>
  );
}

/** A webhook URL the hub just made: shown once, with Copy. */
function WebhookUrl(props: { name: string; url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className={s.url} aria-label="Webhook URL">
      <Text strong>Webhook URL for {props.name}</Text>
      <Text size="xs" tone="quiet">
        POST to it to start a run with the request body as context. It holds a secret and is shown only now: copy it. Rotate makes a new one and the old one
        stops working.
      </Text>
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
    </section>
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
  return (
    <section className={s.card} aria-label={a.name} data-automation={a.automationId}>
      <div className={s.cardHead}>
        <Text strong>{a.name}</Text>
        {a.paused ? <StatusChip tone="idle">Paused</StatusChip> : running ? <StatusChip tone="working">Running</StatusChip> : null}
      </div>
      <Text size="sm">{triggersLine(a)}</Text>
      <Text size="xs" tone="quiet">
        {[
          a.nextRunAt && !a.paused ? `Next run ${when(a.nextRunAt)}` : null,
          last ? `Last run ${when(last.at)}: ${runChip(last).label.toLowerCase()}` : "Not run yet",
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <div className={settings.actions}>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const out = await hubCall("automation_run", { automationId: a.automationId });
              return out.run.workstreamId ? `Running: it opened ${out.run.workstreamId} for the lead.` : `Not run: ${out.run.why ?? "skipped"}.`;
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
        <Button variant="danger" disabled={busy} onClick={() => setDeleting(true)}>
          Delete
        </Button>
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
    </section>
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
  const preview = draft.scheduled ? describeCron(draft.cron, draft.tz) : null;
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
    <section className={s.editor} aria-label={a ? `Edit ${a.name}` : "New automation"}>
      <Text strong>{a ? `Edit ${a.name}` : "New automation"}</Text>
      <Field label="Name" error={shown.name}>
        <Input value={draft.name} maxLength={NAME_MAX} placeholder="Weekly dependency check" onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Prompt" description="What the lead does on each run, as you'd ask it in the chat." error={shown.prompt}>
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
            <Field label="Cron" description="Minute, hour, day of month, month, day of week." error={shown.cron}>
              <Input mono value={draft.cron} onChange={(e) => set({ cron: e.target.value })} />
            </Field>
            <Field label="Time zone" description="An IANA zone, such as Europe/Berlin.">
              <Input value={draft.tz} onChange={(e) => set({ tz: e.target.value })} />
            </Field>
          </div>
          <Text size="sm" tone={preview?.ok ? "default" : "danger"} aria-label="Schedule preview">
            {preview ? (preview.ok ? preview.text : preview.error) : null}
          </Text>
          <Text size="xs" tone="quiet">
            A run missed while the hub is down runs once when it is back.
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
    </section>
  );
}
