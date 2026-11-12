// What automations decide without the hub: a schedule's next run and how it is kept, the order texts a run opens,
// the webhook secret's hash, and the shapes a row's `data` holds. index.ts keeps them in the database and runs them.
import type { Automation, AutomationRun, AutomationSchedule } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { clip } from "../leads/text.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { nextCron, parseAt, parseCron, ScheduleError, zonedParts } from "../wakes/schedule.ts";

export const AUTOMATIONS_PER_PROJECT = 50;
export const WEBHOOK_BODY_MAX = 16 * 1024;
export const RUNS_KEPT = 100;
/** The longest order text the ledger keeps (`IntakeText`). */
const ORDER_CHARS = 4000;
/** Webhook calls kept per automation while a run is open; one past them is skipped, as a schedule's is. */
export const QUEUED_MAX = 20;
/** The room a kept calls' order leaves for naming the bodies that didn't fit: 20 run ids and the words around them. */
const QUEUED_TAIL = 600;

// ---- helpers --------------------------------------------------------------------------------------------------------

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export function randomId(prefix: string): string {
  return `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(9)))}`;
}

/** A new webhook secret: 32 random bytes, URL-safe. */
export function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function secretHash(secret: string): Uint8Array {
  return new Bun.CryptoHasher("sha256").update(secret).digest();
}

export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** Equal without an early exit, so the time taken says nothing about where two hashes differ. */
export function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < 32; i++) acc |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return acc === 0;
}

export function unhex(text: string): Uint8Array | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(text)) return undefined;
  return Uint8Array.from(Buffer.from(text, "hex"));
}

/** The URL a webhook posts to. */
export const webhookUrl = (hubUrl: string, id: string, secret: string) => `${hubUrl.replace(/\/+$/, "")}/hooks/${id}/${secret}`;

export const invalid = (message: string, fix: string) => new ToolError("invalid", message, fix);

/** The zone's name, checked; refused when it isn't an IANA zone. */
function zone(schedule: AutomationSchedule): string {
  try {
    zonedParts(0, schedule.tz);
    return schedule.tz;
  } catch {
    throw invalid(`'${schedule.tz}' is not an IANA time zone.`, "Use a zone name such as Europe/Berlin or America/New_York.");
  }
}

/** The instant a one-time schedule's `at` names. */
export function atMs(at: string, schedule: AutomationSchedule): number {
  try {
    return parseAt(at, schedule.tz);
  } catch (e) {
    const why = e instanceof ScheduleError ? e.message : String(e);
    throw invalid(`${why}.`, "Give a date and time such as 2026-11-03T18:00, read in tz.");
  }
}

/** `2026-10-27 09:00 Europe/Berlin`: the instant on the schedule's wall clock. */
function local(ms: number, schedule: AutomationSchedule): string {
  let t: ReturnType<typeof zonedParts>;
  try {
    t = zonedParts(ms, schedule.tz);
  } catch {
    return isoMs(ms);
  }
  return `${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)} ${schedule.tz}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The schedule's first run strictly after `afterMs`; refused when it doesn't parse or never runs, and a one-time
 * schedule whose time has passed.
 */
export function nextAfter(schedule: AutomationSchedule, afterMs: number): number {
  const tz = zone(schedule);
  const { cron, at } = schedule;
  if (cron === undefined && at !== undefined) {
    const ms = atMs(at, schedule);
    if (ms <= afterMs) {
      throw invalid(`${at} in ${schedule.tz} has passed: it is ${local(afterMs, schedule)} there now.`, "Give a time still to come.");
    }
    return ms;
  }
  if (cron === undefined || at !== undefined) {
    throw invalid(
      "A schedule has a cron or an at, one of the two.",
      "Give cron (such as 0 9 * * 1-5) to run again and again, or at (such as 2026-11-03T18:00) to run once.",
    );
  }
  let parsed: ReturnType<typeof parseCron>;
  try {
    parsed = parseCron(cron);
  } catch (e) {
    throw invalid(
      `The cron '${cron}' doesn't parse: ${(e as Error).message}.`,
      "Give five fields, minute hour day-of-month month day-of-week, such as 0 9 * * 1-5.",
    );
  }
  const next = nextCron(parsed, afterMs, tz);
  if (next === undefined) throw invalid(`The cron '${cron}' never runs.`, "Pick days that exist, such as 0 9 1 * * for the 1st of each month.");
  return next;
}

/** The schedule as kept: a one-time `at` on `tz`'s wall clock, 2026-11-03T18:00, whatever offset it was given with. */
export function kept(schedule: AutomationSchedule): AutomationSchedule {
  const tz = zone(schedule);
  const out: AutomationSchedule = { ...(schedule.cron === undefined ? {} : { cron: schedule.cron }), ...(schedule.at === undefined ? {} : { at: schedule.at }), tz: schedule.tz };
  if (schedule.at !== undefined) {
    const t = zonedParts(atMs(schedule.at, schedule), tz);
    const seconds = t.second === 0 ? "" : `:${pad(t.second)}`;
    out.at = `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}${seconds}`;
  }
  return out;
}

/** A lead's schedule (`AutomationScheduleCall`), in `tz` (the person's zone) where it names none. */
export function fromCall(call: { cron?: string; at?: string; tz?: string }, tz: () => string): AutomationSchedule {
  return { ...(call.cron === undefined ? {} : { cron: call.cron }), ...(call.at === undefined ? {} : { at: call.at }), tz: call.tz ?? tz() };
}

