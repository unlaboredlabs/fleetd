import { AskId, DecisionKey, type MachineId } from "@fleetd/contracts";
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
    const sent = yield* Queue.unbounded<NodeCommands.NodeRequest>();
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
        expect(yield* Queue.take(b.sent)).toMatchObject({ timeoutSec: 1800 });
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

  it("relays a sealed secret and an approved command, matching each reply by id and kind", () =>
    run(
      Effect.gen(function* () {
        const commands = yield* NodeCommands.make;
        const a = yield* link(commands, LAB_A);
        const secret = yield* Effect.forkChild(
          commands.deliverSecret(LAB_A, { sink: "env:lab-a:/w/.env", sealed: "c2VhbGVk", secretKey: DecisionKey.make("stripe.test_key") }),
        );
        const deliver = yield* Queue.take(a.sent);
        expect(deliver).toMatchObject({ t: "secret_deliver", sink: "env:lab-a:/w/.env", sealed: "c2VhbGVk", secretKey: "stripe.test_key" });
        // A reply of the wrong kind does not settle it.
        yield* commands.resolve(LAB_A, { t: "gated_result", id: deliver.id, exitCode: 0, outputTail: "", timedOut: false });
        yield* commands.resolve(LAB_A, { t: "secret_result", id: deliver.id, fingerprint: "ab12cd34" });
        expect(yield* Fiber.join(secret)).toEqual({ fingerprint: "ab12cd34" });

        const gated = yield* Effect.forkChild(commands.runGated(LAB_A, { askId: AskId.make("A1"), argv: ["true"], cwd: "/w", timeoutSec: 60 }));
        const frame = yield* Queue.take(a.sent);
        expect(frame).toMatchObject({ t: "gated_run", askId: "A1", argv: ["true"], cwd: "/w", timeoutSec: 60 });
        yield* commands.resolve(LAB_A, { t: "gated_result", id: frame.id, exitCode: 0, outputTail: "ok", timedOut: false });
        expect(yield* Fiber.join(gated)).toEqual({ exitCode: 0, outputTail: "ok", timedOut: false });

        const silent = yield* Effect.forkChild(commands.deliverSecret(LAB_A, { sink: "file:lab-a:/w/k", sealed: "c2VhbGVk", secretKey: DecisionKey.make("a.b") }));
        yield* Queue.take(a.sent);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Effect.flip(Fiber.join(silent))).toMatchObject({ reason: "no_reply" });
      }),
    ));
});
