import { generateKeyPairSync, sign } from "node:crypto";
import { type HubToNode, MachineId, NodeLinkClose, PROTOCOL_VERSION } from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import * as Auth from "../auth/Auth.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import { type LinkExecutors, make } from "./NodeLinkServer.ts";

const LAB_A = MachineId.make("lab-a");
const BEARER = "t3-bearer-secret-0123456789abcdef";

const closeError = (code: number, closeReason?: string) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason }) });

/** Two ends of an in-memory WebSocket: the hub gets a Socket, the test drives the node end through queues. */
const socketPair = Effect.gen(function* () {
  const toHub = yield* Queue.unbounded<string, Socket.SocketError>();
  const toNode = yield* Queue.unbounded<string, Socket.SocketError>();
  const hub = Socket.make({
    reader: Effect.succeed({ pull: Effect.map(Queue.take(toHub), (frame) => [frame] as const), upgrade: () => Effect.void }),
    writer: Effect.succeed({
      write: (chunk) =>
        Socket.isCloseEvent(chunk)
          ? Effect.all([Queue.fail(toNode, closeError(chunk.code, chunk.reason)), Queue.fail(toHub, closeError(chunk.code))]).pipe(Effect.asVoid)
          : Queue.offer(toNode, String(chunk)).pipe(Effect.asVoid),
      writeAll: (chunks) => Queue.offerAll(toNode, chunks.map(String)).pipe(Effect.asVoid),
    }),
  });
  const node = {
    send: (frame: unknown) => Queue.offer(toHub, JSON.stringify(frame)),
    next: Effect.map(Queue.take(toNode), (raw) => JSON.parse(raw) as HubToNode),
    /** Resolves with the close code and reason once the hub closes the link. */
    closed: Effect.gen(function* () {
      while (true) {
        const exit = yield* Effect.exit(Queue.take(toNode));
        if (Exit.isFailure(exit)) {
          const reason = (Cause.squash(exit.cause) as Socket.SocketError).reason as Socket.SocketCloseError;
          return { code: reason.code, reason: reason.closeReason };
        }
      }
    }),
    drop: Queue.fail(toHub, closeError(1006)),
  };
  return { hub, node };
});

const identity = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubKey = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url").toString("base64");
  return { pubKey, sign: (nonce: string) => sign(null, Buffer.from(nonce, "utf8"), privateKey).toString("base64") };
};

const hello = (id: ReturnType<typeof identity>, nonce: string, extra: Record<string, unknown> = {}) => ({
  t: "hello",
  machineId: LAB_A,
  name: "Lab A",
  tags: ["linux"],
  nodeVersion: "0.0.0",
  protocol: PROTOCOL_VERSION,
  t3: { url: "http://127.0.0.1:4711", version: "2fbd4318fc", protocol: 2 },
  pubKey: id.pubKey,
  sig: id.sign(nonce),
  ...extra,
});

/** Real store, event log and auth on an in-memory database; only W2's executors are faked. */
const harness = (options: { readonly attachFails?: boolean } = {}) =>
  Effect.gen(function* () {
    const store = yield* HubStore.HubStore;
    const eventLog = yield* EventLog.EventLog;
    const auth = yield* Auth.Auth;
    const attached: Array<{ machineId: string; t3Url: string; bearer: string }> = [];
    const detached: Array<string> = [];
    const executors: LinkExecutors = {
      attach: (machineId, session) =>
        options.attachFails
          ? Effect.fail({ _tag: "T3ConnectError", message: `could not connect with ${session.bearer}` })
          : Effect.sync(() => attached.push({ machineId, ...session })),
      detach: (machineId) => Effect.sync(() => detached.push(machineId)),
    };
    const server = yield* make({ hubId: "hub-test", executors });
    return {
      server,
      auth,
      attached,
      detached,
      createToken: Effect.map(auth.createEnrollToken(LAB_A), ({ token }) => token),
      enroll: (pubKey: string) =>
        Effect.flatMap(auth.createEnrollToken(LAB_A), ({ token }) => auth.consumeEnrollToken(token, LAB_A, pubKey)),
      machine: store.machines.get(LAB_A),
      status: Effect.map(store.machines.get(LAB_A), (machine) => machine?.status),
      events: Effect.map(eventLog.wait({ cursor: 0, timeoutSec: 0 }), ({ events }) => events),
      eventTypes: Effect.map(eventLog.wait({ cursor: 0, timeoutSec: 0 }), ({ events }) => events.map((event) => event.type)),
    };
  });

