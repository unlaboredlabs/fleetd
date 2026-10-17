import { createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MachineId, NodeLinkClose, type NodeToHub, PROTOCOL_VERSION } from "@fleetd/contracts";
import { Cause, Effect, Exit, Fiber, Layer, Logger, Queue, Redacted, References, type Scope } from "effect";
import * as Socket from "effect/socket/Socket";
import { TestClock } from "effect/testing";
import { afterAll, describe, expect, it } from "vitest";
import { loadOrCreateIdentity } from "./identity.ts";
import { makeLeadRelay } from "./LeadCalls.ts";
import { type RunNodeOptions, runNode, T3Unreachable } from "./link.ts";
import { T3Sessions } from "./T3Sessions.ts";

const BEARER = "t3-bearer-secret-0123456789abcdef";
const ENROLL = "fle_enrollsecretxyz";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-node-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
const identity = loadOrCreateIdentity(home);

const closeError = (code: number, closeReason?: string) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason }) });

/** The hub's end of one in-memory link the node dialed. */
const dialer = Effect.gen(function* () {
  const dials = yield* Queue.unbounded<{
    readonly send: (frame: unknown) => Effect.Effect<void>;
    readonly next: Effect.Effect<NodeToHub, Socket.SocketError>;
    readonly close: (code: number, reason: string) => Effect.Effect<void>;
  }>();
  const dial = Effect.gen(function* () {
    const toNode = yield* Queue.unbounded<string, Socket.SocketError>();
    const toHub = yield* Queue.unbounded<string, Socket.SocketError>();
    yield* Queue.offer(dials, {
      send: (frame) => Queue.offer(toNode, JSON.stringify(frame)).pipe(Effect.asVoid),
      next: Effect.map(Queue.take(toHub), (raw) => JSON.parse(raw) as NodeToHub),
      close: (code, reason) => Queue.fail(toNode, closeError(code, reason)).pipe(Effect.asVoid),
    });
    return Socket.make({
      reader: Effect.succeed({ pull: Effect.map(Queue.take(toNode), (frame) => [frame] as const), upgrade: () => Effect.void }),
      writer: Effect.succeed({
        write: (chunk) => (Socket.isCloseEvent(chunk) ? Effect.void : Queue.offer(toHub, String(chunk)).pipe(Effect.asVoid)),
        writeAll: (chunks) => Queue.offerAll(toHub, chunks.map(String)).pipe(Effect.asVoid),
      }),
    });
  });
  return { dials, dial };
});

const t3Sessions = Layer.succeed(T3Sessions)({
  mint: Effect.succeed({ sessionId: "s-1", bearer: Redacted.make(BEARER), expiresAt: "2026-10-17T11:00:00.000Z" }),
  revoke: () => Effect.void,
});

const logs: Array<string> = [];
const captureLogs = Logger.make(({ message, cause, fiber }) => {
  logs.push(JSON.stringify({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) }) + Cause.pretty(cause));
});

const runTest = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([captureLogs])),
      Effect.provideService(References.MinimumLogLevel, "All"),
    ),
  );

const startNode = (
  options: Partial<Pick<RunNodeOptions, "enrollToken" | "onEnrolled" | "t3Info" | "t3Restart" | "leadCalls">> & {
    readonly t3Sessions?: Layer.Layer<T3Sessions>;
  } = {},
) =>
  Effect.gen(function* () {
    const { dials, dial } = yield* dialer;
    const { t3Sessions: sessions = t3Sessions, ...rest } = options;
    const node = yield* runNode({
      settings: {
        machineId: MachineId.make("lab-a"),
        name: "Lab A",
        tags: ["linux"],
        nodeVersion: "0.0.0",
        t3Url: "http://127.0.0.1:4711",
      },
      identity,
      dial,
      t3Info: Effect.succeed({ version: "2fbd4318fc", protocol: 2 }),
      ...rest,
    }).pipe(Effect.provide(sessions), Effect.forkScoped);
    return { dials, node };
  });

const nonceSigned = (pubKey: string, nonce: string, sig: string) =>
  verify(
    null,
    Buffer.from(nonce, "utf8"),
    createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pubKey, "base64").toString("base64url") }, format: "jwk" }),
    Buffer.from(sig, "base64"),
  );

const welcome = { t: "welcome", hubId: "hub", protocol: PROTOCOL_VERSION };

