import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MachineId } from "@fleetd/contracts";
import * as Auth from "@fleetd/hub/auth/Auth.ts";
import * as NodeLinkServer from "@fleetd/hub/link/NodeLinkServer.ts";
import * as EventLog from "@fleetd/hub/store/EventLog.ts";
import * as HubDb from "@fleetd/hub/store/HubDb.ts";
import * as HubStore from "@fleetd/hub/store/HubStore.ts";
import { loadOrCreateIdentity } from "@fleetd/node/identity.ts";
import { runNode } from "@fleetd/node/link.ts";
import { T3Sessions } from "@fleetd/node/T3Sessions.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { afterAll, describe, expect, it } from "vitest";

const nodeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-link-"));
afterAll(() => fs.rmSync(nodeHome, { recursive: true, force: true }));

const closed = (code: number) => new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) });

/** A connected pair of in-memory sockets; a close frame from either side ends both directions. */
const socketPair = Effect.gen(function* () {
  const toHub = yield* Queue.unbounded<string, Socket.SocketError>();
  const toNode = yield* Queue.unbounded<string, Socket.SocketError>();
  const end = (inbox: typeof toHub, outbox: typeof toHub) =>
    Socket.make({
      reader: Effect.succeed({ pull: Effect.map(Queue.take(inbox), (frame) => [frame] as const), upgrade: () => Effect.void }),
      writer: Effect.succeed({
        write: (chunk) =>
          Socket.isCloseEvent(chunk)
            ? Effect.all([Queue.fail(outbox, closed(chunk.code)), Queue.fail(inbox, closed(chunk.code))]).pipe(Effect.asVoid)
            : Queue.offer(outbox, String(chunk)).pipe(Effect.asVoid),
        writeAll: (chunks) => Queue.offerAll(outbox, chunks.map(String)).pipe(Effect.asVoid),
      }),
    });
  return { hub: end(toHub, toNode), node: end(toNode, toHub) };
});

describe("node and hub link", () => {
  it("a joining node enrolls, hands the hub its T3 session, and goes offline 45 s after it stops", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const lab = MachineId.make("lab-a");
        const auth = yield* Auth.Auth;
        const eventLog = yield* EventLog.EventLog;
        const attached = yield* Deferred.make<{ machineId: string; t3Url: string; bearer: string }>();
        const detached: Array<string> = [];
        const server = yield* NodeLinkServer.make({
          hubId: "hub",
          executors: {
            attach: (machineId, session) => Deferred.succeed(attached, { machineId, ...session }),
            detach: (machineId) => Effect.sync(() => detached.push(machineId)),
          },
        });
        const { token } = yield* auth.createEnrollToken(lab);

        const node = yield* runNode({
          settings: { machineId: lab, name: "Lab A", tags: [], nodeVersion: "0.0.0", t3Url: "http://127.0.0.1:4711" },
          identity: loadOrCreateIdentity(nodeHome),
          dial: Effect.gen(function* () {
            const pair = yield* socketPair;
            yield* Effect.forkDetach(server.handle(pair.hub));
            return pair.node;
          }),
          t3Info: Effect.succeed({ version: "0.1.0", protocol: 2 }),
          enrollToken: token,
        }).pipe(
          Effect.provide(
            Layer.succeed(T3Sessions)({
              mint: Effect.succeed({ sessionId: "s-1", bearer: Redacted.make("bearer-1"), expiresAt: "later" }),
              revoke: () => Effect.void,
            }),
          ),
          Effect.scoped,
          Effect.forkScoped,
        );

        expect(yield* Deferred.await(attached)).toEqual({ machineId: "lab-a", t3Url: "http://127.0.0.1:4711", bearer: "bearer-1" });
        expect(yield* auth.nodePubKey(lab)).toBe(loadOrCreateIdentity(nodeHome).pubKey);

        // Heartbeats keep it online across several silence windows.
        for (let i = 0; i < 8; i++) yield* TestClock.adjust("15 seconds");
        const types = () => Effect.map(eventLog.wait({ cursor: 0, timeoutSec: 0 }), ({ events }) => events.map((e) => e.type));
        expect(yield* types()).toEqual(["machine.online"]);

        yield* Fiber.interrupt(node);
        yield* TestClock.adjust("45 seconds");
        expect(yield* types()).toEqual(["machine.online", "machine.offline"]);
        expect(detached).toEqual(["lab-a"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(HubStore.layer, EventLog.layer, Auth.layer).pipe(Layer.provideMerge(HubDb.layerMemory))),
        Effect.provide(TestClock.layer()),
        Effect.provide(Logger.layer([])),
      ),
    ));
});
