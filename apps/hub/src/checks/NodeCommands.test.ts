import type { CmdCheck, MachineId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as NodeCommands from "./NodeCommands.ts";

const LAB_A = "lab-a" as MachineId;
const LAB_B = "lab-b" as MachineId;

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestClock.layer())));

/** A node link for `machineId` whose sent frames land in the returned queue. */
const link = (commands: NodeCommands.NodeCommands["Service"], machineId: MachineId) =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<CmdCheck>();
    const scope = yield* Scope.make();
    yield* commands.attach(machineId, (frame) => Queue.offer(sent, frame).pipe(Effect.asVoid)).pipe(Scope.provide(scope));
    return { sent, drop: Scope.close(scope, Exit.void) };
  });

describe("NodeCommands", () => {
  it("sends a cmd_check with the 120 s default and returns the node's matching result", () =>
    run(
      Effect.gen(function* () {
        const commands = yield* NodeCommands.make;
        const a = yield* link(commands, LAB_A);
        const fiber = yield* Effect.forkChild(commands.run(LAB_A, { cwd: "/w/p1", argv: ["test", "-f", "README.md"] }));
        const frame = yield* Queue.take(a.sent);
        expect(frame).toMatchObject({ t: "cmd_check", cwd: "/w/p1", argv: ["test", "-f", "README.md"], timeoutSec: 120 });
        // Another machine cannot answer it, and unknown ids are dropped.
        yield* commands.resolve(LAB_B, { t: "cmd_result", id: frame.id, exitCode: 9, outputTail: "", timedOut: false });
        yield* commands.resolve(LAB_A, { t: "cmd_result", id: "other", exitCode: 9, outputTail: "", timedOut: false });
        yield* commands.resolve(LAB_A, { t: "cmd_result", id: frame.id, exitCode: 0, outputTail: "ok", timedOut: false });
        expect(yield* Fiber.join(fiber)).toEqual({ exitCode: 0, outputTail: "ok", timedOut: false });
      }),
    ));

  it("fails offline without a link, lost when the link drops mid-run, and no_reply past the timeout plus grace", () =>
    run(
      Effect.gen(function* () {
        const commands = yield* NodeCommands.make;
        expect(yield* Effect.flip(commands.run(LAB_A, { cwd: "/w", argv: ["true"] }))).toMatchObject({ reason: "offline" });

        const a = yield* link(commands, LAB_A);
        const lost = yield* Effect.forkChild(commands.run(LAB_A, { cwd: "/w", argv: ["sleep", "5"] }));
        yield* Queue.take(a.sent);
        yield* a.drop;
        expect(yield* Effect.flip(Fiber.join(lost))).toMatchObject({ reason: "lost" });

        const b = yield* link(commands, LAB_B);
        const silent = yield* Effect.forkChild(commands.run(LAB_B, { cwd: "/w", argv: ["git", "fetch"], timeoutSec: 1800 }));
        expect((yield* Queue.take(b.sent)).timeoutSec).toBe(1800);
        yield* TestClock.adjust("1830 seconds");
        expect(yield* Effect.flip(Fiber.join(silent))).toMatchObject({ reason: "no_reply", message: "lab-b's node did not answer within 1830 s" });
      }),
    ));

  it("refuses timeouts over 30 minutes and relative directories", () =>
    run(
      Effect.gen(function* () {
        const commands = yield* NodeCommands.make;
        yield* link(commands, LAB_A);
        expect(yield* Effect.flip(commands.run(LAB_A, { cwd: "/w", argv: ["true"], timeoutSec: 1801 }))).toMatchObject({ reason: "invalid" });
        expect(yield* Effect.flip(commands.run(LAB_A, { cwd: "w", argv: ["true"] }))).toMatchObject({ reason: "invalid" });
      }),
    ));
});