describe("node link", () => {
  it("enrolls with a signed hello, sends its T3 session and heartbeats, and reconnects without the token", () =>
    runTest(
      Effect.gen(function* () {
        logs.length = 0;
        let enrolled = 0;
        const { dials } = yield* startNode({ enrollToken: ENROLL, onEnrolled: Effect.sync(() => enrolled++) });

        const first = yield* Queue.take(dials);
        yield* first.send({ t: "challenge", nonce: "nonce-1" });
        const hello = yield* first.next;
        if (hello.t !== "hello") throw new Error(hello.t);
        expect(hello).toMatchObject({ machineId: "lab-a", protocol: PROTOCOL_VERSION, enrollToken: ENROLL, pubKey: identity.pubKey });
        expect(hello.t3).toEqual({ url: "http://127.0.0.1:4711", version: "2fbd4318fc", protocol: 2 });
        expect(nonceSigned(hello.pubKey, "nonce-1", hello.sig)).toBe(true);
        expect(nonceSigned(hello.pubKey, "nonce-2", hello.sig)).toBe(false);

        yield* first.send(welcome);
        expect(yield* first.next).toEqual({ t: "t3session", bearer: BEARER, expiresAt: "2026-10-17T11:00:00.000Z" });
        expect(enrolled).toBe(1);
        yield* TestClock.adjust("15 seconds");
        expect((yield* first.next).t).toBe("hb");

        yield* first.close(1006, "gone");
        yield* TestClock.adjust("2 seconds");
        const second = yield* Queue.take(dials);
        yield* second.send({ t: "challenge", nonce: "nonce-2" });
        const again = yield* second.next;
        expect(again.t === "hello" && again.enrollToken).toBe(undefined);
        yield* second.send(welcome);
        expect(yield* second.next).toMatchObject({ t: "t3session", bearer: BEARER });
        expect(enrolled).toBe(1);

        for (const line of logs) {
          expect(line).not.toContain(BEARER);
          expect(line).not.toContain(ENROLL);
        }
      }),
    ));

  it("drops a link when the hub is silent for 45 s, and redials", () =>
    runTest(
      Effect.gen(function* () {
        const { dials } = yield* startNode();
        const first = yield* Queue.take(dials);
        yield* first.send({ t: "challenge", nonce: "n" });
        yield* first.next;
        yield* first.send(welcome);
        yield* first.next;

        yield* TestClock.adjust("30 seconds");
        yield* first.send({ t: "hb", at: "2026-10-17T10:00:30.000Z" });
        yield* TestClock.adjust("44 seconds");
        expect(yield* Queue.size(dials)).toBe(0);
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("2 seconds");
        expect(yield* Queue.size(dials)).toBe(1);
      }),
    ));

  it("backs off between failed dials, doubling up to 30 s", () =>
    runTest(
      Effect.gen(function* () {
        const { dials } = yield* startNode();
        // Each attempt sees no challenge and gives up after the 10 s handshake timeout.
        const gaps: Array<number> = [];
        yield* Queue.take(dials);
        for (let attempt = 0; attempt < 7; attempt++) {
          let waited = 10;
          yield* TestClock.adjust("10 seconds");
          while ((yield* Queue.size(dials)) === 0) {
            yield* TestClock.adjust("1 second");
            waited++;
          }
          yield* Queue.take(dials);
          gaps.push(waited - 10);
        }
        // 1, 2, 4, 8, 16, 30, 30 s, each ±20% and rounded up to whole seconds here.
        const expected = [1, 2, 4, 8, 16, 30, 30];
        gaps.forEach((gap, i) => {
          expect(gap).toBeGreaterThanOrEqual(Math.floor(expected[i]! * 0.8));
          expect(gap).toBeLessThanOrEqual(Math.ceil(expected[i]! * 1.2));
        });
      }),
    ));

  it("stops for good when the hub refuses the node or speaks another protocol", () =>
    runTest(
      Effect.gen(function* () {
        const refused = yield* startNode({ enrollToken: ENROLL });
        const link = yield* Queue.take(refused.dials);
        yield* link.send({ t: "challenge", nonce: "n" });
        yield* link.next;
        yield* link.close(NodeLinkClose.unauthorized, "enrollment token expired: run fleetd hub token create --machine lab-a");
        const exit = yield* Fiber.await(refused.node);
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          _tag: "LinkFatal",
          message: "hub refused this node: enrollment token expired: run fleetd hub token create --machine lab-a",
        });
        yield* TestClock.adjust("5 minutes");
        expect(yield* Queue.size(refused.dials)).toBe(0);

        const newer = yield* startNode();
        const other = yield* Queue.take(newer.dials);
        yield* other.send({ t: "challenge", nonce: "n" });
        yield* other.next;
        yield* other.send({ ...welcome, protocol: PROTOCOL_VERSION + 1 });
        const mismatch = yield* Fiber.await(newer.node);
        expect(Exit.isFailure(mismatch) && Cause.squash(mismatch.cause)).toMatchObject({
          _tag: "LinkFatal",
          code: NodeLinkClose.protocolMismatch,
        });
      }),
    ));

  it("links while T3 is down, says why, then reports T3 up with a fresh session after the node restarts it", () =>
    runTest(
      Effect.gen(function* () {
        let t3Up = false;
        let mints = 0;
        let restarts = 0;
        const { dials } = yield* startNode({
          t3Info: Effect.suspend(() =>
            t3Up
              ? Effect.succeed({ version: "2fbd4318fc", protocol: 2 })
              : Effect.fail(new T3Unreachable({ url: "http://127.0.0.1:4711", cause: new Error("connect ECONNREFUSED") })),
          ),
          t3Restart: Effect.sync(() => {
            restarts++;
            t3Up = true;
          }),
          t3Sessions: Layer.succeed(T3Sessions)({
            mint: Effect.sync(() => ({ sessionId: `s-${++mints}`, bearer: Redacted.make(`bearer-${mints}`), expiresAt: "later" })),
            revoke: () => Effect.void,
          }),
        });

        const link = yield* Queue.take(dials);
        yield* link.send({ t: "challenge", nonce: "n" });
        const hello = yield* link.next;
        expect(hello.t === "hello" && hello.t3).toBe(undefined);
        yield* link.send(welcome);
        expect(yield* link.next).toMatchObject({ t: "t3state", state: "down", reason: "T3 at http://127.0.0.1:4711 is not reachable (connect ECONNREFUSED)" });

        // Third failed probe at 10 s: the node restarts T3, which answers at once.
        yield* TestClock.adjust("10 seconds");
        expect(yield* link.next).toMatchObject({ t: "t3state", state: "down", reason: "T3 failed 3 health checks in a row (connect ECONNREFUSED)" });
        expect(yield* link.next).toMatchObject({ t: "t3state", state: "restarting" });
        expect(yield* link.next).toMatchObject({
          t: "t3state",
          state: "up",
          t3: { url: "http://127.0.0.1:4711", version: "2fbd4318fc", protocol: 2 },
        });
        expect(yield* link.next).toMatchObject({ t: "t3session", bearer: "bearer-1" });
        expect(restarts).toBe(1);

        // It dies again: down after three more probes, and a new session once it is back.
        t3Up = false;
        yield* TestClock.adjust("15 seconds");
        const frames = [yield* link.next, yield* link.next, yield* link.next, yield* link.next];
        expect(frames.map((frame) => (frame.t === "t3state" ? frame.state : frame.t))).toEqual(["hb", "down", "restarting", "up"]);
        expect(yield* link.next).toMatchObject({ t: "t3session", bearer: "bearer-2" });
        expect(mints).toBe(2);
      }),
    ));

  it("relays a lead call once the hub welcomes it, and routes the hub's answer back to the caller", () =>
    runTest(
      Effect.gen(function* () {
        const leadCalls = yield* makeLeadRelay();
        const { dials } = yield* startNode({ leadCalls });
        const call = {
          t: "lead_call",
          id: "cli-7",
          cwd: "/src/api",
          call: { op: "decisions_search", query: "health" },
        } as const;
        // Placed before the link is up: it waits for the welcome rather than failing.
        const pending = yield* Effect.forkChild(leadCalls.call(call));

        const link = yield* Queue.take(dials);
        yield* link.send({ t: "challenge", nonce: "n" });
        yield* link.next;
        yield* link.send(welcome);
        const frames = [yield* link.next, yield* link.next];
        const forwarded = frames.find((frame) => frame.t === "lead_call");
        expect(forwarded).toEqual({ ...call, id: "lc-1" });

        yield* link.send({ t: "lead_result", id: "lc-1", result: { op: "decisions_search", decisions: [], next: "ask it" } });
        expect(yield* Fiber.join(pending)).toEqual({
          t: "lead_result",
          id: "cli-7",
          result: { op: "decisions_search", decisions: [], next: "ask it" },
        });
      }),
    ));
});