const logs: Array<string> = [];
const captureLogs = Logger.make(({ message, cause, fiber }) => {
  logs.push(JSON.stringify({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) }) + Cause.pretty(cause));
});

const services = Layer.mergeAll(HubStore.layer, EventLog.layer, Auth.layer).pipe(Layer.provideMerge(HubDb.layerMemory));

const runTest = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | HubStore.HubStore | EventLog.EventLog | Auth.Auth>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(services),
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([captureLogs])),
      Effect.provideService(References.MinimumLogLevel, "All"),
    ),
  );

/** Starts the hub's handler on a fresh link and returns the node end after the challenge arrives. */
const connect = (server: Effect.Success<ReturnType<typeof make>>) =>
  Effect.gen(function* () {
    const { hub, node } = yield* socketPair;
    const fiber = yield* Effect.forkChild(server.handle(hub));
    const challenge = yield* node.next;
    if (challenge.t !== "challenge") throw new Error(`expected challenge, got ${challenge.t}`);
    return { node, nonce: challenge.nonce, fiber };
  });

describe("NodeLinkServer handshake", () => {
  it("enrolls with a token, then accepts signature-only links; t3session attaches the executor", () =>
    runTest(
      Effect.gen(function* () {
        const h = yield* harness();
        const id = identity();
        const token = yield* h.createToken;

        const first = yield* connect(h.server);
        yield* first.node.send(hello(id, first.nonce, { enrollToken: token }));
        expect(yield* first.node.next).toEqual({ t: "welcome", hubId: "hub-test", protocol: PROTOCOL_VERSION });
        expect(yield* h.auth.nodePubKey(LAB_A)).toBe(id.pubKey);
        expect(yield* h.status).toBe("online");
        expect(yield* h.eventTypes).toEqual(["machine.online"]);

        yield* first.node.send({ t: "t3session", bearer: BEARER, expiresAt: "2026-10-17T11:00:00.000Z" });
        yield* first.node.send({ t: "hb", at: "2026-10-17T10:00:15.000Z" });
        yield* first.node.drop;
        yield* Fiber.join(first.fiber);
        expect(h.attached).toEqual([{ machineId: "lab-a", t3Url: "http://127.0.0.1:4711", bearer: BEARER }]);

        const second = yield* connect(h.server);
        yield* second.node.send(hello(id, second.nonce));
        expect((yield* second.node.next).t).toBe("welcome");
        // Reconnecting before the silence timeout is not a new online transition.
        expect(yield* h.eventTypes).toEqual(["machine.online"]);
      }),
    ));

  it("refuses a bad signature without burning the enroll token", () =>
    runTest(
      Effect.gen(function* () {
        const h = yield* harness();
        const id = identity();
        const token = yield* h.createToken;

        const bad = yield* connect(h.server);
        yield* bad.node.send(hello(id, "some-other-nonce", { enrollToken: token }));
        expect((yield* bad.node.closed).code).toBe(NodeLinkClose.unauthorized);

        // Someone else's key in the hello, signed with ours.
        const impostor = yield* connect(h.server);
        yield* impostor.node.send({ ...hello(identity(), impostor.nonce), pubKey: id.pubKey, enrollToken: token });
        expect((yield* impostor.node.closed).code).toBe(NodeLinkClose.unauthorized);
        expect(yield* h.status).toBeUndefined();

        const good = yield* connect(h.server);
        yield* good.node.send(hello(id, good.nonce, { enrollToken: token }));
        expect((yield* good.node.next).t).toBe("welcome");
      }),
    ));

  it("refuses a reused or expired enroll token and says how to get a new one", () =>
    runTest(
      Effect.gen(function* () {
        const h = yield* harness();
        const id = identity();
        const token = yield* h.createToken;
        const later = yield* h.createToken;

        const first = yield* connect(h.server);
        yield* first.node.send(hello(id, first.nonce, { enrollToken: token }));
        expect((yield* first.node.next).t).toBe("welcome");

        const reused = yield* connect(h.server);
        yield* reused.node.send(hello(identity(), reused.nonce, { enrollToken: token }));
        expect(yield* reused.node.closed).toEqual({
          code: NodeLinkClose.unauthorized,
          reason: "enrollment token was already used: run fleetd hub token create --machine lab-a",
        });

        yield* TestClock.adjust("16 minutes");
        const expired = yield* connect(h.server);
        yield* expired.node.send(hello(identity(), expired.nonce, { enrollToken: later }));
        const refusal = yield* expired.node.closed;
        expect(refusal.code).toBe(NodeLinkClose.unauthorized);
        expect(refusal.reason).toContain("enrollment token expired");
        expect(yield* h.auth.nodePubKey(LAB_A)).toBe(id.pubKey);
      }),
    ));

  it("refuses an unenrolled machine and a key that differs from the enrolled one", () =>
    runTest(
      Effect.gen(function* () {
        const h = yield* harness();

        const unknown = yield* connect(h.server);
        yield* unknown.node.send(hello(identity(), unknown.nonce));
        expect(yield* unknown.node.closed).toEqual({
          code: NodeLinkClose.unauthorized,
          reason: "lab-a is not enrolled: run fleetd hub token create --machine lab-a, then fleetd node join",
        });

        yield* h.enroll(identity().pubKey);
        const other = yield* connect(h.server);
        yield* other.node.send(hello(identity(), other.nonce));
        expect((yield* other.node.closed).code).toBe(NodeLinkClose.unauthorized);
      }),
    ));

  it("refuses a node on another protocol version, frames before the hello, and a silent node", () =>
    runTest(
      Effect.gen(function* () {
        const h = yield* harness();
        const id = identity();
        yield* h.enroll(id.pubKey);

        const newer = yield* connect(h.server);
        yield* newer.node.send(hello(id, newer.nonce, { protocol: PROTOCOL_VERSION + 1 }));
        expect(yield* newer.node.closed).toEqual({
          code: NodeLinkClose.protocolMismatch,
          reason: `hub speaks protocol ${PROTOCOL_VERSION}, node speaks ${PROTOCOL_VERSION + 1}: install matching fleetd versions`,
        });

        const early = yield* connect(h.server);
        yield* early.node.send({ t: "t3session", bearer: BEARER, expiresAt: "2026-10-17T11:00:00.000Z" });
        expect((yield* early.node.closed).code).toBe(NodeLinkClose.badFrame);
        expect(h.attached).toEqual([]);

        const silent = yield* connect(h.server);
        yield* TestClock.adjust("10 seconds");
        expect((yield* silent.node.closed).code).toBe(NodeLinkClose.badFrame);
        expect(yield* h.eventTypes).toEqual([]);
      }),
    ));

  it("hands the machine to a newer link and closes the older one", () =>
    runTest(
      Effect.gen(function* () {
        const h = yield* harness();
        const id = identity();
        yield* h.enroll(id.pubKey);

        const old = yield* connect(h.server);
        yield* old.node.send(hello(id, old.nonce));
        expect((yield* old.node.next).t).toBe("welcome");
        const fresh = yield* connect(h.server);
        yield* fresh.node.send(hello(id, fresh.nonce));
        expect((yield* fresh.node.next).t).toBe("welcome");
        expect((yield* old.node.closed).code).toBe(NodeLinkClose.replaced);
        expect(yield* h.eventTypes).toEqual(["machine.online"]);
      }),
    ));
});

