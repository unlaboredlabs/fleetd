import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { LeadCallFrame, LeadResultFrame } from "@fleetd/contracts";
import { Cause, Effect, Exit, Fiber, Logger, Queue, Scope } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, describe, expect, it } from "vitest";
import { HUB_UNREACHABLE, makeLeadRelay, serveLeadSocket } from "./LeadCalls.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-sock-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let sockets = 0;
const freshSocketPath = () => path.join(dir, `n${++sockets}`, "node.sock");

const statusCall = (id = "cli-1"): LeadCallFrame => ({
  t: "lead_call",
  id,
  cwd: "/src/api",
  call: { op: "status_set", text: "half done", workstreamId: "W3" as never },
});
const statusResult = (id: string): LeadResultFrame => ({ t: "lead_result", id, result: { op: "status_set", workstreamId: "W3" as never } });

/** Writes `chunks` to the socket, then resolves with everything the node sent back before closing. */
const exchange = (socketPath: string, chunks: ReadonlyArray<string>, halfClose = false) =>
  new Promise<string>((resolve, reject) => {
    const conn = net.connect(socketPath);
    let received = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => (received += chunk));
    conn.on("end", () => resolve(received));
    conn.on("error", reject);
    conn.on("connect", () => {
      for (const chunk of chunks) conn.write(chunk);
      if (halfClose) conn.end();
    });
  });

const runLive = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(Logger.layer([]))));

const runTest = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))));

describe("lead socket", () => {
  it("answers one JSON line with one JSON line, even when the frame arrives in pieces, and is mode 0600", () =>
    runLive(
      Effect.gen(function* () {
        const socketPath = freshSocketPath();
        const seen: Array<LeadCallFrame> = [];
        yield* serveLeadSocket(socketPath, (frame) => Effect.sync(() => (seen.push(frame), statusResult(frame.id))));
        expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);

        const line = JSON.stringify(statusCall());
        const out = yield* Effect.promise(() => exchange(socketPath, [line.slice(0, 10), line.slice(10), "\n"]));
        expect(out).toBe(`${JSON.stringify(statusResult("cli-1"))}\n`);
        expect(seen).toEqual([statusCall()]);

        // A CLI that half-closes without a newline is still answered.
        const halfClosed = yield* Effect.promise(() => exchange(socketPath, [JSON.stringify(statusCall("cli-2"))], true));
        expect(JSON.parse(halfClosed)).toEqual(statusResult("cli-2"));
      }),
    ));

  it("answers a frame that does not decode with an invalid error and never forwards it", () =>
    runLive(
      Effect.gen(function* () {
        const socketPath = freshSocketPath();
        let calls = 0;
        yield* serveLeadSocket(socketPath, (frame) => Effect.sync(() => (calls++, statusResult(frame.id))));
        for (const bad of ["not json", JSON.stringify({ ...statusCall(), cwd: "relative/dir" }), JSON.stringify({ t: "hb" })]) {
          const reply = JSON.parse(yield* Effect.promise(() => exchange(socketPath, [`${bad}\n`])));
          expect(reply).toMatchObject({ t: "lead_result", id: "invalid", error: { code: "invalid" } });
          expect(reply.error.message).toMatch(/^not a lead_call frame/);
        }
        expect(calls).toBe(0);
      }),
    ));

  it("replaces a socket a dead node left behind, refuses to take over a live one, and removes its own on stop", () =>
    runLive(
      Effect.gen(function* () {
        const socketPath = freshSocketPath();
        fs.mkdirSync(path.dirname(socketPath), { recursive: true });
        // A node that died without cleaning up: SIGKILL right after listening leaves the socket file.
        spawnSync(process.execPath, [
          "-e",
          `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, "SIGKILL"))`,
        ]);
        expect(fs.lstatSync(socketPath).isSocket()).toBe(true);

        const scope = yield* Scope.make();
        yield* serveLeadSocket(socketPath, (frame) => Effect.succeed(statusResult(frame.id))).pipe(Scope.provide(scope));
        expect(JSON.parse(yield* Effect.promise(() => exchange(socketPath, [`${JSON.stringify(statusCall())}\n`]))).id).toBe("cli-1");

        const second = yield* serveLeadSocket(socketPath, (frame) => Effect.succeed(statusResult(frame.id))).pipe(Effect.exit);
        expect(Exit.isFailure(second) && Cause.squash(second.cause)).toMatchObject({
          _tag: "LeadSocketError",
          message: `another fleetd node is already serving ${socketPath}; stop it first`,
        });

        yield* Scope.close(scope, Exit.void);
        expect(fs.existsSync(socketPath)).toBe(false);
      }),
    ));
});

describe("lead relay", () => {
  it("waits 5 s for a link, then says plainly that the hub is unreachable", () =>
    runTest(
      Effect.gen(function* () {
        const relay = yield* makeLeadRelay();
        const fiber = yield* Effect.forkChild(relay.call(statusCall()));
        yield* TestClock.adjust("5 seconds");
        expect(yield* Fiber.join(fiber)).toEqual({
          t: "lead_result",
          id: "cli-1",
          error: { code: "machine_offline", message: HUB_UNREACHABLE },
        });
      }),
    ));

  it("forwards under its own id, maps the answer back, and fails calls still waiting when the link drops", () =>
    runTest(
      Effect.gen(function* () {
        const relay = yield* makeLeadRelay();
        const toHub = yield* Queue.unbounded<LeadCallFrame>();
        const link = yield* Scope.make();
        yield* relay.attach((frame) => Queue.offer(toHub, frame)).pipe(Scope.provide(link));

        // Two CLIs that happen to pick the same id.
        const first = yield* Effect.forkChild(relay.call(statusCall("same")));
        const second = yield* Effect.forkChild(relay.call(statusCall("same")));
        const a = yield* Queue.take(toHub);
        const b = yield* Queue.take(toHub);
        expect(a).toEqual({ ...statusCall(), id: "lc-1" });
        expect(b.id).toBe("lc-2");
        yield* relay.resolve(statusResult("lc-1"));
        expect(yield* Fiber.join(first)).toEqual(statusResult("same"));

        yield* Scope.close(link, Exit.void);
        expect(yield* Fiber.join(second)).toMatchObject({
          id: "same",
          error: { code: "machine_offline", message: "the link to the fleetd hub dropped before it answered; the call may or may not have gone through" },
        });
      }),
    ));

  it("gives up on a hub that does not answer within 30 s", () =>
    runTest(
      Effect.gen(function* () {
        const relay = yield* makeLeadRelay();
        yield* relay.attach(() => Effect.void);
        const fiber = yield* Effect.forkChild(relay.call(statusCall()));
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(fiber)).toMatchObject({
          id: "cli-1",
          error: { code: "machine_offline", message: "the fleetd hub did not answer within 30 s; the call may or may not have gone through" },
        });
      }),
    ));
});
