// The slot board: a global cap on running turns, per-project shares, and a FIFO queue within priority.
// A slot is held while a lead's or task's T3 thread is running, read from the executor's thread events, and
// from a grant until that thread first runs. Threads that belong to no lead or task are not counted.
import {
  type HubEvent,
  type HubEventType,
  MachineId,
  ProjectId,
  type ProjectRef,
  type SlotState,
  type TaskKind,
  ThreadId,
  type ThreadRef,
} from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";

export const DEFAULT_CAP = 40;

/** Queue order: lead turns, then reviews, then write and read tasks. */
export type SlotPriority = "lead" | "review" | "work";
const RANK: Record<SlotPriority, number> = { lead: 0, review: 1, work: 2 };

export const priorityOf = (kind: TaskKind): SlotPriority => (kind === "review" ? "review" : "work");

/** The slot holder for a project's lead turns. Tasks hold under their TaskId. */
export const leadHolder = (ref: ProjectRef) => `lead:${ref.machineId}/${ref.projectId}`;

/**
 * Slots of the cap only lead turns may take: min(4, floor(10 % of cap)). Caps below 10 have no band, so a tiny cap
 * is never wholly reserved and tasks can always run.
 */
export const reservedBand = (cap: number) => Math.min(4, Math.floor(cap / 10));

export interface SlotRequest {
  /** A TaskId, or `leadHolder(projectRef)`. */
  readonly holder: string;
  readonly projectRef: ProjectRef;
  readonly priority: SlotPriority;
}

/** What tasks/ports.ts calls a Grant; leases answer in the same shape. */
export type Grant =
  | { readonly granted: true }
  /** Queued; `reason` fits `Task.queuedReason`, e.g. "slots: 40/40 in use". */
  | { readonly granted: false; readonly reason: string };

export class Slots extends Context.Service<
  Slots,
  {
    /**
     * Takes a slot now, or queues the request (FIFO within priority) and says why. Asking again for a holder that
     * already has a slot returns granted; for one already queued, its current reason.
     */
    readonly acquire: (request: SlotRequest) => Effect.Effect<Grant>;
    /**
     * The holder's slot follows `thread` from now on: freed whenever the thread stops running, taken again whenever
     * it runs (a follow-up message), even past the cap, since T3 already started it.
     */
    readonly bind: (holder: string, thread: ThreadRef) => Effect.Effect<void>;
    /** The holder is done: drops its slot or its queued request, then re-evaluates the queue. */
    readonly release: (holder: string) => Effect.Effect<void>;
    /**
     * Runs `listener` after a slot frees (a release, or a lead's or task's thread stopping) or the cap or a share
     * changes, once the queue has been re-evaluated: queued holders that now have a slot get `granted` when they
     * ask again. Also runs once on registering, for slots that came free while the hub was down. The listener runs
     * after the board's lock is dropped, so it may call `acquire`.
     */
    readonly onRelease: (listener: Effect.Effect<void>) => Effect.Effect<void>;
    /** `cap_set`: the global cap (1..1000), a project's share (0..1000), or both. Persisted; applies at once. */
    readonly setCap: (input: {
      readonly cap?: number;
      readonly share?: { readonly projectRef: ProjectRef; readonly share: number };
    }) => Effect.Effect<SlotState>;
    readonly state: () => Effect.Effect<SlotState>;
  }
>()("fleetd/slots/Slots") {}

type ClaimState = "queued" | "held" | "idle";

interface Claim {
  readonly holder: string;
  projectRef: ProjectRef;
  priority: SlotPriority;
  threadId: ThreadId | undefined;
  state: ClaimState;
  order: number;
}

const RUNNING: ReadonlyArray<HubEventType> = ["thread.started"];
const STOPPED: ReadonlyArray<HubEventType> = [
  "thread.completed",
  "thread.failed",
  "thread.interrupted",
  "thread.waiting",
  "thread.usage_limited",
];

const projectKey = (ref: ProjectRef) => `${ref.machineId}/${ref.projectId}`;

/** Why a request of `priority` cannot take a slot now, or undefined if it can. Leads may use the reserved band and pass the share. */
export const blocker = (
  board: { readonly cap: number; readonly used: number; readonly projectUsed: number; readonly share: number },
  priority: SlotPriority,
): string | undefined => {
  const band = reservedBand(board.cap);
  if (priority === "lead") return board.used >= board.cap ? `slots: ${board.used}/${board.cap} in use` : undefined;
  if (board.used >= board.cap - band) {
    return band === 0
      ? `slots: ${board.used}/${board.cap} in use`
      : `slots: ${board.used}/${board.cap} in use (${band} reserved for lead turns)`;
  }
  if (board.projectUsed >= board.share) return `slots: project share ${board.projectUsed}/${board.share} in use`;
  return undefined;
};

export interface SlotsOptions {
  /** The cap until `cap_set` stores one. */
  readonly defaultCap?: number;
}

