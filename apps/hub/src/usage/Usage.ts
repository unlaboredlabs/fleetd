// The usage layer (M4). A lead or task thread that hits a usage limit is parked and sent one "continue" at its reset,
// leads first, then reviews, then writers. When one machine's login fails the same way on two threads within 10
// minutes (or its proxy has no account at all), a breaker pauses new turns there with one plain usage.breaker event,
// until the reset or usage_resume. The state is rebuilt from the event log at start, so a hub restart keeps it.
import type {
  HubEvent,
  MachineId,
  TaskId,
  TaskKind,
  ThreadRef,
  UsageClass,
  UsageEventData,
  UsageParked,
  UsageStatus,
} from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type { ExecutorError } from "../executor/Executors.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as WriteQueue from "../queue/WriteQueue.ts";
import * as EventLog from "../store/EventLog.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import { limitOfEvent, parkedOf } from "./classify.ts";
import { countProbes } from "./probes.ts";
import type { UsageReading } from "./UsageSource.ts";

export const BREAKER_WINDOW_MS = 10 * 60_000;
export const CONTINUE_MESSAGE = "Continue where you left off; the usage limit has reset.";
const LAST_EVENTS = 10;
/** Threads listed in one usage.resumed event; the event stays under the log's 2 KB data limit. */
const RESUMED_LISTED = 30;

type ParkedKind = "lead" | TaskKind;
const RANK: Record<ParkedKind, number> = { lead: 0, review: 1, write: 2, read: 3 };

interface ParkedThread {
  readonly ref: ThreadRef;
  readonly kind: ParkedKind;
  readonly taskId?: TaskId;
  readonly parked: UsageParked;
}

interface Hit {
  readonly threadId: string;
  readonly class: UsageClass;
  readonly atMs: number;
  readonly resumeAt?: string;
  readonly model?: string;
}

interface Breaker {
  readonly class: UsageClass;
  readonly since: string;
  readonly until?: string;
  readonly model?: string;
  readonly message: string;
}

interface MachineUsage {
  /** Limit hits inside the breaker window, one per thread. */
  recent: ReadonlyArray<Hit>;
  breaker: Breaker | undefined;
  lastEvents: ReadonlyArray<HubEvent>;
}

export class Usage extends Context.Service<
  Usage,
  {
    /** Why a new turn may not start on the machine now, as a queued reason ("usage: paused until …"); undefined if it may. */
    readonly gate: (machineId: MachineId) => Effect.Effect<string | undefined>;
    /** `gate`, or why this thread is parked. Lead wakes wait while it is set. */
    readonly hold: (ref: ThreadRef) => Effect.Effect<string | undefined>;
    readonly parkedOf: (ref: ThreadRef) => Effect.Effect<UsageParked | undefined>;
    /** Returns once `hold` is clear for the thread. */
    readonly whenClear: (ref: ThreadRef) => Effect.Effect<void>;
    /** The machine's usage view; `reading` is its T3 provider status, failing when the machine is offline. */
    readonly status: (machineId: MachineId, reading: Effect.Effect<UsageReading, ExecutorError>) => Effect.Effect<UsageStatus>;
    /** usage_resume: closes the machine's breaker and sends "continue" to every thread parked there. */
    readonly resume: (machineId: MachineId, by: string) => Effect.Effect<{ readonly resumed: number }>;
    /** Applies the thread events appended so far, so a read right after them sees their effect. */
    readonly drain: Effect.Effect<void>;
  }
>()("fleetd/usage/Usage") {}

/** "Tue 09:00 UTC". */
export const resetText = (iso: string) =>
  `${new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" })
    .format(new Date(iso))
    .replace(",", "")} UTC`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "12 tasks parked", "the lead and 3 tasks parked". */
export const parkedText = (counts: { readonly leads: number; readonly tasks: number }) => {
  const leads = counts.leads === 0 ? undefined : counts.leads === 1 ? "the lead" : plural(counts.leads, "lead");
  const tasks = counts.tasks === 0 && leads !== undefined ? undefined : plural(counts.tasks, "task");
  return `${[leads, tasks].filter((s) => s !== undefined).join(" and ")} parked`;
};

/** The usage.breaker notice. */
export const breakerMessage = (machineId: string, cls: UsageClass, until: string | undefined, model: string | undefined, counts: { readonly leads: number; readonly tasks: number }) =>
  cls === "pool_exhausted"
    ? `your proxy has no account available for ${model ?? "the model"}; fleetd paused work on ${machineId} — check your proxy, then run usage_resume`
    : `Claude ${cls === "rate_limit" ? "rate limit" : "limit"} reached on ${machineId}'s login; resets ${until === undefined ? "at an unknown time" : resetText(until)}; ${parkedText(counts)}`;

