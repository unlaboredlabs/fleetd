// Automations (crates/fleetd/src/hub/automations/mod.rs): a project's stored prompt with its triggers, a schedule in an
// IANA time zone (a cron, or one exact time for a reminder or follow-up, D288), an incoming webhook and Run now. Each
// run opens an order for the project's lead (channel `automation`), which starts the work without a person's message.
// One run at a time per automation: a schedule or Run now while its order is open is skipped and recorded; a webhook
// call is kept with its body (D279), and every call kept meanwhile goes in one follow-up order once the open run ends.
// A Navi's run closes its order by itself once the Navi's turn for it ends (D277). The scheduler sleeps until the
// earliest schedule is due; one missed while the hub was down runs once, late, on its return. A one-time schedule runs
// once and its automation is done (`doneAt`); one that comes due while another run is open waits (`fireWaiting`).
//
// A webhook URL is `<hub url>/hooks/<automationId>/<secret>`. The hub keeps the secret's SHA-256 only, compares in
// constant time, and never logs the secret or the body; the body is kept with its run and given to the lead.
//
// Runs are checked and recorded synchronously (`open`), so two triggers at once start one run without the Rust lock.
// Orders open and close through the leads area's intake (`intake(hub)`), and a lead starts with `leads(hub).autoStart`.
import type {
  Automation,
  AutomationRun,
  AutomationRunState,
  AutomationSchedule,
  AutomationTrigger,
  HubEvent,
  HubEventType,
  ProjectRef,
  ThreadRef,
  Workstream,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { uuidFrom } from "../executor/index.ts";
import { leads } from "../leads/index.ts";
import { unknownProject } from "../leads/seams.ts";
import { intake, type IntakeInput } from "../leads/workstreams.ts";
import { clip } from "../leads/text.ts";
import { of as naviOf } from "../navi/store.ts";
import { workstreamGet } from "../orders/workstreams.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { LATE_AFTER_MS } from "../wakes/index.ts";
import { nextCron, parseAt, parseCron, ScheduleError, zonedParts } from "../wakes/schedule.ts";

export const AUTOMATIONS_PER_PROJECT = 50;
export const WEBHOOK_BODY_MAX = 16 * 1024;
export const RUNS_KEPT = 100;
/** The longest order text the ledger keeps (`IntakeText`). */
const ORDER_CHARS = 4000;
/** Webhook calls kept per automation while a run is open; one past them is skipped, as a schedule's is. */
export const QUEUED_MAX = 20;
/** Runs per lead thread `naviTurns` remembers seeing: more than one turn's wakes, steers and chat messages. */
const RUNS_SEEN = 32;
/** The room a kept calls' order leaves for naming the bodies that didn't fit: 20 run ids and the words around them. */
const QUEUED_TAIL = 600;

/** A new automation: the app's automation_create or the lead's. */
export type NewAutomation = {
  projectRef: ProjectRef;
  name: string;
  prompt: string;
  schedule?: AutomationSchedule;
  webhook: boolean;
  /** A keyId, "human" or "lead:<machineId>/<projectId>". */
  by: string;
  /** The person wrote it or said yes to it (`Automation.confirmed`). */
  confirmed: boolean;
  /** Makes a retry return the automation the first call made. */
  clientRequestId?: string;
};

/** An edit: only the fields given change. */
export type Edit = {
  name?: string;
  prompt?: string;
  /** null takes the schedule off. */
  schedule?: AutomationSchedule | null;
  /** true adds a webhook URL (an existing one stays), false removes it. */
  webhook?: boolean;
  /** Whether the person stands behind it after this edit; undefined leaves it as it was. */
  confirmed?: boolean;
};

/** What starts a run. */
export type Start =
  /** Run now, by a keyId, "human" or "lead:<machineId>/<projectId>". */
  | { kind: "manual"; by: string }
  /** The webhook, with its body. */
  | { kind: "webhook"; payload: string }
  /** The schedule, due at `dueMs`. */
  | { kind: "schedule"; dueMs: number };

// ---- helpers --------------------------------------------------------------------------------------------------------

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function randomId(prefix: string): string {
  return `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(9)))}`;
}

/** A new webhook secret: 32 random bytes, URL-safe. */
function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

function secretHash(secret: string): Uint8Array {
  return new Bun.CryptoHasher("sha256").update(secret).digest();
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** Equal without an early exit, so the time taken says nothing about where two hashes differ. */
function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < 32; i++) acc |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return acc === 0;
}

function unhex(text: string): Uint8Array | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(text)) return undefined;
  return Uint8Array.from(Buffer.from(text, "hex"));
}

/** The URL a webhook posts to. */
export const webhookUrl = (hubUrl: string, id: string, secret: string) => `${hubUrl.replace(/\/+$/, "")}/hooks/${id}/${secret}`;