const make = (options: SlotsOptions) =>
  Effect.gen(function* () {
    const { db } = yield* HubDb.HubDb;
    const store = yield* HubStore.HubStore;
    const events = yield* EventLog.EventLog;
    const leads = yield* LeadRecords.LeadRecords;
    const lock = yield* Semaphore.make(1);

    const sql = {
      claims: db.prepare("SELECT * FROM slot_claims"),
      upsert: db.prepare(
        `INSERT INTO slot_claims (holder, machine_id, project_id, priority, thread_id, state, order_n) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (holder) DO UPDATE SET machine_id = excluded.machine_id, project_id = excluded.project_id,
           priority = excluded.priority, thread_id = excluded.thread_id, state = excluded.state, order_n = excluded.order_n`,
      ),
      remove: db.prepare("DELETE FROM slot_claims WHERE holder = ?"),
      capGet: db.prepare("SELECT value FROM slot_settings WHERE key = 'cap'"),
      capSet: db.prepare(
        "INSERT INTO slot_settings (key, value) VALUES ('cap', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ),
      shares: db.prepare("SELECT * FROM slot_shares"),
      shareSet: db.prepare(
        `INSERT INTO slot_shares (machine_id, project_id, share) VALUES (?, ?, ?)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET share = excluded.share`,
      ),
    };

    let cap = Number(sql.capGet.get()?.value ?? options.defaultCap ?? DEFAULT_CAP);
    const shares = new Map<string, { readonly ref: ProjectRef; share: number }>(
      sql.shares.all().map((row) => {
        const ref = { machineId: MachineId.make(String(row.machine_id)), projectId: ProjectId.make(String(row.project_id)) };
        return [projectKey(ref), { ref, share: Number(row.share) }];
      }),
    );
    const claims = new Map<string, Claim>(
      sql.claims.all().map((row) => [
        String(row.holder),
        {
          holder: String(row.holder),
          projectRef: { machineId: MachineId.make(String(row.machine_id)), projectId: ProjectId.make(String(row.project_id)) },
          priority: String(row.priority) as SlotPriority,
          threadId: row.thread_id === null ? undefined : ThreadId.make(String(row.thread_id)),
          state: String(row.state) as ClaimState,
          order: Number(row.order_n),
        },
      ]),
    );
    let nextOrder = Math.max(0, ...[...claims.values()].map((c) => c.order)) + 1;
    const listeners: Array<Effect.Effect<void>> = [];

    const save = (c: Claim) =>
      sql.upsert.run(c.holder, c.projectRef.machineId, c.projectRef.projectId, c.priority, c.threadId ?? null, c.state, c.order);

    const shareOf = (ref: ProjectRef) => shares.get(projectKey(ref))?.share ?? cap;
    const held = () => [...claims.values()].filter((c) => c.state === "held");
    const boardFor = (ref: ProjectRef) => {
      const all = held();
      const key = projectKey(ref);
      return { cap, used: all.length, projectUsed: all.filter((c) => projectKey(c.projectRef) === key).length, share: shareOf(ref) };
    };
    const reasonFor = (c: Claim) => blocker(boardFor(c.projectRef), c.priority);

    /** Grants every queued claim that fits, best priority and oldest first. */
    const evaluate = () => {
      const queue = [...claims.values()]
        .filter((c) => c.state === "queued")
        .sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.order - b.order);
      for (const c of queue) {
        if (reasonFor(c) !== undefined) continue;
        c.state = "held";
        save(c);
      }
    };

    const notify = Effect.gen(function* () {
      for (const listener of listeners) {
        yield* listener.pipe(
          Effect.catchCause((cause) => Effect.logWarning("slot release listener failed", { cause: Cause.pretty(cause) })),
        );
      }
    });

    /** Runs `body` under the lock; when it freed capacity, re-evaluates the queue and then runs the listeners. */
    const locked = <A>(body: () => { readonly result: A; readonly freed: boolean }) =>
      Effect.gen(function* () {
        const { result, freed } = yield* lock.withPermits(1)(
          Effect.sync(() =>
            HubDb.transaction(db, () => {
              const out = body();
              if (out.freed) evaluate();
              return out;
            }),
          ),
        );
        if (freed) yield* notify;
        return result;
      });

    const findByThread = (machineId: string, threadId: string) =>
      [...claims.values()].find((c) => c.threadId === threadId && c.projectRef.machineId === machineId);

    /** The lead whose current thread this is, if any. */
    const leadOf = (machineId: string, threadId: string) =>
      Effect.map(leads.leads.list(), (all) => all.find((l) => l.projectRef.machineId === machineId && l.threadId === threadId));

    /** Applies a thread's running/stopped status. */
    const observe = (machineId: MachineId, threadId: ThreadId, running: boolean) =>
      Effect.gen(function* () {
        const lead = findByThread(machineId, threadId) === undefined && running ? yield* leadOf(machineId, threadId) : undefined;
        yield* locked(() => {
          let c = findByThread(machineId, threadId);
          if (c === undefined && lead !== undefined) {
            // A lead's first run, or its first under a new thread after a lead restart.
            const holder = leadHolder(lead.projectRef);
            c = claims.get(holder) ?? { holder, projectRef: lead.projectRef, priority: "lead", threadId, state: "idle", order: nextOrder++ };
            c.threadId = threadId;
            claims.set(holder, c);
          }
          if (c === undefined) return { result: undefined, freed: false };
          if (running) {
            c.state = "held";
            save(c);
            return { result: undefined, freed: false };
          }
          if (c.state !== "held") return { result: undefined, freed: false };
          c.state = "idle";
          save(c);
          return { result: undefined, freed: true };
        });
      });

    // Startup: a held or idle claim with a thread follows that thread's last known status. The queue is re-evaluated
    // when the first listener registers, so it hears about slots that came free while the hub was down.
    const head = yield* events.head();
    for (const c of claims.values()) {
      if (c.threadId === undefined || c.state === "queued") continue;
      const thread = yield* store.threads.get({ machineId: c.projectRef.machineId, threadId: c.threadId });
      c.state = thread?.status === "running" ? "held" : "idle";
      save(c);
    }
    for (const t of yield* store.threads.listRunning()) {
      if (findByThread(t.machineId, t.threadId) === undefined) yield* observe(t.machineId, t.threadId, true);
    }

    yield* Effect.gen(function* () {
      let cursor = head;
      while (true) {
        const page = yield* events.wait({ cursor, types: [...RUNNING, ...STOPPED], timeoutSec: 3600 });
        cursor = page.cursor;
        for (const event of page.events as ReadonlyArray<HubEvent>) {
          if (event.machineId === undefined || event.threadId === undefined) continue;
          yield* observe(event.machineId, event.threadId, RUNNING.includes(event.type));
        }
      }
    }).pipe(Effect.forkScoped);

    const state = (): SlotState => {
      const all = held();
      const perProject = new Map<string, { projectRef: ProjectRef; share: number; used: number }>();
      for (const { ref, share } of shares.values()) perProject.set(projectKey(ref), { projectRef: ref, share, used: 0 });
      for (const c of claims.values()) {
        if (c.state === "idle") continue;
        const key = projectKey(c.projectRef);
        const row = perProject.get(key) ?? { projectRef: c.projectRef, share: shareOf(c.projectRef), used: 0 };
        if (c.state === "held") row.used++;
        perProject.set(key, row);
      }
      return {
        cap,
        used: all.length,
        queued: [...claims.values()].filter((c) => c.state === "queued").length,
        reservedBand: reservedBand(cap),
        perProject: [...perProject.values()].sort((a, b) => b.used - a.used).slice(0, 50),
      };
    };

    return Slots.of({
      acquire: (request) =>
        locked((): { result: Grant; freed: false } => {
          let c = claims.get(request.holder);
          if (c?.state === "held") return { result: { granted: true }, freed: false };
          if (c === undefined) {
            c = { ...request, threadId: undefined, state: "queued", order: nextOrder++ };
            claims.set(c.holder, c);
          } else {
            c.projectRef = request.projectRef;
            c.priority = request.priority;
            // An idle holder (its thread stopped) joins the back of the queue; a queued one keeps its place.
            if (c.state === "idle") {
              c.state = "queued";
              c.order = nextOrder++;
            }
          }
          save(c);
          evaluate();
          const reason = c.state === "held" ? undefined : reasonFor(c);
          return { result: reason === undefined ? { granted: true } : { granted: false, reason }, freed: false };
        }),
      bind: (holder, thread) =>
        locked(() => {
          const c = claims.get(holder);
          if (c !== undefined && c.projectRef.machineId === thread.machineId) {
            c.threadId = thread.threadId;
            save(c);
          }
          return { result: undefined, freed: false };
        }),
      release: (holder) =>
        locked(() => {
          const c = claims.get(holder);
          if (c === undefined) return { result: undefined, freed: false };
          claims.delete(holder);
          sql.remove.run(holder);
          return { result: undefined, freed: c.state === "held" };
        }),
      onRelease: (listener) =>
        Effect.gen(function* () {
          listeners.push(listener);
          yield* lock.withPermits(1)(Effect.sync(() => HubDb.transaction(db, evaluate)));
          yield* listener;
        }),
      setCap: (input) =>
        Effect.andThen(
          locked(() => {
            if (input.cap !== undefined) {
              cap = input.cap;
              sql.capSet.run(cap);
            }
            if (input.share !== undefined) {
              const { projectRef, share } = input.share;
              shares.set(projectKey(projectRef), { ref: projectRef, share });
              sql.shareSet.run(projectRef.machineId, projectRef.projectId, share);
            }
            return { result: undefined, freed: true };
          }),
          lock.withPermits(1)(Effect.sync(state)),
        ),
      state: () => lock.withPermits(1)(Effect.sync(state)),
    });
  });

/** Needs HubDb, HubStore, EventLog and LeadRecords. Follows thread events for as long as the layer lives. */
export const layer = (options: SlotsOptions = {}) => Layer.effect(Slots, make(options));