const gateText = (machineId: string, b: Breaker) =>
  b.class === "pool_exhausted" || b.until === undefined
    ? `usage: paused until usage_resume (${b.class === "pool_exhausted" ? `your proxy has no account for ${b.model ?? "the model"}` : `Claude limit on ${machineId}'s login`})`
    : `usage: paused until ${resetText(b.until)} (Claude ${b.class === "rate_limit" ? "rate limit" : "limit"} on ${machineId}'s login)`;

const keyOf = (ref: ThreadRef) => `${ref.machineId}/${ref.threadId}`;

const REPLAYED: ReadonlyArray<HubEvent["type"]> = ["thread.usage_limited", "thread.started", "usage.breaker", "usage.resumed"];
const FOLLOWED: ReadonlyArray<HubEvent["type"]> = ["thread.usage_limited", "thread.started"];

const make = Effect.gen(function* () {
  const events = yield* EventLog.EventLog;
  const queue = yield* WriteQueue.WriteQueue;
  const tasks = yield* TaskRecords.TaskRecords;
  const leads = yield* LeadRecords.LeadRecords;
  const scope = yield* Effect.scope;
  const lock = Semaphore.makeUnsafe(1);
  const parked = new Map<string, ParkedThread>();
  const machines = new Map<string, MachineUsage>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const machine = (machineId: string) => {
    let m = machines.get(machineId);
    if (m === undefined) {
      m = { recent: [], breaker: undefined, lastEvents: [] };
      machines.set(machineId, m);
    }
    return m;
  };
  const remember = (m: MachineUsage, event: HubEvent) => void (m.lastEvents = [...m.lastEvents, event].slice(-LAST_EVENTS));
  const parkedOn = (machineId: string) => [...parked.values()].filter((p) => p.ref.machineId === machineId);
  const countsOn = (machineId: string) => {
    const on = parkedOn(machineId);
    const leadCount = on.filter((p) => p.kind === "lead").length;
    return { leads: leadCount, tasks: on.length - leadCount };
  };

  /** Whose thread this is: a task (with its kind) or a lead. Other threads count for the breaker but are not parked. */
  const ownerOf = (ref: ThreadRef) =>
    Effect.gen(function* () {
      const task = yield* tasks.byThread(ref);
      if (task !== undefined) return { kind: task.task.kind as ParkedKind, taskId: task.task.taskId };
      const lead = (yield* leads.leads.list()).find((l) => l.projectRef.machineId === ref.machineId && l.threadId === ref.threadId);
      return lead === undefined ? undefined : { kind: "lead" as const };
    });

  /** Folds one event into the state. Used for the replay at start and for live events alike. */
  const apply = (event: HubEvent) =>
    Effect.gen(function* () {
      if (event.machineId === undefined) return;
      const m = machine(event.machineId);
      const data = (event.data ?? {}) as UsageEventData;
      switch (event.type) {
        case "thread.usage_limited": {
          const limit = limitOfEvent(event);
          if (limit === undefined || event.threadId === undefined) return;
          const ref = { machineId: event.machineId, threadId: event.threadId };
          remember(m, event);
          const atMs = Date.parse(event.at);
          m.recent = [
            ...m.recent.filter((h) => h.threadId !== ref.threadId && h.atMs > atMs - BREAKER_WINDOW_MS),
            {
              threadId: ref.threadId,
              class: limit.class,
              atMs,
              ...(limit.resumeAt === undefined ? {} : { resumeAt: limit.resumeAt }),
              ...(limit.model === undefined ? {} : { model: limit.model }),
            },
          ];
          const owner = yield* ownerOf(ref);
          if (owner !== undefined) parked.set(keyOf(ref), { ref, ...owner, parked: parkedOf(event)! });
          return;
        }
        case "thread.started":
          if (event.threadId !== undefined) parked.delete(keyOf({ machineId: event.machineId, threadId: event.threadId }));
          return;
        case "usage.breaker":
          remember(m, event);
          m.breaker = {
            class: data.class ?? "usage_limit",
            since: event.at,
            message: event.summary,
            ...(data.until === undefined ? {} : { until: data.until }),
            ...(data.model === undefined ? {} : { model: data.model }),
          };
          return;
        case "usage.resumed":
          remember(m, event);
          if (data.breakerCleared === true) {
            m.breaker = undefined;
            m.recent = [];
          }
          for (const t of data.threads ?? []) parked.delete(`${event.machineId}/${t.threadId}`);
          return;
      }
    });

  const emit = (event: Omit<HubEvent, "seq" | "at">) =>
    Effect.gen(function* () {
      const appended = yield* events.append({ ...event, at: yield* nowIso });
      yield* apply(appended);
    });

  /** Still parked as recorded: the task has not ended or been cancelled, the lead thread is still the current one. */
  const stillParked = (p: ParkedThread) =>
    Effect.gen(function* () {
      if (p.kind === "lead") {
        return (yield* leads.leads.list()).some((l) => l.projectRef.machineId === p.ref.machineId && l.threadId === p.ref.threadId);
      }
      const stored = p.taskId === undefined ? undefined : yield* tasks.get(p.taskId);
      return stored !== undefined && !TaskRecords.ENDED_STATES.includes(stored.task.state);
    });

  /** Sends "continue" to `list` in priority order and reports it in one usage.resumed event. Returns how many went out. */
  const resumeThreads = (machineId: MachineId, list: ReadonlyArray<ParkedThread>, how: { readonly breakerCleared: boolean; readonly by: string }) =>
    Effect.gen(function* () {
      const ordered = list.toSorted((a, b) => RANK[a.kind] - RANK[b.kind] || a.parked.since.localeCompare(b.parked.since));
      const sent: Array<{ threadId: string; kind: string; taskId?: string }> = [];
      for (const p of ordered) {
        parked.delete(keyOf(p.ref));
        if (!(yield* stillParked(p))) continue;
        // The id names this park, so a resend after a restart is delivered once.
        const out = yield* Effect.result(queue.send(p.ref, CONTINUE_MESSAGE, `fleetd-usage:${keyOf(p.ref)}:${Date.parse(p.parked.since)}`));
        if (out._tag === "Failure") {
          yield* Effect.logWarning("usage: continue not delivered", { thread: keyOf(p.ref), reason: out.failure._tag });
          continue;
        }
        sent.push({ threadId: p.ref.threadId, kind: p.kind, ...(p.taskId === undefined ? {} : { taskId: p.taskId }) });
      }
      if (!how.breakerCleared && sent.length === 0) return 0;
      const what = `sent "continue" to ${plural(sent.length, "parked thread")}`;
      yield* emit({
        type: "usage.resumed",
        machineId,
        summary: how.breakerCleared
          ? `Usage pause on ${machineId} lifted (${how.by === "reset" ? "the limit reset" : `usage_resume by ${how.by}`}); ${what}`
          : `Usage limit reset on ${machineId}; ${what}`,
        data: { breakerCleared: how.breakerCleared, by: how.by, threads: sent.slice(0, RESUMED_LISTED) },
      });
      return sent.length;
    });

  /** Resumes whatever is due now: everything a lapsed breaker held, and parks whose reset has passed. */
  const tick = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    for (const [machineId, m] of machines) {
      const b = m.breaker;
      const cleared = b !== undefined && b.until !== undefined && Date.parse(b.until) <= nowMs;
      if (b !== undefined && !cleared) continue;
      const due = parkedOn(machineId).filter((p) => p.parked.resumeAt !== undefined && Date.parse(p.parked.resumeAt) <= nowMs);
      if (cleared || due.length > 0) yield* resumeThreads(machineId as MachineId, due, { breakerCleared: cleared, by: "reset" });
    }
  });

  const runLocked = <A>(effect: Effect.Effect<A>, what: string) =>
    effect.pipe(
      lock.withPermit,
      Effect.catchCause((cause) => Effect.as(Effect.logWarning(`usage: ${what} failed`, { cause: Cause.pretty(cause) }), undefined)),
    );

  /** A tick at `iso`. Timers are never cancelled: a tick with nothing due does nothing. */
  const schedule = (iso: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sleep(Duration.millis(Math.max(0, Date.parse(iso) - now))).pipe(Effect.andThen(runLocked(tick, "resume")), Effect.forkIn(scope), Effect.asVoid),
    );

  /** Opens the machine's breaker when its recent hits call for it. */
  const maybeTrip = (machineId: MachineId) =>
    Effect.gen(function* () {
      const m = machine(machineId);
      const last = m.recent.at(-1);
      if (m.breaker !== undefined || last === undefined) return;
      const same = m.recent.filter((h) => h.class === last.class);
      if (last.class !== "pool_exhausted" && same.length < 2) return;
      const resets = same.flatMap((h) => (h.resumeAt === undefined ? [] : [h.resumeAt])).toSorted();
      const until = last.class === "pool_exhausted" ? undefined : resets.at(-1);
      const counts = countsOn(machineId);
      yield* emit({
        type: "usage.breaker",
        machineId,
        attention: "loud",
        summary: breakerMessage(machineId, last.class, until, last.model, counts),
        data: { class: last.class, parked: counts, ...(until === undefined ? {} : { until }), ...(last.model === undefined ? {} : { model: last.model }) },
      });
      if (until !== undefined) yield* schedule(until);
    });

  const onLive = (event: HubEvent) =>
    Effect.gen(function* () {
      yield* apply(event);
      if (event.type !== "thread.usage_limited" || event.machineId === undefined) return;
      yield* maybeTrip(event.machineId);
      const resumeAt = limitOfEvent(event)?.resumeAt;
      if (resumeAt !== undefined) yield* schedule(resumeAt);
    });

  // Replay the log, then follow it from where the replay stopped.
  let cursor = 0;
  for (;;) {
    const page = yield* events.wait({ cursor, types: REPLAYED, timeoutSec: 0 });
    for (const event of page.events) yield* apply(event);
    cursor = page.cursor;
    if (!page.more) break;
  }
  for (const m of machines.values()) if (m.breaker?.until !== undefined) yield* schedule(m.breaker.until);
  for (const p of parked.values()) if (p.parked.resumeAt !== undefined) yield* schedule(p.parked.resumeAt);
  /** Applies every followed event appended so far. Runs under the lock, so the follower and `drain` share one cursor. */
  const pump = Effect.gen(function* () {
    for (;;) {
      const page = yield* events.wait({ cursor, types: FOLLOWED, timeoutSec: 0 });
      for (const event of page.events) {
        yield* onLive(event).pipe(Effect.catchCause((cause) => Effect.logWarning("usage: event not handled", { seq: event.seq, cause: Cause.pretty(cause) })));
      }
      cursor = page.cursor;
      if (!page.more) return;
    }
  });
  const drain = runLocked(pump, "drain");
  yield* Effect.forkScoped(
    Effect.forever(Effect.andThen(events.wait({ cursor, types: FOLLOWED, timeoutSec: 3600 }), drain)),
  );

  const gate: Usage["Service"]["gate"] = (machineId) =>
    Effect.map(Clock.currentTimeMillis, (nowMs) => {
      const b = machines.get(machineId)?.breaker;
      if (b === undefined || (b.until !== undefined && Date.parse(b.until) <= nowMs)) return undefined;
      return gateText(machineId, b).slice(0, 200);
    });

  const hold: Usage["Service"]["hold"] = (ref) =>
    Effect.map(gate(ref.machineId), (paused) => {
      if (paused !== undefined) return paused;
      const p = parked.get(keyOf(ref))?.parked;
      if (p === undefined) return undefined;
      return `usage: parked until ${p.resumeAt === undefined ? "usage_resume" : resetText(p.resumeAt)}`;
    });

  const whenClear: Usage["Service"]["whenClear"] = (ref) =>
    Effect.gen(function* () {
      while (true) {
        const head = yield* events.head();
        if ((yield* hold(ref)) === undefined) return;
        yield* events.wait({ cursor: head, types: ["usage.resumed", "thread.started"], machineId: ref.machineId, timeoutSec: 3600 });
      }
    });

  const status: Usage["Service"]["status"] = (machineId, reading) =>
    Effect.gen(function* () {
      yield* drain;
      const read = yield* Effect.result(reading);
      const probes =
        read._tag === "Failure"
          ? { observable: false, reason: `${machineId} is offline, so its T3 trace file was not read` }
          : !read.success.local
            ? { observable: false, reason: `T3 on ${machineId} runs on another machine; its trace file is not readable from the hub` }
            : read.success.logsDir === undefined
              ? { observable: false, reason: `T3 on ${machineId} did not report a logs directory` }
              : yield* countProbes(read.success.logsDir);
      const m = machines.get(machineId);
      const b = m?.breaker;
      return {
        machineId,
        login: read._tag === "Success" ? read.success.login : "unknown",
        breaker:
          b === undefined
            ? { state: "closed" }
            : { state: "open", class: b.class, since: b.since, message: b.message, ...(b.until === undefined ? {} : { until: b.until }) },
        parked: countsOn(machineId),
        lastEvents: m?.lastEvents ?? [],
        probes,
      } satisfies UsageStatus;
    });

  const resume: Usage["Service"]["resume"] = (machineId, by) =>
    Effect.gen(function* () {
      yield* pump;
      const cleared = machines.get(machineId)?.breaker !== undefined;
      const resumed = yield* resumeThreads(machineId, parkedOn(machineId), { breakerCleared: cleared, by });
      return { resumed };
    }).pipe(lock.withPermit);

  return Usage.of({
    gate,
    hold,
    parkedOf: (ref) => Effect.sync(() => parked.get(keyOf(ref))?.parked),
    whenClear,
    status,
    resume,
    drain,
  });
});

/** Needs EventLog, WriteQueue, TaskRecords and LeadRecords. */
export const layer = Layer.effect(Usage, make);
