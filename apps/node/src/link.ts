import { HubToNode, type MachineId, NodeLinkClose, type NodeToHub, PROTOCOL_VERSION, ProtocolVersion } from "@fleetd/contracts";
import { Clock, Data, Deferred, Duration, Effect, Exit, Option, Random, Redacted, Schema, type Scope, Stream } from "effect";
import * as Socket from "effect/socket/Socket";
import type { NodeIdentity } from "./identity.ts";
import { makeSessionKeeper, type SessionKeeper, type SessionKeeperOptions } from "./SessionKeeper.ts";

export interface LinkSettings {
  readonly machineId: MachineId;
  readonly name: string;
  readonly tags: ReadonlyArray<string>;
  readonly nodeVersion: string;
  readonly t3Url: string;
  readonly heartbeatEvery?: Duration.Input;
  readonly silenceTimeout?: Duration.Input;
  /** How long to wait for the hub's challenge and welcome. */
  readonly handshakeTimeout?: Duration.Input;
}

export interface T3Info {
  readonly version: string;
  readonly protocol: number;
}

/** The hub refused this node in a way retrying cannot fix (bad key or token, protocol mismatch). */
export class LinkFatal extends Data.TaggedError("LinkFatal")<{ readonly code: number; readonly reason: string }> {
  override get message() {
    return `hub refused this node: ${this.reason}`;
  }
}

class LinkLost extends Data.TaggedError("LinkLost")<{ readonly why: string }> {}

export class T3Unreachable extends Data.TaggedError("T3Unreachable")<{ readonly url: string; readonly cause: unknown }> {
  override get message() {
    return `T3 at ${this.url} is not reachable`;
  }
}

