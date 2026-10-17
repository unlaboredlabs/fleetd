// The safety-net sweep: every 5 min, deterministic, no LLM. Built in: re-open streams for running threads
// that lost theirs, report each machine that is offline with running threads (once per offline spell),
// and webhook subscriptions failing for over an hour. Other areas add checks with `register` (overdue
// wakes); each check is isolated, so one failing does not stop the rest.
import type { MachineId } from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import { Watchdog } from "../watchdog/Watchdog.ts";
import { Webhooks } from "../webhooks/Webhooks.ts";

export const SWEEP_EVERY_MS = 5 * 60_000;
/** A wake this far past its time is fired by the sweep, per its catch-up rule. */
export const WAKE_OVERDUE_MS = 2 * 60_000;

export interface SweepCheck {
  /** For logs. */
  readonly name: string;
  readonly run: Effect.Effect<void, unknown>;
}

export class Sweep extends Context.Service<
  Sweep,
  {
    /** Adds a check to every sweep from now on. */
    readonly register: (check: SweepCheck) => Effect.Effect<void>;
    /** One sweep now: the built-in checks, then the registered ones in order. */
    readonly runOnce: () => Effect.Effect<void>;
  }
>()("fleetd/sweep/Sweep") {}

const errorTag = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause);
  return typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : "unknown";
};

export const make = (everyMs: number) =>
  Effect.gen(function* () {
    const store = yield* HubStore.HubStore;
    const events = yield* EventLog.EventLog;
    const watchdog = yield* Watchdog;
    const webhooks = yield* Webhooks;
    const checks: Array<SweepCheck> = [];
    /** Offline machines already reported, by the lastSeenAt of their offline spell. */
    const reported = new Map<MachineId, string>();

    const resubscribe: SweepCheck = {
      name: "streams",
      run: Effect.gen(function* () {
        const opened = yield* watchdog.resubscribe();
        if (opened > 0) yield* Effect.logInfo("sweep: re-opened thread streams").pipe(Effect.annotateLogs({ opened }));
      }),
    };

    const offlineWithRunning: SweepCheck = {
      name: "offline-machines",
      run: Effect.gen(function* () {
        const machines = yield* store.machines.list();
        const running = yield* store.threads.listRunning();
        for (const machine of machines) {
          if (machine.status !== "offline") {
            reported.delete(machine.machineId);
            continue;
          }
          const threads = running.filter((t) => t.machineId === machine.machineId);
          if (threads.length === 0 || reported.get(machine.machineId) === machine.lastSeenAt) continue;
          reported.set(machine.machineId, machine.lastSeenAt);
          const n = threads.length;
          yield* events.append({
            at: new Date(yield* Clock.currentTimeMillis).toISOString(),
            type: "machine.offline",
            machineId: machine.machineId,
            summary: `${machine.machineId} is still offline with ${n} running thread${n === 1 ? "" : "s"}; their runs are not being watched`,
            data: { since: machine.lastSeenAt, runningThreads: threads.slice(0, 20).map((t) => t.threadId), count: n },
          });
        }
      }),
    };

    // The delivery loop reports failing subscriptions too; checkFailing emits once per failing spell.
    const failingWebhooks: SweepCheck = { name: "webhooks", run: webhooks.checkFailing() };

    // Suspended, so checks registered after the loop started are included.
    const runOnce = () =>
      Effect.suspend(() =>
        Effect.forEach(
          [resubscribe, offlineWithRunning, failingWebhooks, ...checks],
          (check) =>
            check.run.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("sweep: check failed").pipe(Effect.annotateLogs({ check: check.name, error: errorTag(cause) })),
              ),
            ),
          { discard: true },
        ),
      );

    yield* Effect.sleep(Duration.millis(everyMs)).pipe(Effect.andThen(runOnce()), Effect.forever, Effect.forkScoped);

    return Sweep.of({ register: (check) => Effect.sync(() => void checks.push(check)), runOnce });
  });

/** The sweep, every `everyMs` (default 5 min). Needs Watchdog, Webhooks, HubStore and EventLog. */
export const layer = (everyMs: number = SWEEP_EVERY_MS) => Layer.effect(Sweep, make(everyMs));
