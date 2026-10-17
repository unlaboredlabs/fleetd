import { Deferred, Duration, Effect, Option, Queue, Schedule, Stream, SubscriptionRef } from "effect";
import { type T3Session, T3Sessions } from "./T3Sessions.ts";

/** A minted session plus a signal the link completes once the hub has been sent it. */
export interface KeptSession {
  readonly session: T3Session;
  readonly delivered: Deferred.Deferred<void>;
}

export interface SessionKeeperOptions {
  /** Re-mint this long after each mint; sessions live 1 h. */
  readonly remintAfter?: Duration.Input;
  /** Revoke the previous session this long after the hub was sent its replacement, so the hub can switch first. */
  readonly revokeGrace?: Duration.Input;
  /** Mints only while T3 is up, and re-mints as soon as it comes back from being down. Default: always up. */
  readonly t3?: { readonly awaitUp: Effect.Effect<void>; readonly awaitDown: Effect.Effect<void> };
}

const retryMint = Schedule.min([Schedule.exponential("5 seconds"), Schedule.spaced("5 minutes")]);

/**
 * Keeps one live T3 session for the hub: mints once T3 is up, re-mints every 45 min and whenever T3 comes back
 * from being down, and revokes the old session once its replacement has reached the hub. Revoking first would
 * drop the hub's live T3 socket.
 */
export const makeSessionKeeper = Effect.fn("SessionKeeper.make")(function* (options: SessionKeeperOptions = {}) {
  const t3 = yield* T3Sessions;
  const remintAfter = Duration.fromInputUnsafe(options.remintAfter ?? "45 minutes");
  const revokeGrace = Duration.fromInputUnsafe(options.revokeGrace ?? "30 seconds");
  const current = yield* SubscriptionRef.make<Option.Option<KeptSession>>(Option.none());
  /** remintNow requests, each completed once its session has reached the hub. */
  const kicks = yield* Queue.unbounded<Deferred.Deferred<void>>();

  const mint = t3.mint.pipe(
    Effect.tapError((error) =>
      Effect.logWarning("t3 session mint failed; retrying").pipe(
        Effect.annotateLogs({ exitCode: error.exitCode, stderr: error.stderrTail }),
      ),
    ),
    Effect.retry(retryMint),
    Effect.flatMap((session) => Effect.map(Deferred.make<void>(), (delivered): KeptSession => ({ session, delivered }))),
    Effect.tap((kept) => Effect.logInfo("t3 session minted").pipe(Effect.annotateLogs({ sessionId: kept.session.sessionId, expiresAt: kept.session.expiresAt }))),
  );

  const revokeAfterSwitch = (previous: KeptSession, next: KeptSession) =>
    Deferred.await(next.delivered).pipe(
      Effect.andThen(Effect.sleep(revokeGrace)),
      Effect.andThen(t3.revoke(previous.session.sessionId)),
      Effect.tap(() => Effect.logInfo("t3 session revoked").pipe(Effect.annotateLogs({ sessionId: previous.session.sessionId }))),
      Effect.catchTags({
        T3SessionError: (error) =>
          Effect.logWarning("t3 session revoke failed; it expires on its own").pipe(
            Effect.annotateLogs({ sessionId: previous.session.sessionId, exitCode: error.exitCode }),
          ),
      }),
    );

  const awaitUp = options.t3?.awaitUp ?? Effect.void;
  const awaitDown = options.t3?.awaitDown ?? Effect.never;

  yield* Effect.gen(function* () {
    let kept: KeptSession | undefined;
    while (true) {
      yield* awaitUp;
      const next = yield* mint;
      yield* SubscriptionRef.set(current, Option.some(next));
      if (kept !== undefined) yield* Effect.forkScoped(revokeAfterSwitch(kept, next));
      kept = next;
      // Requests made while this one was minting are answered by it.
      const answered = yield* Queue.clear(kicks);
      if (answered.length > 0) {
        yield* Deferred.await(next.delivered).pipe(Effect.andThen(Effect.forEach(answered, (d) => Deferred.succeed(d, undefined))), Effect.forkScoped);
      }
      const kicked = yield* Effect.raceFirst(Effect.raceFirst(Effect.sleep(remintAfter), awaitDown).pipe(Effect.as(undefined)), Queue.take(kicks));
      // Back in line, so the next mint answers it with the others.
      if (kicked !== undefined) yield* Queue.offer(kicks, kicked);
    }
  }).pipe(Effect.forkScoped);

  return {
    /** Mints a fresh session now (once T3 is up) and returns once the hub has been sent it. */
    remintNow: Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      yield* Queue.offer(kicks, done);
      yield* Deferred.await(done);
    }),
    /** The current session first (once one exists), then each replacement. */
    sessions: SubscriptionRef.changes(current).pipe(
      Stream.filter(Option.isSome),
      Stream.map((some) => some.value),
    ),
  };
});

export type SessionKeeper = Effect.Success<ReturnType<typeof makeSessionKeeper>>;