const invalid = (message: string, fix: string) => new ToolError("invalid", message, fix);

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
function atMs(at: string, schedule: AutomationSchedule): number {
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
function kept(schedule: AutomationSchedule): AutomationSchedule {
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

function why(text: string): string {
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
function stored(a: Automation): Automation {
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
function storedRun(r: AutomationRun): AutomationRun {
  const o: Record<string, unknown> = { runId: r.runId, automationId: r.automationId, trigger: r.trigger, at: r.at, state: r.state };
  for (const k of ["workstreamId", "scheduledAt", "lateMin", "payloadBytes", "why", "by", "endedAt"] as const) {
    if (r[k] !== undefined) o[k] = r[k];
  }
  return o as AutomationRun;
}

const decode = (data: string) => JSON.parse(data) as Automation;
const decodeRun = (data: string) => JSON.parse(data) as AutomationRun;

const notFound = (id: string) => new ToolError("not_found", `There is no automation ${id}.`, "automation_list shows the project's automations.");

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** The thread statuses a turn is going or queued in. */
const BUSY_THREAD = new Set(["running", "waiting"]);

/** Live, not a reviewer's: the tasks still at work on a Navi run's order (tasks/wire.rs `leftovers`). */
function leftovers(hub: Hub, r: ProjectRef, w: string): string[] {
  return hub.db
    .all<{ id: string }>(
      `SELECT 'T' || n AS id FROM tasks WHERE machine_id = ? AND project_id = ? AND workstream_id = ?
         AND state IN ('queued', 'running', 'idle') AND ('T' || n) NOT IN (SELECT task_id FROM review_tasks)`,
      [r.machineId, r.projectId, w],
    )
    .map((row) => row.id);
}

/** A wake's request id, which names its run on the node (leads/wakes.rs `wake_request_id`). */
export const wakeRequestId = (r: ProjectRef, generation: number, at: string) => `fleetd-wake:${r.machineId}/${r.projectId}:${generation}:${at}`;

/** The run a send with `clientRequestId` starts on `thread` (executor `Executors::send_run_id`). */
export const sendRunId = (thread: ThreadRef, clientRequestId: string) => uuidFrom(`send\n${thread.machineId}\n${thread.threadId}\n${clientRequestId}`);

export class Automations {
  private wakeUp: (() => void) | undefined;
  private started = false;
  /** Event follow-ups, one at a time in order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly hub: Hub) {}

  private now(): number {
    return this.hub.clock.now();
  }

  /** Wakes the scheduler: an automation changed, or a test moved its clock. */
  signal(): void {
    this.wakeUp?.();
  }

  private event(a: Automation, type: HubEventType, summary: string, data: Record<string, unknown>): void {
    try {
      events(this.hub).append({
        at: isoMs(this.now()),
        type,
        machineId: a.projectRef.machineId,
        projectId: a.projectRef.projectId,
        summary,
        data: { ...data, projectRef: a.projectRef, automationId: a.automationId },
      });
    } catch (error) {
      console.error("automation event not appended:", error);
    }
  }

  private changedEvent(a: Automation, change: string, by: string): void {
    this.event(a, "automation.changed", `Automation “${a.name}” ${change}`, { change, by });
  }

  // ---- storage -------------------------------------------------------------------------------------------------------

  private row(id: string): Automation | undefined {
    const data = this.hub.db.all<{ data: string }>("SELECT data FROM automations WHERE automation_id = ?", [id])[0]?.data;
    return data === undefined ? undefined : decode(data);
  }

  private put(a: Automation): void {
    const next = a.nextRunAt === undefined ? null : (parseMs(a.nextRunAt) ?? null);
    const { lastRun: _, ...rest } = a;
    this.hub.db.conn
      .query("UPDATE automations SET paused = ?, next_run_ms = ?, data = ? WHERE automation_id = ?")
      .run(a.paused ? 1 : 0, next, JSON.stringify(stored(rest)), a.automationId);
  }

  private putRun(run: AutomationRun): void {
    this.hub.db.conn
      .query("UPDATE automation_runs SET state = ?, workstream_id = ?, data = ? WHERE run_id = ?")
      .run(run.state, run.workstreamId ?? null, JSON.stringify(storedRun(run)), run.runId);
  }

  private runsOf(id: string, limit: number): AutomationRun[] {
    return this.hub.db
      .all<{ data: string }>("SELECT data FROM automation_runs WHERE automation_id = ? ORDER BY at_ms DESC, rowid DESC LIMIT ?", [id, limit])
      .map((r) => decodeRun(r.data));
  }

  private workstream(w: string): Workstream | undefined {
    return workstreamGet(this.hub.db.conn, w);
  }

  /** A running run whose order has closed since is over: done or stopped as its order was. */
  private settle(run: AutomationRun): AutomationRun {
    if (run.state !== "running" || run.workstreamId === undefined) return run;
    const ws = this.workstream(run.workstreamId);
    if (ws?.state === "open") return run;
    const out: AutomationRun = ws
      ? { ...run, state: ws.state === "done" ? "done" : "stopped", endedAt: ws.updatedAt }
      : { ...run, state: "stopped", endedAt: isoMs(this.now()) };
    this.putRun(out);
    return out;
  }

  /** The run whose order is still open, if any: any of its runs, since a skipped trigger is newer than the one it skipped for. */
  private active(id: string): AutomationRun | undefined {
    const rows = this.hub.db.all<{ data: string }>(
      "SELECT data FROM automation_runs WHERE automation_id = ? AND state = 'running' ORDER BY at_ms DESC",
      [id],
    );
    for (const { data } of rows) {
      const run = this.settle(this.recover(decodeRun(data)));
      if (run.state === "running") return run;
    }
    return undefined;
  }

  private withLastRun(a: Automation): Automation {
    const last = this.runsOf(a.automationId, 1)[0];
    const { lastRun: _, ...rest } = a;
    return stored(last ? { ...rest, lastRun: this.settle(last) } : rest);
  }

  get(id: string): Automation | undefined {
    const a = this.row(id);
    return a ? this.withLastRun(a) : undefined;
  }

  /** The automation, refused unless it is `project`'s. */
  own(project: ProjectRef, id: string): Automation {
    const a = this.get(id);
    if (!a) throw notFound(id);
    if (!sameRef(a.projectRef, project)) {
      throw new ToolError("forbidden", `${id} belongs to another project.`, "Use an automation of this project; automation_list shows them.");
    }
    return a;
  }

  /** The project's automations, oldest first, each with its last run. */
  list(r: ProjectRef): Automation[] {
    return this.hub.db
      .all<{ data: string }>("SELECT data FROM automations WHERE machine_id = ? AND project_id = ? ORDER BY rowid", [r.machineId, r.projectId])
      .map((row) => this.withLastRun(decode(row.data)));
  }

  /** The project's automations with a run whose order is open now. */
  running(r: ProjectRef): Automation[] {
    return this.list(r).filter((a) => this.active(a.automationId) !== undefined);
  }

  /** Newest first, at most `limit`. */
  runs(id: string, limit: number): AutomationRun[] {
    return this.runsOf(id, limit).map((r) => this.settle(r));
  }

  /** One run of `id` with its webhook body, if it had one. */
  runWithPayload(id: string, runId: string): [AutomationRun, string | null] | undefined {
    const row = this.hub.db.all<{ data: string; payload: string | null }>(
      "SELECT data, payload FROM automation_runs WHERE automation_id = ? AND run_id = ?",
      [id, runId],
    )[0];
    return row ? [this.settle(decodeRun(row.data)), row.payload] : undefined;
  }

  /** Makes the automation; with `webhook`, also its secret, which is returned here once and never kept. */
  create(input: NewAutomation): [Automation, string | undefined] {
    const db = this.hub.db;
    if (input.clientRequestId !== undefined) {
      const existing = db.all<{ data: string }>("SELECT data FROM automations WHERE created_by = ? AND client_request_id = ?", [
        input.by,
        input.clientRequestId,
      ])[0];
      if (existing) return [this.withLastRun(decode(existing.data)), undefined];
    }
    const r = input.projectRef;
    if (!store(this.hub).projectGet(r)) throw unknownProject(r);
    const count = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM automations WHERE machine_id = ? AND project_id = ?", [r.machineId, r.projectId])[0]?.n ?? 0;
    const schedule = input.schedule === undefined ? undefined : kept(input.schedule);
    const now = this.now();
    const next = schedule === undefined ? undefined : nextAfter(schedule, now);
    if (count >= AUTOMATIONS_PER_PROJECT) {
      // The oldest one-time automation that has run makes room.
      const done = db.all<{ id: string }>(
        `SELECT automation_id AS id FROM automations WHERE machine_id = ? AND project_id = ?
           AND json_extract(data, '$.doneAt') IS NOT NULL ORDER BY rowid LIMIT 1`,
        [r.machineId, r.projectId],
      )[0]?.id;
      if (done === undefined) {
        throw invalid(`The project has ${AUTOMATIONS_PER_PROJECT} automations, the most it keeps.`, "Delete one it no longer needs, or fold two into one prompt.");
      }
      this.delete(done, "hub");
    }
    const at = isoMs(now);
    const a = stored({
      automationId: randomId("au_"),
      projectRef: { machineId: r.machineId, projectId: r.projectId },
      name: input.name,
      prompt: input.prompt,
      ...(schedule === undefined ? {} : { schedule }),
      webhook: input.webhook,
      paused: false,
      ...(next === undefined ? {} : { nextRunAt: isoMs(next) }),
      createdBy: input.by,
      confirmed: input.confirmed,
      createdAt: at,
      updatedAt: at,
    });
    const secret = input.webhook ? newSecret() : undefined;
    db.conn
      .query(
        `INSERT INTO automations (automation_id, machine_id, project_id, created_by, client_request_id, paused,
           next_run_ms, webhook_hash, data)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        a.automationId,
        r.machineId,
        r.projectId,
        input.by,
        input.clientRequestId ?? null,
        next ?? null,
        secret === undefined ? null : hex(secretHash(secret)),
        JSON.stringify(a),
      );
    this.changedEvent(a, "created", input.by);
    this.signal();
    return [a, secret];
  }

  /** Applies `edit`; a new webhook's secret is returned once. */
  update(id: string, edit: Edit, by: string): [Automation, string | undefined] {
    let a = this.row(id);
    if (!a) throw notFound(id);
    a = { ...a };
    if (edit.name !== undefined) a.name = edit.name;
    if (edit.prompt !== undefined) a.prompt = edit.prompt;
    if (edit.schedule !== undefined) {
      // A new schedule starts over, a one-time one that has run included.
      if (edit.schedule === null) delete a.schedule;
      else a.schedule = kept(edit.schedule);
      delete a.doneAt;
    }
    if (edit.confirmed !== undefined) a.confirmed = edit.confirmed;
    const now = this.now();
    const next = a.schedule !== undefined && !a.paused && a.doneAt === undefined ? nextAfter(a.schedule, now) : undefined;
    if (next === undefined) delete a.nextRunAt;
    else a.nextRunAt = isoMs(next);
    const secret = edit.webhook === true && !a.webhook ? newSecret() : undefined;
    if (edit.webhook !== undefined) a.webhook = edit.webhook;
    a.updatedAt = isoMs(now);
    this.put(a);
    if (edit.webhook === false || secret !== undefined) this.setHash(id, secret);
    this.changedEvent(a, "edited", by);
    this.signal();
    return [this.withLastRun(a), secret];
  }

  private setHash(id: string, secret: string | undefined): void {
    this.hub.db.conn
      .query("UPDATE automations SET webhook_hash = ? WHERE automation_id = ?")
      .run(secret === undefined ? null : hex(secretHash(secret)), id);
  }

  /**
   * The person let it run on its own (`automation_confirm`'s card): marked `confirmed`, unless what it runs or when
   * changed since the card showed it (`shown`: its `prompt` and `schedule` as the card's JSON has them). Whether it is
   * marked now.
   */
  confirm(id: string, shown: unknown, by: string): boolean {
    const a = this.row(id);
    if (!a) throw notFound(id);
    const o = shown !== null && typeof shown === "object" && !Array.isArray(shown) ? (shown as Record<string, unknown>) : {};
    const same = o.prompt === a.prompt && Bun.deepEquals(o.schedule ?? null, a.schedule ?? null);
    if (!same) return a.confirmed === true;
    if (a.confirmed !== true) {
      const marked = { ...a, confirmed: true, updatedAt: isoMs(this.now()) };
      this.put(marked);
      this.changedEvent(marked, "was let run on its own", by);
    }
    return true;
  }

  /**
   * Paused: its schedule and webhook start nothing. Resumed: the schedule goes on from now; what it missed while
   * paused doesn't run, and a one-time schedule whose time passed meanwhile is refused until it has a new one.
   */
  pause(id: string, paused: boolean, by: string): Automation {
    const found = this.row(id);
    if (!found) throw notFound(id);
    if (found.paused === paused) return this.withLastRun(found);
    const now = this.now();
    const a: Automation = { ...found, paused };
    if (a.schedule !== undefined && !paused && a.doneAt === undefined) a.nextRunAt = isoMs(nextAfter(a.schedule, now));
    else delete a.nextRunAt;
    a.updatedAt = isoMs(now);
    this.put(a);
    this.changedEvent(a, paused ? "paused" : "resumed", by);
    this.signal();
    return this.withLastRun(a);
  }

  /** A new webhook secret; the old URL stops working at once. */
  rotate(id: string, by: string): [Automation, string] {
    const found = this.row(id);
    if (!found) throw notFound(id);
    const secret = newSecret();
    const a = { ...found, webhook: true, updatedAt: isoMs(this.now()) };
    this.put(a);
    this.setHash(id, secret);
    this.changedEvent(a, "has a new webhook URL", by);
    return [this.withLastRun(a), secret];
  }

  /** Deletes it and its runs; an order a run opened stays an order. */
  delete(id: string, by: string): void {
    const a = this.row(id);
    if (!a) throw notFound(id);
    this.hub.db.transaction((c) => {
      c.query("DELETE FROM automation_runs WHERE automation_id = ?").run(id);
      c.query("DELETE FROM automations WHERE automation_id = ?").run(id);
    });
    this.changedEvent(a, "deleted", by);
    this.signal();
  }

  /** The automation whose webhook `secret` opens, else undefined: an unknown id and a wrong secret look the same. */
  webhookTarget(id: string, secret: string): Automation | undefined {
    const stored = this.hub.db.all<{ h: string | null }>("SELECT webhook_hash AS h FROM automations WHERE automation_id = ?", [id])[0]?.h;
    const given = secretHash(secret);
    // A missing automation still costs a comparison.
    const expected = stored == null ? undefined : unhex(stored);
    const ok = sameHash(given, expected ?? new Uint8Array(32)) && expected !== undefined;
    if (!ok) return undefined;
    const a = this.get(id);
    if (a && this.pruneIfRemoved(a)) return undefined;
    return a;
  }

  // ---- runs ----------------------------------------------------------------------------------------------------------

  /**
   * A run: skipped (and recorded) while the automation is paused (schedule and webhook only) or another run's order
   * is open, but a webhook call then is kept (`deliverQueued`); else it opens the order and starts the project's lead.
   */
  async run(id: string, start: Start): Promise<AutomationRun> {
    const [a, run] = this.open(id, start);
    await this.wakeLead(a, run);
    return run;
  }

  /** `run` up to its order: recorded, and the order opened, without waiting for a lead to start; then `wakeLead`. */
  open(id: string, start: Start): [Automation, AutomationRun] {
    const a = this.get(id);
    if (!a) throw notFound(id);
    if (this.pruneIfRemoved(a)) throw notFound(id);
    const now = this.now();
    const trigger: AutomationTrigger = start.kind;
    const busy = this.active(id);
    const going =
      busy === undefined
        ? undefined
        : busy.workstreamId !== undefined
          ? `run ${busy.runId} is still going (${busy.workstreamId} is open)`
          : `run ${busy.runId} is still starting`;
    const webhook = start.kind === "webhook";
    const waiting = webhook ? this.queuedCount(id) : 0;
    const openNow = going !== undefined;
    // A webhook call's body is data, so one that comes while a run is open is kept (D279), up to QUEUED_MAX; one that
    // comes while calls kept earlier still wait for their order (the open run just ended) joins them, oldest first.
    let keptWhy: string | undefined;
    if (webhook && !a.paused) {
      if (going !== undefined && waiting < QUEUED_MAX) keptWhy = `Kept: ${going}; it goes once that ends.`;
      else if (going === undefined && waiting > 0) keptWhy = "Kept: it goes with the calls kept while the last run was open.";
    }
    let skipped: string | undefined;
    if (keptWhy === undefined) {
      if (start.kind !== "manual" && a.paused) skipped = "the automation is paused";
      else if (start.kind === "webhook" && going !== undefined) skipped = `${going}, and ${QUEUED_MAX} webhook calls already wait for it`;
      else if (start.kind === "schedule" && going !== undefined && a.schedule?.at !== undefined) {
        skipped = `${going}; this one-time run goes once that ends`;
      } else if (going !== undefined) skipped = going;
    }
    let scheduledAt: string | undefined;
    let lateMin: number | undefined;
    if (start.kind === "schedule") {
      const late = now - start.dueMs;
      scheduledAt = isoMs(start.dueMs);
      if (late >= LATE_AFTER_MS) lateMin = Math.round(late / 60_000);
    }
    const payload = start.kind === "webhook" ? start.payload : undefined;
    const state: AutomationRunState = skipped !== undefined ? "skipped" : keptWhy !== undefined ? "queued" : "running";
    const reason = keptWhy ?? skipped;
    let run: AutomationRun = storedRun({
      runId: randomId("ar_"),
      automationId: a.automationId,
      trigger,
      at: isoMs(now),
      state,
      ...(scheduledAt === undefined ? {} : { scheduledAt }),
      ...(lateMin === undefined ? {} : { lateMin }),
      ...(payload === undefined ? {} : { payloadBytes: Buffer.byteLength(payload) }),
      ...(reason === undefined ? {} : { why: why(reason) }),
      ...(start.kind === "manual" ? { by: start.by } : {}),
      ...(skipped !== undefined ? { endedAt: isoMs(now) } : {}),
    });
    this.hub.db.transaction((c) => {
      c.query(
        `INSERT INTO automation_runs (run_id, automation_id, at_ms, state, workstream_id, payload, data)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run(run.runId, id, now, run.state, payload ?? null, JSON.stringify(run));
      // The newest RUNS_KEPT stay, and every run still open or kept: a kept call's row is its body's only copy, and the
      // open run is what makes later triggers wait.
      c.query(
        `DELETE FROM automation_runs WHERE automation_id = ?1 AND state NOT IN ('running', 'queued') AND run_id NOT IN
           (SELECT run_id FROM automation_runs WHERE automation_id = ?1 ORDER BY at_ms DESC, rowid DESC LIMIT ?2)`,
      ).run(id, RUNS_KEPT);
    });
    if (skipped !== undefined) {
      this.runEvent(a, run, `skipped: ${skipped}`);
      return [a, run];
    }
    if (keptWhy !== undefined) {
      if (!openNow) {
        // No run is open: the batch it joined goes now, with it.
        this.deliverQueued(id);
        const delivered = this.runWithPayload(id, run.runId);
        if (delivered) run = delivered[0];
      } else this.runEvent(a, run, `kept for later: ${keptWhy}`);
      return [a, run];
    }
    run = this.openOrder(a, run, payload);
    if (run.workstreamId === undefined) this.runEvent(a, run, "failed: its order could not be opened");
    return [a, run];
  }

  /** Opens an order through the leads' intake; a refusal's message when it can't. */
  private intake(input: IntakeInput): { workstreamId: string } | { error: string } {
    try {
      return { workstreamId: intake(this.hub).intake(input).workstreamId };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  /**
   * Opens the run's order, or marks the run failed when it can't. Idempotent per run: the order's request id is the
   * run's, so a run opened again after a crash finds the order the first try made.
   */
  private openOrder(a: Automation, run: AutomationRun, payload: string | undefined): AutomationRun {
    const opened = this.intake({
      projectRef: a.projectRef,
      text: orderText(a, run, payload),
      clientRequestId: run.runId,
      channel: "automation",
      by: `automation:${a.automationId}`,
    });
    const out: AutomationRun =
      "workstreamId" in opened
        ? storedRun({ ...run, workstreamId: opened.workstreamId })
        : storedRun({ ...run, state: "failed", why: why(opened.error), endedAt: isoMs(this.now()) });
    this.putRun(out);
    return out;
  }

  /**
   * A run recorded as running without its order: the hub stopped between the two. Its order is opened now (or found,
   * if it was made), or the run fails when its automation is gone.
   */
  private recover(run: AutomationRun): AutomationRun {
    if (run.state !== "running" || run.workstreamId !== undefined) return run;
    const payload = this.hub.db.all<{ payload: string | null }>("SELECT payload FROM automation_runs WHERE run_id = ?", [run.runId])[0]?.payload;
    const a = this.row(run.automationId);
    if (!a) {
      const failed = storedRun({
        ...run,
        state: "failed",
        why: why("the hub stopped before its order opened, and the automation is gone"),
        endedAt: isoMs(this.now()),
      });
      this.putRun(failed);
      return failed;
    }
    const out = this.openOrder(a, run, payload ?? undefined);
    this.runEvent(
      a,
      out,
      out.workstreamId !== undefined ? `opened ${out.workstreamId} after a hub restart` : "failed: its order could not be opened after a hub restart",
    );
    return out;
  }

  /** At hub start: every run a stop left without its order, recovered, and the leads of the orders opened told. */
  async recoverAll(): Promise<void> {
    const rows = this.hub.db.all<{ data: string }>("SELECT data FROM automation_runs WHERE state = 'running' AND workstream_id IS NULL ORDER BY at_ms");
    const opened: AutomationRun[] = [];
    for (const { data } of rows) {
      try {
        const run = this.recover(decodeRun(data));
        if (run.workstreamId !== undefined) opened.push(run);
      } catch (error) {
        console.warn("automation run not recovered:", (error as Error).message);
      }
    }
    for (const run of opened) {
      const a = this.row(run.automationId);
      if (a) await this.wakeLead(a, run);
    }
  }

  // ---- removed projects ----------------------------------------------------------------------------------------------

  /** Deletes the automations of `r` with their runs: the project is gone, so they start nothing. */
  private deleteProject(r: ProjectRef): Automation[] {
    const gone = this.list(r);
    this.hub.db.transaction((c) => {
      c.query(
        `DELETE FROM automation_runs WHERE automation_id IN
           (SELECT automation_id FROM automations WHERE machine_id = ? AND project_id = ?)`,
      ).run(r.machineId, r.projectId);
      c.query("DELETE FROM automations WHERE machine_id = ? AND project_id = ?").run(r.machineId, r.projectId);
    });
    for (const a of gone) this.changedEvent(a, "deleted with its project", "hub");
    if (gone.length > 0) this.signal();
    return gone;
  }

  /** True (and its project's automations deleted) when the hub no longer has `a`'s project. */
  private pruneIfRemoved(a: Automation): boolean {
    if (store(this.hub).projectGet(a.projectRef)) return false;
    this.deleteProject(a.projectRef);
    return true;
  }

  /** Every project with automations that the hub's cache no longer has: their automations deleted. */
  pruneRemoved(): number {
    const projects = this.hub.db.all<{ machine_id: string; project_id: string }>("SELECT DISTINCT machine_id, project_id FROM automations");
    let n = 0;
    for (const p of projects) {
      const r = { machineId: p.machine_id, projectId: p.project_id };
      if (!store(this.hub).projectGet(r)) n += this.deleteProject(r).length;
    }
    return n;
  }

  // ---- webhook calls kept while a run was open ---------------------------------------------------------------------

  private queuedCount(id: string): number {
    return this.hub.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ? AND state = 'queued'", [id])[0]?.n ?? 0;
  }

  /**
   * The webhook calls kept while the automation's last run was open, once it no longer is: one order for them all, and
   * each call's run running with it. Undefined while a run is open or none wait. Idempotent: the order's request id is
   * the oldest call's run id.
   */
  deliverQueued(id: string): [Automation, AutomationRun] | undefined {
    const a = this.row(id);
    if (!a || this.active(id) !== undefined) return undefined;
    const runs = this.hub.db
      .all<{ data: string; payload: string | null }>(
        "SELECT data, payload FROM automation_runs WHERE automation_id = ? AND state = 'queued' ORDER BY at_ms, rowid",
        [id],
      )
      .map((r): [AutomationRun, string | null] => [decodeRun(r.data), r.payload]);
    const first = runs[0]?.[0];
    if (!first) return undefined;
    const opened = this.intake({
      projectRef: a.projectRef,
      text: queuedOrderText(a, runs),
      clientRequestId: first.runId,
      channel: "automation",
      by: `automation:${a.automationId}`,
    });
    const n = runs.length;
    const delivered = runs.map(([run]) => {
      const out: AutomationRun =
        "workstreamId" in opened
          ? storedRun({
              ...run,
              state: "running",
              workstreamId: opened.workstreamId,
              why: why(`Kept while an earlier run was open; went in ${opened.workstreamId} with ${n} webhook call${n === 1 ? "" : "s"}.`),
            })
          : storedRun({ ...run, state: "failed", why: why(opened.error), endedAt: isoMs(this.now()) });
      this.putRun(out);
      return out;
    });
    const head = delivered[0] as AutomationRun;
    if (head.workstreamId === undefined) this.runEvent(a, head, `failed: the order for ${n} kept webhook calls could not be opened`);
    return [a, head];
  }

  /** Delivers every automation's kept webhook calls whose open run has ended, and starts the leads that get them. */
  async deliverAll(): Promise<void> {
    const ids = this.hub.db.all<{ id: string }>("SELECT DISTINCT automation_id AS id FROM automation_runs WHERE state = 'queued'");
    for (const { id } of ids) {
      try {
        const got = this.deliverQueued(id);
        if (got) await this.wakeLead(got[0], got[1]);
      } catch (error) {
        console.warn("kept webhook calls not delivered:", (error as Error).message);
      }
    }
  }

  // ---- a Navi's runs -------------------------------------------------------------------------------------------------

  /** Runs each lead thread was seen running (`navi_turns`' `ran`), by `<machine>/<thread>`. */
  private readonly ran = new Map<string, string[]>();

  /** One followed thread event: the run it names remembered, and at a turn's end the Navi's runs it dealt with closed. */
  async threadEvent(event: HubEvent): Promise<void> {
    const data = (event.data ?? undefined) as Record<string, unknown> | undefined;
    const thread = event.threadId ?? (typeof data?.threadId === "string" ? data.threadId : undefined);
    const lead = leads(this.hub)
      .records.leadsList()
      .find((l) => event.machineId === l.projectRef.machineId && thread === l.threadId);
    if (!lead) return;
    const key = `${lead.projectRef.machineId}/${lead.threadId}`;
    const seen = this.ran.get(key) ?? [];
    this.ran.set(key, seen);
    const run = data?.runId;
    if (typeof run === "string" && !seen.includes(run)) {
      seen.push(run);
      if (seen.length > RUNS_SEEN) seen.shift();
    }
    if (event.type !== "thread.started" && event.type !== "thread.waiting") await this.closeNaviRuns(lead.projectRef, [...seen]);
  }

  /**
   * A Navi's automation runs close themselves (D277), so one its lead never closed can't skip every later run. Once the
   * lead's thread has no turn going or queued, a run closes whose order the lead was given in a message whose own run
   * has been seen (`ran`, or the thread's latest run): its first message for an order opened by then, else its latest
   * wake for one opened by that wake. A run whose order still has agents at work waits for a later turn end.
   */
  async closeNaviRuns(r: ProjectRef, ran: string[]): Promise<void> {
    const hub = this.hub;
    if (!naviOf(hub.db.conn, r)) return;
    const lead = leads(hub).records.leadGet(r);
    if (!lead) return;
    const thread = { machineId: r.machineId, threadId: lead.threadId };
    const t = store(hub).threadGet(thread);
    if (!t || BUSY_THREAD.has(t.thread.status)) return;
    const latest = t.lastRunId;
    let sent = lead.startedAt;
    const w = lead.lastWakeAt;
    if (w !== undefined && w > lead.startedAt) {
      const run = sendRunId(thread, wakeRequestId(r, lead.sessionGeneration, w));
      if (latest === run || ran.includes(run)) sent = w;
    }
    const rows = hub.db.all<{ data: string }>(
      `SELECT r.data FROM automation_runs r JOIN automations a ON a.automation_id = r.automation_id
       WHERE a.machine_id = ? AND a.project_id = ? AND r.state = 'running' AND r.workstream_id IS NOT NULL
       ORDER BY r.at_ms`,
      [r.machineId, r.projectId],
    );
    for (const { data } of rows) {
      const run = decodeRun(data);
      const ws = run.workstreamId;
      if (ws === undefined) continue;
      // One opened after the last message is the next turn's. The same millisecond counts as before.
      const order = this.workstream(ws);
      const seen = order?.state === "open" && order.createdAt <= sent;
      if (!seen || leftovers(hub, r, ws).length > 0) continue;
      try {
        await intake(hub).close(r, ws, "the lead's turn for this run ended", `automation:${run.automationId}`);
      } catch (error) {
        console.info(`Navi automation run left open (${ws}): ${(error as Error).message}`);
        continue;
      }
      try {
        const settled = this.settle(run);
        const a = this.row(settled.automationId);
        if (a) this.runEvent(a, settled, `closed ${ws} once the lead's turn ended`);
      } catch (error) {
        console.warn("Navi automation run not settled:", (error as Error).message);
      }
    }
  }

  /**
   * Starts the project's lead if it has none; its first message carries the waiting orders in full. A running lead was
   * woken by the order itself; one that can't start now starts once it can.
   */
  async wakeLead(a: Automation, run: AutomationRun): Promise<void> {
    const w = run.workstreamId;
    if (w === undefined) return;
    let lead: string;
    try {
      const started = await leads(this.hub).autoStart(a.projectRef);
      lead =
        started.kind === "running" ? "the lead has it" : started.kind === "started" ? "the lead started with it" : `it waits for the lead: ${started.message}`;
    } catch (error) {
      lead = `it waits for the lead: ${(error as Error).message}`;
    }
    this.runEvent(a, run, `opened ${w}; ${lead}`);
  }

  private runEvent(a: Automation, run: AutomationRun, what: string): void {
    const by = run.trigger === "schedule" ? "on schedule" : run.trigger === "webhook" ? "from its webhook" : "by Run now";
    this.event(a, "automation.run", clip(`Automation “${a.name}” ran ${by}: ${what}`, 200), {
      runId: run.runId,
      trigger: run.trigger,
      state: run.state,
      workstreamId: run.workstreamId ?? null,
    });
  }

  // ---- the schedule --------------------------------------------------------------------------------------------------

  /**
   * A due schedule: its next run moves on first, from now, so runs missed while the hub was down collapse into this
   * one (a one-time schedule is done instead); then the run. A one-time run skipped for an open run isn't done: it
   * waits for that run to end (`fireWaiting`).
   */
  async fire(id: string, dueMs: number): Promise<void> {
    const found = this.row(id);
    if (!found) return;
    const now = this.now();
    const once = found.schedule?.at !== undefined;
    const a: Automation = { ...found };
    let next: number | undefined;
    if (once) a.doneAt = isoMs(now);
    else if (a.schedule !== undefined && !a.paused) {
      try {
        next = nextAfter(a.schedule, now);
      } catch {
        next = undefined;
      }
    }
    if (next === undefined) delete a.nextRunAt;
    else a.nextRunAt = isoMs(next);
    this.put(a);
    const run = await this.run(id, { kind: "schedule", dueMs });
    if (once && run.state === "skipped") {
      const waiting = this.row(id);
      if (waiting && !waiting.paused) {
        delete waiting.doneAt;
        this.put(waiting);
      }
    }
  }

  /** Runs each one-time schedule that came due while another run of its automation was open, once none is. */
  async fireWaiting(): Promise<void> {
    const rows = this.hub.db.all<{ data: string }>(
      `SELECT data FROM automations WHERE next_run_ms IS NULL AND paused = 0
         AND json_extract(data, '$.schedule.at') IS NOT NULL AND json_extract(data, '$.doneAt') IS NULL
       ORDER BY rowid`,
    );
    const now = this.now();
    for (const { data } of rows) {
      let a: Automation;
      let due: number;
      try {
        a = decode(data);
        const s = a.schedule as AutomationSchedule;
        due = atMs(s.at as string, s);
      } catch {
        continue;
      }
      if (due > now) continue;
      const id = a.automationId;
      try {
        if (this.active(id) !== undefined) continue;
      } catch {
        continue;
      }
      try {
        await this.fire(id, due);
      } catch (error) {
        console.warn(`waiting one-time run of ${id} not started:`, (error as Error).message);
      }
    }
  }

  /** Sleeps until the earliest schedule is due, or until an automation changes. */
  private async scheduler(): Promise<void> {
    const stop = this.hub.shutdown.signal;
    while (!stop.aborted) {
      const row = this.hub.db.all<{ id: string; due: number }>(
        "SELECT automation_id AS id, next_run_ms AS due FROM automations WHERE next_run_ms IS NOT NULL ORDER BY next_run_ms LIMIT 1",
      )[0];
      const wait = row ? row.due - this.now() : undefined;
      if (!row || (wait as number) > 0) {
        await new Promise<void>((resolve) => {
          const timer = wait === undefined ? undefined : setTimeout(done, Math.min(wait, 2 ** 31 - 1));
          const wakeUp = () => done();
          function done() {
            clearTimeout(timer);
            stop.removeEventListener("abort", done);
            resolve();
          }
          this.wakeUp = wakeUp;
          stop.addEventListener("abort", done);
        });
        this.wakeUp = undefined;
        continue;
      }
      try {
        await this.fire(row.id, row.due);
      } catch (error) {
        // Its next run was moved on before the run, so one failure doesn't spin the loop.
        console.error(`automation ${row.id} run failed:`, (error as Error).message);
        this.hub.db.conn.query("UPDATE automations SET next_run_ms = NULL WHERE automation_id = ? AND next_run_ms = ?").run(row.id, row.due);
      }
    }
  }

  /** Runs `fn` after the follow-ups queued before it, its failure logged. */
  private then(what: string, fn: () => Promise<unknown> | unknown): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await fn();
      } catch (error) {
        console.warn(`automations: ${what} failed:`, (error as Error).message);
      }
    });
    return this.chain;
  }

  /** Waits for the event follow-ups queued so far (tests). */
  settled(): Promise<void> {
    return this.chain;
  }

  /**
   * Deletes the automations of projects removed while the hub was down, recovers runs a stop left without their order,
   * then runs the scheduler and follows project removals, Navi turn ends and closed orders, until the hub stops.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    const log = events(this.hub);
    const unsubscribe = log.subscribe((event) => {
      switch (event.type) {
        case "project.removed":
          void this.then("pruning a removed project", () => this.pruneRemoved());
          break;
        case "workstream.done":
        case "workstream.state":
          void this.then("an order's end", async () => {
            await this.deliverAll();
            await this.fireWaiting();
          });
          break;
        case "thread.started":
        case "thread.waiting":
        case "thread.completed":
        case "thread.failed":
        case "thread.interrupted":
        case "thread.usage_limited":
          void this.then("a Navi's turn", () => this.threadEvent(event));
          break;
      }
    });
    this.hub.shutdown.signal.addEventListener("abort", unsubscribe, { once: true });
    void this.then("the catch-up at start", async () => {
      try {
        this.pruneRemoved();
      } catch (error) {
        console.warn("automations of removed projects not deleted:", (error as Error).message);
      }
      await this.recoverAll();
      await this.deliverAll();
      await this.fireWaiting();
      for (const lead of leads(this.hub).records.leadsList()) await this.closeNaviRuns(lead.projectRef, []);
    }).then(() => this.scheduler());
  }
}

/** The hub's automations, `hub.area("automations")`: `automations(hub).list(r)`, `.running(r)`. */
export const automations = (hub: Hub) => hub.area("automations", (h) => new Automations(h));