describe("NodeLinkServer heartbeat", () => {
  it("marks a machine offline once after 45 s of silence, detaches it, and announces it again on reconnect", () =>
    runTest(
      Effect.gen(function* () {
        const h = yield* harness();
        const id = identity();
        yield* h.enroll(id.pubKey);

        const link = yield* connect(h.server);
        yield* link.node.send(hello(id, link.nonce));
        expect((yield* link.node.next).t).toBe("welcome");

        yield* TestClock.adjust("15 seconds");
        expect((yield* link.node.next).t).toBe("hb");
        yield* TestClock.adjust("15 seconds");
        expect((yield* link.node.next).t).toBe("hb");
        yield* link.node.send({ t: "hb", at: "2026-10-17T10:00:30.000Z" });
        yield* Effect.yieldNow;
        // 44 s after the node's last frame: still online.
        yield* TestClock.adjust("44 seconds");
        expect(yield* h.eventTypes).toEqual(["machine.online"]);
        expect(yield* h.status).toBe("online");
        expect(h.detached).toEqual([]);

        yield* TestClock.adjust("1 second");
        expect((yield* link.node.closed).code).toBe(NodeLinkClose.heartbeatTimeout);
        expect(yield* h.eventTypes).toEqual(["machine.online", "machine.offline"]);
        expect(yield* h.status).toBe("offline");
        expect(h.detached).toEqual(["lab-a"]);

        yield* TestClock.adjust("5 minutes");
        expect(yield* h.eventTypes).toEqual(["machine.online", "machine.offline"]);

        const again = yield* connect(h.server);
        yield* again.node.send(hello(id, again.nonce));
        expect((yield* again.node.next).t).toBe("welcome");
        expect(yield* h.eventTypes).toEqual(["machine.online", "machine.offline", "machine.online"]);
        expect(yield* h.status).toBe("online");
      }),
    ));

  it("goes offline 45 s after a dropped socket unless the node reconnects first", () =>
    runTest(
      Effect.gen(function* () {
        const h = yield* harness();
        const id = identity();
        yield* h.enroll(id.pubKey);

        const link = yield* connect(h.server);
        yield* link.node.send(hello(id, link.nonce));
        expect((yield* link.node.next).t).toBe("welcome");
        yield* link.node.drop;
        yield* Fiber.join(link.fiber);
        yield* TestClock.adjust("45 seconds");
        expect(yield* h.eventTypes).toEqual(["machine.online", "machine.offline"]);
        expect(h.detached).toEqual(["lab-a"]);
      }),
    ));
});