/** `<hub>/node/link` as a ws(s) URL. */
export const linkUrl = (hub: string) => {
  const url = new URL("/node/link", hub);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

/** T3's version and orchestration protocol from its public environment descriptor. */
export const fetchT3Info = (t3Url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(new URL("/.well-known/t3/environment", t3Url), { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { serverVersion?: unknown; orchestrationProtocolVersion?: unknown };
      return {
        version: typeof body.serverVersion === "string" ? body.serverVersion : "unknown",
        protocol: typeof body.orchestrationProtocolVersion === "number" ? body.orchestrationProtocolVersion : 0,
      } satisfies T3Info;
    },
    catch: (cause) => new T3Unreachable({ url: t3Url, cause }),
  });

const decodeFrame = Schema.decodeUnknownExit(Schema.fromJsonString(HubToNode));
const FATAL_CODES: ReadonlySet<number> = new Set([NodeLinkClose.unauthorized, NodeLinkClose.protocolMismatch]);

/**
 * One link over `socket`: challenge, signed hello, welcome, then the current T3 session and heartbeats until the
 * socket ends or the hub goes silent. Succeeds when the link ends after a welcome; fails `LinkFatal` on a refusal.
 */
const runLinkOnce = (
  socket: Socket.Socket,
  settings: LinkSettings,
  deps: {
    readonly identity: NodeIdentity;
    readonly keeper: SessionKeeper;
    readonly t3: T3Info;
    readonly enrollToken: string | undefined;
    readonly onWelcome: Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const heartbeatEvery = Duration.fromInputUnsafe(settings.heartbeatEvery ?? "15 seconds");
    const silenceTimeout = Duration.fromInputUnsafe(settings.silenceTimeout ?? "45 seconds");
    const handshakeTimeout = Duration.fromInputUnsafe(settings.handshakeTimeout ?? "10 seconds");
    const pull = yield* Socket.readerString(socket);
    const writer = yield* socket.writer;
    let buffered: Array<string> = [];
    const nextRaw: Effect.Effect<string, Socket.SocketError> = Effect.suspend(() => {
      const head = buffered.shift();
      if (head !== undefined) return Effect.succeed(head);
      return Effect.map(pull, ([first, ...rest]) => {
        buffered = rest;
        return first;
      });
    });
    const next = (timeout: Duration.Duration, waitingFor: string) =>
      nextRaw.pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap((raw) => {
          if (Option.isNone(raw)) return Effect.fail(new LinkLost({ why: `no ${waitingFor} from the hub for ${Duration.toSeconds(timeout)} s` }));
          const frame = decodeFrame(raw.value);
          return Exit.isSuccess(frame) ? Effect.succeed(frame.value) : Effect.fail(new LinkLost({ why: "hub sent a frame that does not decode" }));
        }),
      );
    const send = (frame: NodeToHub) => writer.write(JSON.stringify(frame));
    const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

    const challenge = yield* next(handshakeTimeout, "challenge");
    if (challenge.t !== "challenge") return yield* new LinkLost({ why: `expected a challenge, got ${challenge.t}` });
    yield* send({
      t: "hello",
      machineId: settings.machineId,
      name: settings.name,
      tags: settings.tags,
      nodeVersion: settings.nodeVersion,
      protocol: ProtocolVersion.make(PROTOCOL_VERSION),
      t3: { url: settings.t3Url, version: deps.t3.version, protocol: deps.t3.protocol },
      pubKey: deps.identity.pubKey,
      sig: deps.identity.sign(challenge.nonce),
      ...(deps.enrollToken === undefined ? {} : { enrollToken: deps.enrollToken }),
    });
    const welcome = yield* next(handshakeTimeout, "welcome");
    if (welcome.t !== "welcome") return yield* new LinkLost({ why: `expected a welcome, got ${welcome.t}` });
    if (welcome.protocol !== PROTOCOL_VERSION) {
      return yield* new LinkFatal({
        code: NodeLinkClose.protocolMismatch,
        reason: `hub speaks protocol ${welcome.protocol}, node speaks ${PROTOCOL_VERSION}: install matching fleetd versions`,
      });
    }
    yield* deps.onWelcome;
    yield* Effect.logInfo("linked to hub").pipe(Effect.annotateLogs({ hubId: welcome.hubId, machineId: settings.machineId }));

    yield* deps.keeper.sessions.pipe(
      Stream.runForEach((kept) =>
        send({ t: "t3session", bearer: Redacted.value(kept.session.bearer), expiresAt: kept.session.expiresAt }).pipe(
          Effect.andThen(Deferred.succeed(kept.delivered, undefined)),
        ),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* Effect.sleep(heartbeatEvery).pipe(
      Effect.andThen(Effect.flatMap(nowIso, (at) => send({ t: "hb", at }))),
      Effect.forever,
      Effect.ignore,
      Effect.forkScoped,
    );

    while (true) yield* next(silenceTimeout, "frame");
  }).pipe(
    Effect.catchTags({
      SocketError: (error): Effect.Effect<never, LinkFatal | LinkLost> => {
        const reason = error.reason;
        if (reason._tag === "SocketCloseError" && FATAL_CODES.has(reason.code)) {
          return Effect.fail(new LinkFatal({ code: reason.code, reason: reason.closeReason ?? `closed with ${reason.code}` }));
        }
        const why = reason._tag === "SocketCloseError" ? `hub closed the link (${reason.code} ${reason.closeReason ?? ""})`.trim() : reason._tag;
        return Effect.fail(new LinkLost({ why }));
      },
    }),
  );

export interface RunNodeOptions {
  readonly settings: LinkSettings;
  readonly identity: NodeIdentity;
  /** Opens a fresh socket to the hub for each attempt. */
  readonly dial: Effect.Effect<Socket.Socket, never, Scope.Scope>;
  readonly t3Info: Effect.Effect<T3Info, T3Unreachable>;
  /** Sent on links until the hub first welcomes this node, then forgotten. */
  readonly enrollToken?: string;
  /** Runs after the first welcome of a link that carried the enroll token. */
  readonly onEnrolled?: Effect.Effect<void>;
  readonly sessions?: SessionKeeperOptions;
}

/** Reconnect delay: 1 s doubling to 30 s, ±20% jitter. Resets after each welcome. */
const backoff = (attempt: number) =>
  Effect.map(Random.nextBetween(0.8, 1.2), (jitter) => Duration.millis(Math.round(Math.min(30_000, 1_000 * 2 ** attempt) * jitter)));

/** The node's main loop: keep a link to the hub, reconnecting with backoff. Only ends by failing `LinkFatal`. */
export const runNode = Effect.fn("runNode")(function* (options: RunNodeOptions) {
  const keeper = yield* makeSessionKeeper(options.sessions);
  let enrollToken = options.enrollToken;
  let attempt = 0;
  while (true) {
    const outcome = yield* Effect.gen(function* () {
      const t3 = yield* options.t3Info;
      const socket = yield* options.dial;
      return yield* runLinkOnce(socket, options.settings, {
        identity: options.identity,
        keeper,
        t3,
        enrollToken,
        onWelcome: Effect.suspend(() => {
          attempt = 0;
          if (enrollToken === undefined) return Effect.void;
          enrollToken = undefined;
          return options.onEnrolled ?? Effect.void;
        }),
      });
    }).pipe(
      Effect.scoped,
      Effect.catchTags({
        LinkLost: (lost) => Effect.logWarning("hub link lost").pipe(Effect.annotateLogs({ why: lost.why })),
        T3Unreachable: (error) => Effect.logWarning(error.message),
      }),
      Effect.exit,
    );
    if (Exit.isFailure(outcome)) return yield* outcome;
    const delay = yield* backoff(attempt++);
    yield* Effect.logInfo("reconnecting to hub").pipe(Effect.annotateLogs({ inMs: Duration.toMillis(delay) }));
    yield* Effect.sleep(delay);
  }
});