export function why(text: string): string {
  return clip(text.replace(/[\r\n]/g, " "), 200);
}

/** The markdown fence that no run of backticks inside `body` closes. */
function fence(body: string): string {
  let longest = 0;
  let run = 0;
  for (const c of body) {
    run = c === "`" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return "`".repeat(Math.max(longest + 1, 3));
}

/** Counted as the Rust hub counts text: Unicode scalars. */
const chars = (s: string) => [...s].length;
const takeChars = (s: string, n: number) => [...s].slice(0, n).join("");

/**
 * The order a run opens: the automation's name as its title, where it came from, the prompt, and a webhook's body as
 * far as it fits (the rest is one `automation_runs` call away).
 */
export function orderText(a: Automation, run: AutomationRun, payload: string | undefined): string {
  let how: string;
  if (run.trigger === "schedule") {
    const s = a.schedule;
    const due = run.scheduledAt === undefined ? undefined : parseMs(run.scheduledAt);
    const once = s?.at !== undefined;
    let when: string;
    if (s && due !== undefined && once) when = `its one-time schedule, due ${local(due, s)}; it runs only this once`;
    else if (s && due !== undefined) when = `its schedule (${s.cron ?? ""}), due ${local(due, s)}`;
    else when = "its schedule";
    if (run.lateMin !== undefined && once) {
      how = `${when}. It comes ${run.lateMin} min late, since the hub was down or its last run was still open then: say that it comes late`;
    } else if (run.lateMin !== undefined) how = `${when}; the hub was down then, so this is that run ${run.lateMin} min late, once`;
    else how = when;
  } else how = run.trigger === "webhook" ? "its webhook" : "Run now";
  let text =
    `${a.name}\nFrom automation ${a.automationId} (run ${run.runId}, started by ${how}). Start the work without asking the human first; ` +
    `reviews, the merge train and approvals apply as always.\n\n${a.prompt}`;
  if (payload !== undefined) text = pushBody(text, "The webhook's body", run.runId, payload);
  return takeChars(text, ORDER_CHARS);
}

/** Appends a webhook body to an order's text as far as it fits; the rest is one `automation_runs` call away. */
function pushBody(text: string, label: string, runId: string, body: string): string {
  const bytes = Buffer.byteLength(body);
  const f = fence(body);
  const head = `\n\n${label} (${bytes} bytes):\n${f}\n`;
  const cutNote = `\n${f}\nCut here; automation_runs with runId ${runId} has the whole body.`;
  const room = Math.max(0, ORDER_CHARS - (chars(text) + chars(head) + chars(cutNote)));
  if (chars(body) <= room) return `${text}${head}${body}\n${f}`;
  return `${text}${head}${takeChars(body, room)}${cutNote}`;
}

/**
 * The one order for the webhook calls kept while an earlier run was open (`deliverQueued`): every body, oldest first,
 * inline while the order has room; the ones past that are named by run, for `automation_runs`.
 */
export function queuedOrderText(a: Automation, runs: [AutomationRun, string | null][]): string {
  const ids = runs.map(([r]) => r.runId);
  const n = runs.length;
  let text =
    `${a.name}\nFrom automation ${a.automationId}: ${n} call${n === 1 ? "" : "s"} to its webhook that came while its last run was open ` +
    `(run${n === 1 ? "" : "s"} ${ids.join(", ")}). Start the work without asking the human first; reviews, the merge train and ` +
    `approvals apply as always. Deal with every body.\n\n${a.prompt}`;
  for (const [i, [run, payload]] of runs.entries()) {
    // Room for the names of the bodies left stays; a body that would leave less goes by name too.
    if (Math.max(0, ORDER_CHARS - chars(text)) < QUEUED_TAIL) {
      text += `\n\nNo room for bodies ${i + 1} to ${n} here: automation_runs with runId ${ids.slice(i).join(", ")} has each.`;
      break;
    }
    text = pushBody(text, `Webhook body ${i + 1} of ${n} (run ${run.runId}, at ${run.at})`, run.runId, payload ?? "");
  }
  return takeChars(text, ORDER_CHARS);
}

/** The automation as its row's `data` holds it, keys in the Rust struct's order. */
export function stored(a: Automation): Automation {
  return {
    automationId: a.automationId,
    projectRef: { machineId: a.projectRef.machineId, projectId: a.projectRef.projectId },
    name: a.name,
    prompt: a.prompt,
    ...(a.schedule === undefined ? {} : { schedule: a.schedule }),
    webhook: a.webhook,
    paused: a.paused,
    ...(a.nextRunAt === undefined ? {} : { nextRunAt: a.nextRunAt }),
    ...(a.doneAt === undefined ? {} : { doneAt: a.doneAt }),
    ...(a.lastRun === undefined ? {} : { lastRun: a.lastRun }),
    createdBy: a.createdBy,
    confirmed: a.confirmed === true,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** The run as its row's `data` holds it, keys in the Rust struct's order. */
export function storedRun(r: AutomationRun): AutomationRun {
  const o: Record<string, unknown> = { runId: r.runId, automationId: r.automationId, trigger: r.trigger, at: r.at, state: r.state };
  for (const k of ["workstreamId", "scheduledAt", "lateMin", "payloadBytes", "why", "by", "endedAt"] as const) {
    if (r[k] !== undefined) o[k] = r[k];
  }
  return o as AutomationRun;
}
