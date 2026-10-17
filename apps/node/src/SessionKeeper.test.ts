import { Deferred, Effect, Layer, Logger, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { type KeptSession, makeSessionKeeper } from "./SessionKeeper.ts";
import { T3SessionError, T3Sessions } from "./T3Sessions.ts";

const fakeT3 = (options: { readonly failFirstMint?: boolean } = {}) => {
  let mints = 0;
  let failed = false;
  const revoked: Array<string> = [];
  const layer = Layer.succeed(T3Sessions)({
    mint: Effect.suspend(() => {
      if (options.failFirstMint && !failed) {
        failed = true;
        return Effect.fail(new T3SessionError({ operation: "issue", exitCode: 1, stderrTail: "database is locked" }));
      }
      mints++;
      return Effect.succeed({ sessionId: `s-${mints}`, bearer: Redacted.make(`bearer-${mints}`), expiresAt: "later" });
    }),
    revoke: (sessionId) => Effect.sync(() => revoked.push(sessionId)),
  });
  return { layer, revoked, mints: () => mints };
};

const run = <A, E>(effect: Effect.Effect<A, E, T3Sessions | import("effect").Scope.Scope>, layer: Layer.Layer<T3Sessions>) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))),
  );

const watch = Effect.fn(function* () {
  const keeper = yield* makeSessionKeeper();
  const seen: Array<KeptSession> = [];
  yield* keeper.sessions.pipe(
    Stream.runForEach((kept) => Effect.sync(() => seen.push(kept))),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  return { seen, ids: () => seen.map((kept) => kept.session.sessionId) };
});

describe("SessionKeeper", () => {
  it("re-mints at 45 min and revokes the old session only after the hub got the new one", () => {
    const t3 = fakeT3();
    return run(
      Effect.gen(function* () {
        const { seen, ids } = yield* watch();
        expect(ids()).toEqual(["s-1"]);

        yield* TestClock.adjust("2699 seconds");
        expect(t3.mints()).toBe(1);
        yield* TestClock.adjust("1 second");
        expect(ids()).toEqual(["s-1", "s-2"]);

        // Not yet sent to the hub: the old session must stay valid.
        yield* TestClock.adjust("10 minutes");
        expect(t3.revoked).toEqual([]);

        yield* Deferred.succeed(seen[1]!.delivered, undefined);
        yield* TestClock.adjust("29 seconds");
        expect(t3.revoked).toEqual([]);
        yield* TestClock.adjust("1 second");
        expect(t3.revoked).toEqual(["s-1"]);

        yield* TestClock.adjust("45 minutes");
        expect(ids()).toEqual(["s-1", "s-2", "s-3"]);
      }),
      t3.layer,
    );
  });

  it("retries a failed mint with backoff", () => {
    const t3 = fakeT3({ failFirstMint: true });
    return run(
      Effect.gen(function* () {
        const { ids } = yield* watch();
        expect(ids()).toEqual([]);
        yield* TestClock.adjust("5 seconds");
        expect(ids()).toEqual(["s-1"]);
      }),
      t3.layer,
    );
  });
});
