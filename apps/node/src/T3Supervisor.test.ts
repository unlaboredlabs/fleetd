import { Clock, Effect, Logger, type Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { T3Unreachable } from "./link.ts";
import { makeT3Supervisor, T3RestartFailed, type T3State } from "./T3Supervisor.ts";

const INFO = { version: "2fbd4318fc", protocol: 2 };

/** A T3 the test switches on and off; `restart` brings it back once `restartWorks` is set. */
interface FakeT3 {
  up: boolean;
  restartWorks: boolean;
  readonly restartsAt: Array<number>;
  readonly probe: Effect.Effect<typeof INFO, T3Unreachable>;
  readonly restart: Effect.Effect<void, T3RestartFailed>;
}

const fakeT3 = (options: { readonly up: boolean }) => {
  const t3: FakeT3 = {
    up: options.up,
    restartWorks: false,
    restartsAt: [],
    probe: Effect.suspend(() =>
      t3.up
        ? Effect.succeed(INFO)
        : Effect.fail(new T3Unreachable({ url: "http://127.0.0.1:4712", cause: new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:4712") }) })),
    ),
    restart: Effect.gen(function* () {
      t3.restartsAt.push((yield* Clock.currentTimeMillis) / 1000);
      if (!t3.restartWorks) return yield* new T3RestartFailed({ exitCode: 1, stderrTail: "port 4712 is taken" });
      t3.up = true;
    }),
  };
  return t3;
};

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))));

const watch = (changes: Stream.Stream<T3State>) =>
  Effect.gen(function* () {
    const seen: Array<T3State> = [];
    yield* changes.pipe(Stream.runForEach((state) => Effect.sync(() => seen.push(state))), Effect.forkScoped);
    yield* Effect.yieldNow;
    return { seen, states: () => seen.map((state) => state.state) };
  });

describe("T3Supervisor", () => {
  it("rides out two failed probes, reports down on the third, and restarts with backoff from 5 s to 5 min", () =>
    run(
      Effect.gen(function* () {
        const t3 = fakeT3({ up: true });
        const supervisor = yield* makeT3Supervisor({ probe: t3.probe, restart: t3.restart });
        const { seen, states } = yield* watch(supervisor.changes);
        expect(seen).toEqual([{ state: "up", info: INFO }]);

        t3.up = false;
        yield* TestClock.adjust("10 seconds");
        expect(states()).toEqual(["up"]);
        yield* TestClock.adjust("5 seconds");
        expect(states()).toEqual(["up", "down", "restarting"]);
        expect(seen[1]).toEqual({
          state: "down",
          reason: "T3 failed 3 health checks in a row (connect ECONNREFUSED 127.0.0.1:4712)",
        });
        expect(t3.restartsAt).toEqual([15]);

        yield* TestClock.adjust("910 seconds");
        // Gaps of 5, 10, 20, 40, 80, 160 s, then capped at 300 s.
        expect(t3.restartsAt).toEqual([15, 20, 30, 50, 90, 170, 330, 630]);
        expect(seen.at(-1)).toEqual({ state: "restarting", reason: "restart 7: restart command failed (exit 1): port 4712 is taken" });

        t3.restartWorks = true;
        yield* TestClock.adjust("5 seconds");
        expect(t3.restartsAt.at(-1)).toBe(930);
        expect(seen.at(-1)).toEqual({ state: "up", info: INFO });

        // Recovered: the next outage gets the full three probes again.
        t3.up = false;
        t3.restartWorks = false;
        yield* TestClock.adjust("14 seconds");
        expect(seen.at(-1)?.state).toBe("up");
        yield* TestClock.adjust("1 second");
        expect(seen.at(-1)?.state).toBe("restarting");
        expect(t3.restartsAt.at(-1)).toBe(945);
      }),
    ));

  it("starts down when T3 does not answer, restarts it after the third failed probe, and comes up", () =>
    run(
      Effect.gen(function* () {
        const t3 = fakeT3({ up: false });
        t3.restartWorks = true;
        const supervisor = yield* makeT3Supervisor({ probe: t3.probe, restart: t3.restart });
        const { seen, states } = yield* watch(supervisor.changes);
        expect(seen).toEqual([{ state: "down", reason: "T3 at http://127.0.0.1:4712 is not reachable (connect ECONNREFUSED 127.0.0.1:4712)" }]);

        yield* TestClock.adjust("9 seconds");
        expect(t3.restartsAt).toEqual([]);
        yield* TestClock.adjust("1 second");
        expect(t3.restartsAt).toEqual([10]);
        expect(states()).toEqual(["down", "down", "restarting", "up"]);
        yield* supervisor.awaitUp;
      }),
    ));

  it("without a restart command, reports T3 down and up again but never restarts it", () =>
    run(
      Effect.gen(function* () {
        const t3 = fakeT3({ up: true });
        const supervisor = yield* makeT3Supervisor({ probe: t3.probe });
        const { states } = yield* watch(supervisor.changes);
        t3.up = false;
        yield* TestClock.adjust("15 seconds");
        expect(states()).toEqual(["up", "down"]);
        yield* supervisor.awaitDown;

        yield* TestClock.adjust("10 minutes");
        expect(states()).toEqual(["up", "down"]);
        t3.up = true;
        yield* TestClock.adjust("5 seconds");
        expect(states()).toEqual(["up", "down", "up"]);
        expect(t3.restartsAt).toEqual([]);
      }),
    ));
});
