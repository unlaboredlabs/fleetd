// Settings → Projects → Automations' rules, kept pure: an automation's triggers in a line, a run's state as a chip, the editor's
// draft and the hub input it saves as (an edit sends only what changed), where a run's order opens, and the nightly
// memory refresh's built-in row in words.
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationRunState,
  AutomationTrigger,
  AutomationUpdateInput,
  MemoryRefreshJob,
  MemoryRefreshRun,
  ProjectRef,
} from "../../../shared/contracts";
import type { StatusTone } from "../../ui";
import { toHash } from "../shell/routes";
import { describeCron } from "./cron";

export const NAME_MAX = 80;
export const PROMPT_MAX = 2000;

export interface Draft {
  readonly name: string;
  readonly prompt: string;
  readonly scheduled: boolean;
  readonly cron: string;
  readonly tz: string;
  readonly webhook: boolean;
}

/** The zone the app runs in, the editor's default for a new schedule. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const emptyDraft = (tz: string): Draft => ({ name: "", prompt: "", scheduled: true, cron: "0 9 * * 1-5", tz, webhook: false });

export const draftOf = (a: Automation, tz: string): Draft => ({
  name: a.name,
  prompt: a.prompt,
  scheduled: a.schedule !== undefined,
  cron: a.schedule?.cron ?? "0 9 * * 1-5",
  tz: a.schedule?.tz ?? tz,
  webhook: a.webhook,
});

export interface Problems {
  readonly name?: string;
  readonly prompt?: string;
  readonly cron?: string;
}

const chars = (s: string) => Array.from(s).length;

/** What the hub would refuse, said before the save. */
export function problems(d: Draft): Problems {
  const name = d.name.trim();
  const out: { name?: string; prompt?: string; cron?: string } = {};
  if (name === "") out.name = "Give it a name.";
  else if (chars(name) > NAME_MAX) out.name = `At most ${NAME_MAX} characters.`;
  else if (/[\r\n]/u.test(name)) out.name = "One line.";
  if (d.prompt.trim() === "") out.prompt = "Say what the lead should do on each run.";
  else if (chars(d.prompt) > PROMPT_MAX) out.prompt = `At most ${PROMPT_MAX.toLocaleString("en-US")} characters.`;
  if (d.scheduled) {
    const reading = describeCron(d.cron, d.tz);
    if (!reading.ok) out.cron = reading.error;
    else if (d.tz.trim() === "") out.cron = "Give a time zone, such as Europe/Berlin.";
  }
  return out;
}

export const hasProblems = (p: Problems): boolean => Object.keys(p).length > 0;

const schedule = (d: Draft) => ({ cron: d.cron.trim(), tz: d.tz.trim() });

export const createInput = (d: Draft, projectRef: ProjectRef, clientRequestId: string): AutomationCreateInput => ({
  projectRef,
  name: d.name.trim(),
  prompt: d.prompt,
  ...(d.scheduled ? { schedule: schedule(d) } : {}),
  webhook: d.webhook,
  clientRequestId,
});

/** Only what the draft changed; null when it changed nothing. */
export function updateInput(a: Automation, d: Draft): AutomationUpdateInput | null {
  const out: { -readonly [K in keyof AutomationUpdateInput]: AutomationUpdateInput[K] } = { automationId: a.automationId };
  if (d.name.trim() !== a.name) out.name = d.name.trim();
  if (d.prompt !== a.prompt) out.prompt = d.prompt;
  const next = schedule(d);
  if (d.scheduled && (a.schedule?.cron !== next.cron || a.schedule.tz !== next.tz)) out.schedule = next;
  if (!d.scheduled && a.schedule !== undefined) out.removeSchedule = true;
  if (d.webhook !== a.webhook) out.webhook = d.webhook;
  return Object.keys(out).length > 1 ? out : null;
}

/** Its triggers in a line: the schedule in words, the webhook, else Run now only. */
export function triggersLine(a: Automation): string {
  const parts: string[] = [];
  if (a.schedule) {
    const r = describeCron(a.schedule.cron, a.schedule.tz);
    parts.push(r.ok ? r.text : `${a.schedule.cron} (${a.schedule.tz})`);
  }
  if (a.webhook) parts.push("Webhook");
  return parts.length > 0 ? parts.join(" · ") : "Run now only";
}

export const TRIGGER_WORD: Readonly<Record<AutomationTrigger, string>> = {
  schedule: "Schedule",
  webhook: "Webhook",
  manual: "Run now",
};

const STATE: Readonly<Record<AutomationRunState, { tone: StatusTone; label: string }>> = {
  running: { tone: "working", label: "Running" },
  done: { tone: "done", label: "Done" },
  stopped: { tone: "idle", label: "Stopped" },
  skipped: { tone: "quiet", label: "Skipped" },
  failed: { tone: "failed", label: "Failed" },
};

/** A run's state as a chip; a state from a newer hub shows as its own word. */
export const runChip = (run: Pick<AutomationRun, "state">): { tone: StatusTone; label: string } =>
  (STATE as Record<string, { tone: StatusTone; label: string }>)[run.state] ?? { tone: "quiet", label: run.state };

export const triggerWord = (t: AutomationTrigger): string => (TRIGGER_WORD as Record<string, string>)[t] ?? t;

/** The order's own page: its timeline. */
export const orderHref = (workstreamId: string): string => toHash({ id: "time", orderId: workstreamId });

/** "Mon 19 Oct, 09:00", in the app's zone. */
export const when = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The line under a run: why it was skipped or failed, how late a missed run was, a webhook body's size. */
export function runNote(run: AutomationRun): string | null {
  if (run.why) return run.why;
  if (run.lateMin !== undefined) return `Missed while the hub was down; ran once on its return.`;
  if (run.payloadBytes !== undefined) return `Body of ${run.payloadBytes.toLocaleString("en-US")} bytes.`;
  return null;
}

/** The nightly memory refresh's hour: "Every night at 04:00 (Europe/Berlin)". */
export const refreshSchedule = (job: MemoryRefreshJob): string => `Every night at ${job.at} (${job.tz})`;

/** What a refresh changed, in the words of its chat line: "2 added, 1 updated, 1 removed", or "no changes". */
export function refreshChanges(run: Pick<MemoryRefreshRun, "added" | "replaced" | "removed">): string {
  const parts = (
    [
      [run.added, "added"],
      [run.replaced, "updated"],
      [run.removed, "removed"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${String(n)} ${word}`);
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

/** The refresh's next and last run in a line: when, how it went, and what it changed or why it was skipped. */
export function refreshRuns(job: MemoryRefreshJob): string {
  const last = job.lastRun;
  const how = (run: MemoryRefreshRun): string => {
    const state = runChip(run).label.toLowerCase();
    if (run.state === "skipped" || (run.state === "failed" && run.why)) return `${state}: ${run.why ?? "no reason given"}`;
    return `${state}, ${refreshChanges(run)}`;
  };
  return [
    job.on && job.nextRunAt ? `Next run ${when(job.nextRunAt)}` : null,
    last ? `${last.state === "running" ? "Started" : "Last run"} ${when(last.at)}${last.trigger === "manual" ? " (Run now)" : ""}: ${how(last)}` : "Not run yet",
  ]
    .filter(Boolean)
    .join(" · ");
}
