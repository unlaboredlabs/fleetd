import { execFile } from "node:child_process";
import { Clock, Data, Duration, Effect, Stream, SubscriptionRef } from "effect";
import type { T3Info, T3Unreachable } from "./link.ts";
import { scrubbedEnv } from "./T3Sessions.ts";

/** The node's view of its local T3. */
export type T3State =
  | { readonly state: "up"; readonly info: T3Info }
  | { readonly state: "down" | "restarting"; readonly reason: string };

export class T3RestartFailed extends Data.TaggedError("T3RestartFailed")<{
  readonly exitCode: number | null;
  readonly stderrTail: string;
}> {
  override get message() {
    return `restart command failed (exit ${this.exitCode ?? "none"}): ${this.stderrTail}`;
  }
}

export interface T3SupervisorOptions {
  readonly probe: Effect.Effect<T3Info, T3Unreachable>;
  /** Absent: the node only reports T3 as down and keeps probing; it never restarts T3 on its own. */
  readonly restart?: Effect.Effect<void, T3RestartFailed>;
}

const PROBE_EVERY = Duration.seconds(5);
const FAILURES_BEFORE_DOWN = 3;
const FIRST_RESTART_DELAY = Duration.seconds(5);
const MAX_RESTART_DELAY = Duration.minutes(5);

/** Runs `argv` (no shell) with a scrubbed environment and a 3 min cap. */
export const restartCommand = (argv: ReadonlyArray<string>) =>
  Effect.callback<void, T3RestartFailed>((resume, signal) => {
    const [command = "t3", ...args] = argv;
    execFile(command, args, { env: scrubbedEnv(), signal, timeout: 180_000, maxBuffer: 1 << 20 }, (error, _stdout, stderr) => {
      if (error === null) return resume(Effect.void);
      const exitCode = typeof error.code === "number" ? error.code : null;
      resume(Effect.fail(new T3RestartFailed({ exitCode, stderrTail: String(stderr).trim().slice(-200) || error.message.slice(0, 200) })));
    });
  });

/** fetch() wraps the useful part ("ECONNREFUSED ...") in `cause`. */
const describe = (error: T3Unreachable) => {
  const cause = error.cause;
  const inner = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
  return (inner instanceof Error ? inner.message : String(inner)).slice(0, 120);
};

type Probe = { readonly ok: true; readonly info: T3Info } | { readonly ok: false; readonly url: string; readonly why: string };

const sameState = (a: T3State, b: T3State) =>
  a.state === "up" || b.state === "up"
    ? a.state === b.state && JSON.stringify(a) === JSON.stringify(b)
    : a.state === b.state && a.reason === b.reason;

/**
 * Probes T3 every 5 s. Three failures in a row mark it down; then the restart command runs, with a delay of 5 s
 * doubling to 5 min between attempts and a probe every 5 s in between, until a probe answers. A T3 that is down
 * at start is reported down after the first failed probe and restarted after the third.
 */
export const makeT3Supervisor = Effect.fn("T3Supervisor.make")(function* (options: T3SupervisorOptions) {

  const probe: Effect.Effect<Probe> = options.probe.pipe(
    Effect.map((info): Probe => ({ ok: true, info })),
    Effect.catch((error) => Effect.succeed<Probe>({ ok: false, url: error.url, why: describe(error) })),
  );
  const initial = yield* probe;
  const state = yield* SubscriptionRef.make<T3State>(
    initial.ok ? { state: "up", info: initial.info } : { state: "down", reason: `T3 at ${initial.url} is not reachable (${initial.why})` },
  );
  const set = (next: T3State) =>
    Effect.gen(function* () {
      if (sameState(yield* SubscriptionRef.get(state), next)) return;
      yield* SubscriptionRef.set(state, next);
      yield* Effect.logInfo(`t3 is ${next.state}`).pipe(Effect.annotateLogs(next.state === "up" ? { ...next.info } : { reason: next.reason }));
    });

  /** Probes every `PROBE_EVERY` until `FAILURES_BEFORE_DOWN` failures in a row; returns the last failure. */
  const monitor = (startingFailures: number, lastWhy: string) =>
    Effect.gen(function* () {
      let failures = startingFailures;
      let why = lastWhy;
      while (failures < FAILURES_BEFORE_DOWN) {
        yield* Effect.sleep(PROBE_EVERY);
        const result = yield* probe;
        if (result.ok) {
          failures = 0;
          yield* set({ state: "up", info: result.info });
        } else {
          failures++;
          why = result.why;
        }
      }
      return why;
    });

  /** Probes now, then every `PROBE_EVERY` within `window`; true once T3 answers. */
  const recovered = (window: Duration.Duration) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(window);
      while (true) {
        const result = yield* probe;
        if (result.ok) {
          yield* set({ state: "up", info: result.info });
          return true;
        }
        if ((yield* Clock.currentTimeMillis) + Duration.toMillis(PROBE_EVERY) > deadline) return false;
        yield* Effect.sleep(PROBE_EVERY);
      }
    });

  const recover = (reason: string) =>
    Effect.gen(function* () {
      yield* set({ state: "down", reason });
      const restart = options.restart;
      if (restart === undefined) {
        yield* Effect.logWarning("t3 is down and no --t3-restart-cmd is configured; waiting for it to come back");
        while (!(yield* recovered(MAX_RESTART_DELAY)));
        return;
      }
      let delay = FIRST_RESTART_DELAY;
      let why = reason;
      for (let attempt = 1; ; attempt++) {
        yield* set({ state: "restarting", reason: why });
        const failed = yield* restart.pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error.message)),
        );
        if (failed !== undefined) yield* Effect.logWarning("t3 restart command failed").pipe(Effect.annotateLogs({ attempt, error: failed }));
        if (yield* recovered(delay)) return;
        why = failed === undefined ? `T3 did not come back after restart ${attempt}` : `restart ${attempt}: ${failed}`;
        delay = Duration.min(Duration.times(delay, 2), MAX_RESTART_DELAY);
      }
    });

  yield* Effect.gen(function* () {
    let failures = initial.ok ? 0 : 1;
    let why = initial.ok ? "" : initial.why;
    while (true) {
      why = yield* monitor(failures, why);
      yield* recover(`T3 failed ${FAILURES_BEFORE_DOWN} health checks in a row (${why})`);
      failures = 0;
    }
  }).pipe(Effect.forkScoped);

  const when = (up: boolean) =>
    SubscriptionRef.changes(state).pipe(
      Stream.filter((current) => (current.state === "up") === up),
      Stream.runHead,
      Effect.asVoid,
    );

  return {
    current: SubscriptionRef.get(state),
    /** The current state first, then each change. */
    changes: SubscriptionRef.changes(state),
    /** Returns once T3 is up (at once if it is). */
    awaitUp: when(true),
    /** Returns once T3 is down or restarting (at once if it is). */
    awaitDown: when(false),
  };
});

export type T3Supervisor = Effect.Success<ReturnType<typeof makeT3Supervisor>>;