describe("NodeLinkServer logs", () => {
  it("never logs a bearer or an enroll token, even when attaching fails with one in its error", () =>
    runTest(
      Effect.gen(function* () {
        logs.length = 0;
        const h = yield* harness({ attachFails: true });
        const id = identity();
        const token = yield* h.createToken;

        const link = yield* connect(h.server);
        yield* link.node.send(hello(id, link.nonce, { enrollToken: token }));
        expect((yield* link.node.next).t).toBe("welcome");
        yield* link.node.send({ t: "t3session", bearer: BEARER, expiresAt: "2026-10-17T11:00:00.000Z" });
        yield* link.node.send({ t: "nonsense", bearer: BEARER });
        expect((yield* link.node.closed).code).toBe(NodeLinkClose.badFrame);
        yield* TestClock.adjust("45 seconds");

        expect(logs.some((line) => line.includes("attach executor failed"))).toBe(true);
        expect(logs.some((line) => line.includes("machine offline"))).toBe(true);
        for (const line of logs) {
          expect(line).not.toContain(BEARER);
          expect(line).not.toContain(token);
        }
      }),
    ));
});

describe("NodeLinkServer T3 state", () => {
  const session = (bearer: string) => ({ t: "t3session", bearer, expiresAt: "2026-10-17T11:00:00.000Z" });
  const t3state = (state: string, extra: Record<string, unknown> = {}) => ({ t: "t3state", state, at: "2026-10-17T10:00:00.000Z", ...extra });
  const T3 = { url: "http://127.0.0.1:4712", version: "2fbd4318fc", protocol: 2 };

  it("degrades a machine whose T3 goes down, detaches it, and brings it back online with the new session", () =>
    runTest(
      Effect.gen(function* () {
        const h = yield* harness();
        const id = identity();
        yield* h.enroll(id.pubKey);
        const link = yield* connect(h.server);
        yield* link.node.send(hello(id, link.nonce));
        expect((yield* link.node.next).t).toBe("welcome");
        yield* link.node.send(session("bearer-1"));

        const reason = "T3 failed 3 health checks in a row (connect ECONNREFUSED 127.0.0.1:4711)";
        yield* link.node.send(t3state("down", { reason }));
        yield* link.node.send(t3state("restarting", { reason }));
        yield* link.node.send({ t: "hb", at: "2026-10-17T10:00:15.000Z" });
        // Not attached while T3 is down, even with a fresh session.
        yield* link.node.send(session("bearer-2"));
        yield* link.node.send({ t: "hb", at: "2026-10-17T10:00:16.000Z" });
        yield* TestClock.adjust("1 second");
        expect(yield* h.machine).toMatchObject({ status: "degraded", degradedReason: reason });
        expect(h.detached).toEqual(["lab-a", "lab-a"]);
        expect(h.attached.map((a) => a.bearer)).toEqual(["bearer-1"]);
        const degraded = (yield* h.events).at(-1);
        expect(degraded).toMatchObject({ type: "machine.degraded", machineId: "lab-a", data: { degradedReason: reason } });
        expect(yield* h.eventTypes).toEqual(["machine.online", "machine.degraded"]);

        yield* link.node.send(t3state("up", { t3: { ...T3, version: "next" } }));
        yield* link.node.send(session("bearer-3"));
        yield* link.node.send({ t: "hb", at: "2026-10-17T10:00:20.000Z" });
        yield* TestClock.adjust("1 second");
        const machine = yield* h.machine;
        expect(machine).toMatchObject({ status: "online", t3: { version: "next", protocol: 2 } });
        expect(machine?.degradedReason).toBeUndefined();
        expect(yield* h.eventTypes).toEqual(["machine.online", "machine.degraded", "machine.online"]);
        // The kept session reattaches at once; the re-minted one replaces it.
        expect(h.attached.map((a) => `${a.t3Url} ${a.bearer}`)).toEqual([
          "http://127.0.0.1:4711 bearer-1",
          "http://127.0.0.1:4712 bearer-2",
          "http://127.0.0.1:4712 bearer-3",
        ]);
      }),
    ));

  it("shows a node whose T3 was down at start as degraded, and attaches once T3 is up", () =>
    runTest(
      Effect.gen(function* () {
        const h = yield* harness();
        const id = identity();
        yield* h.enroll(id.pubKey);
        const link = yield* connect(h.server);
        const { t3: _t3, ...withoutT3 } = hello(id, link.nonce);
        yield* link.node.send(withoutT3);
        expect((yield* link.node.next).t).toBe("welcome");
        expect(yield* h.machine).toMatchObject({ status: "degraded", degradedReason: "its node cannot reach T3", t3: null });
        expect(yield* h.eventTypes).toEqual(["machine.degraded"]);

        yield* link.node.send(t3state("down", { reason: "T3 at http://127.0.0.1:4712 is not reachable (connect ECONNREFUSED)" }));
        yield* link.node.send(t3state("up", { t3: T3 }));
        yield* link.node.send(session("bearer-1"));
        yield* link.node.send({ t: "hb", at: "2026-10-17T10:00:15.000Z" });
        yield* TestClock.adjust("1 second");
        expect(yield* h.machine).toMatchObject({ status: "online", t3: { version: "2fbd4318fc", protocol: 2 } });
        expect(yield* h.eventTypes).toEqual(["machine.degraded", "machine.online"]);
        expect(h.attached).toEqual([{ machineId: "lab-a", t3Url: T3.url, bearer: "bearer-1" }]);

        // A degraded machine whose node goes silent still goes offline after 45 s, and only then.
        yield* link.node.send(t3state("down", { reason: "gone" }));
        yield* TestClock.adjust("44 seconds");
        expect(yield* h.status).toBe("degraded");
        yield* TestClock.adjust("1 second");
        expect(yield* h.status).toBe("offline");
        expect((yield* h.machine)?.degradedReason).toBeUndefined();
        expect(yield* h.eventTypes).toEqual(["machine.degraded", "machine.online", "machine.degraded", "machine.offline"]);
      }),
    ));
});
