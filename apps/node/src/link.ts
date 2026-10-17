import os from "node:os";
import { HubToNode, type MachineId, NodeLinkClose, type NodeToHub, PROTOCOL_VERSION, ProtocolVersion } from "@fleetd/contracts";
import { Clock, Data, Deferred, Duration, Effect, Exit, Option, Random, Redacted, Schema, type Scope, Stream } from "effect";
import * as Socket from "effect/socket/Socket";
import { runCmdCheck } from "./CmdCheck.ts";
import type { NodeIdentity } from "./identity.ts";
import type { LeadRelay } from "./LeadCalls.ts";
import { makeSessionKeeper, type SessionKeeper, type SessionKeeperOptions } from "./SessionKeeper.ts";
import { makeT3Supervisor, type T3RestartFailed, type T3State, type T3Supervisor } from "./T3Supervisor.ts";

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
    readonly t3: T3Supervisor;
    readonly enrollToken: string | undefined;
    readonly onWelcome: Effect.Effect<void>;
    readonly leadCalls: LeadRelay | undefined;
    readonly cmdRoots: ReadonlyArray<string>;
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
    const endpoint = (info: T3Info) => ({ url: settings.t3Url, version: info.version, protocol: info.protocol });
    const t3state = (current: T3State) =>
      Effect.flatMap(nowIso, (at) =>
        send(
          current.state === "up"
            ? { t: "t3state", state: "up", t3: endpoint(current.info), at }
            : { t: "t3state", state: current.state, reason: current.reason, at },
        ),
      );

    const challenge = yield* next(handshakeTimeout, "challenge");
    if (challenge.t !== "challenge") return yield* new LinkLost({ why: `expected a challenge, got ${challenge.t}` });
    const t3 = yield* deps.t3.current;
    yield* send({
      t: "hello",
      machineId: settings.machineId,
      name: settings.name,
      tags: settings.tags,
      nodeVersion: settings.nodeVersion,
      protocol: ProtocolVersion.make(PROTOCOL_VERSION),
      ...(t3.state === "up" ? { t3: endpoint(t3.info) } : {}),
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

    // An up hello already said it all; a T3-less one still owes the hub the reason.
    let reported: T3State | undefined = t3.state === "up" ? t3 : undefined;
    const report = (current: T3State) =>
      Effect.suspend(() => {
        if (current === reported) return Effect.void;
        reported = current;
        return t3state(current);
      });
    yield* deps.t3.changes.pipe(Stream.runForEach(report), Effect.ignore, Effect.forkScoped);
    yield* deps.keeper.sessions.pipe(
      Stream.runForEach((kept) =>
        // The hub attaches a session only to a T3 it knows is up, so a fresh "up" goes first.
        Effect.flatMap(deps.t3.current, report).pipe(
          Effect.andThen(send({ t: "t3session", bearer: Redacted.value(kept.session.bearer), expiresAt: kept.session.expiresAt })),
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

    if (deps.leadCalls !== undefined) yield* deps.leadCalls.attach(send);

    while (true) {
      const frame = yield* next(silenceTimeout, "frame");
      if (frame.t === "lead_result" && deps.leadCalls !== undefined) yield* deps.leadCalls.resolve(frame);
      // Off the frame loop, and ended with the link: a lost link kills the command, and the hub fails its wait.
      if (frame.t === "cmd_check") yield* runCmdCheck(frame, deps.cmdRoots).pipe(Effect.flatMap(send), Effect.ignore, Effect.forkScoped);
    }
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
  /** Health probe for the local T3; also reports its version. */
  readonly t3Info: Effect.Effect<T3Info, T3Unreachable>;
  /** Runs when T3 has failed its probes; absent means the node reports T3 down but never restarts it. */
  readonly t3Restart?: Effect.Effect<void, T3RestartFailed>;
  /** Sent on links until the hub first welcomes this node, then forgotten. */
  readonly enrollToken?: string;
  /** Runs after the first welcome of a link that carried the enroll token. */
  readonly onEnrolled?: Effect.Effect<void>;
  readonly sessions?: SessionKeeperOptions;
  /** Relays lead-side CLI calls over each welcomed link. */
  readonly leadCalls?: LeadRelay;
  /** Directories `cmd_check` may run in (and below). Default: the user's home directory. */
  readonly cmdRoots?: ReadonlyArray<string>;
}

/** Reconnect delay: 1 s doubling to 30 s, ±20% jitter. Resets after each welcome. */
const backoff = (attempt: number) =>
  Effect.map(Random.nextBetween(0.8, 1.2), (jitter) => Duration.millis(Math.round(Math.min(30_000, 1_000 * 2 ** attempt) * jitter)));

/**
 * The node's main loop: supervise the local T3 and keep a link to the hub, reconnecting with backoff, whether or
 * not T3 is up. Only ends by failing `LinkFatal`.
 */
export const runNode = Effect.fn("runNode")(function* (options: RunNodeOptions) {
  const t3 = yield* makeT3Supervisor({
    probe: options.t3Info,
    ...(options.t3Restart === undefined ? {} : { restart: options.t3Restart }),
  });
  const keeper = yield* makeSessionKeeper({ ...options.sessions, t3 });
  let enrollToken = options.enrollToken;
  let attempt = 0;
  while (true) {
    const outcome = yield* Effect.gen(function* () {
      const socket = yield* options.dial;
      return yield* runLinkOnce(socket, options.settings, {
        identity: options.identity,
        keeper,
        t3,
        enrollToken,
        leadCalls: options.leadCalls,
        cmdRoots: options.cmdRoots ?? [os.homedir()],
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
      }),
      Effect.exit,
    );
    if (Exit.isFailure(outcome)) return yield* outcome;
    const delay = yield* backoff(attempt++);
    yield* Effect.logInfo("reconnecting to hub").pipe(Effect.annotateLogs({ inMs: Duration.toMillis(delay) }));
    yield* Effect.sleep(delay);
  }
});
