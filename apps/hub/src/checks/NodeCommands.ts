// Commands the hub runs on a machine through its node: a `cmd_check` frame out, the matching `cmd_result` back.
// `cmd` checks use it now; the merge train reuses it for git operations, hence timeouts up to 30 minutes.
import { randomUUID } from "node:crypto";
import type { CmdCheck, CmdResult, MachineId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 1800;
/** How long past the command's own timeout the hub waits for the node's answer. */
const REPLY_GRACE = Duration.seconds(30);

export interface CommandInput {
  /** Absolute, on the machine. The node refuses directories outside its command roots. */
  readonly cwd: string;
  /** Run as given, never through a shell. */
  readonly argv: ReadonlyArray<string>;
  /** Default 120, at most 1800. */
  readonly timeoutSec?: number;
}

export type CommandOutcome = Omit<CmdResult, "t" | "id">;

export class NodeCommandError extends Data.TaggedError("NodeCommandError")<{
  readonly machineId: MachineId;
  readonly reason: "offline" | "lost" | "no_reply" | "invalid";
  readonly message: string;
}> {}

export class NodeCommands extends Context.Service<
  NodeCommands,
  {
    readonly run: (machineId: MachineId, input: CommandInput) => Effect.Effect<CommandOutcome, NodeCommandError>;
    /** The node link registers each welcomed link here; commands in flight on it fail when the scope closes. */
    readonly attach: (machineId: MachineId, send: (frame: CmdCheck) => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
    /** The node link hands over each `cmd_result` frame. */
    readonly resolve: (machineId: MachineId, frame: CmdResult) => Effect.Effect<void>;
  }
>()("fleetd/checks/NodeCommands") {}

interface Pending {
  readonly machineId: MachineId;
  readonly linkId: number;
  readonly done: Deferred.Deferred<CommandOutcome, NodeCommandError>;
}

export const make = Effect.sync(() => {
  const links = new Map<MachineId, { readonly id: number; readonly send: (frame: CmdCheck) => Effect.Effect<void> }>();
  const pending = new Map<string, Pending>();
  let nextLinkId = 0;

  const attach: NodeCommands["Service"]["attach"] = (machineId, send) =>
    Effect.gen(function* () {
      const id = ++nextLinkId;
      links.set(machineId, { id, send });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (links.get(machineId)?.id === id) links.delete(machineId);
          for (const [commandId, p] of pending) {
            if (p.linkId !== id) continue;
            pending.delete(commandId);
            yield* Deferred.fail(
              p.done,
              new NodeCommandError({ machineId, reason: "lost", message: `the link to ${machineId}'s node dropped while the command ran` }),
            );
          }
        }),
      );
    });

  const resolve: NodeCommands["Service"]["resolve"] = (machineId, frame) =>
    Effect.suspend(() => {
      const p = pending.get(frame.id);
      // Only the machine it was sent to may answer it.
      if (p === undefined || p.machineId !== machineId) return Effect.void;
      pending.delete(frame.id);
      return Deferred.succeed(p.done, { exitCode: frame.exitCode, outputTail: frame.outputTail, timedOut: frame.timedOut }).pipe(Effect.asVoid);
    });

  const run: NodeCommands["Service"]["run"] = (machineId, input) =>
    Effect.gen(function* () {
      const timeoutSec = input.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      const invalid = (message: string) => new NodeCommandError({ machineId, reason: "invalid", message });
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) {
        return yield* invalid(`timeout must be 1-${MAX_TIMEOUT_SEC} s, got ${timeoutSec}`);
      }
      if (!input.cwd.startsWith("/")) return yield* invalid(`cwd must be absolute, got ${input.cwd}`);
      if (input.argv.length === 0 || input.argv.length > 64) return yield* invalid("argv must have 1-64 entries");
      const link = links.get(machineId);
      if (link === undefined) {
        return yield* new NodeCommandError({ machineId, reason: "offline", message: `${machineId}'s node is not linked to the hub` });
      }
      const id = randomUUID();
      const done = yield* Deferred.make<CommandOutcome, NodeCommandError>();
      pending.set(id, { machineId, linkId: link.id, done });
      const outcome = yield* link.send({ t: "cmd_check", id, cwd: input.cwd, argv: input.argv, timeoutSec }).pipe(
        Effect.andThen(Deferred.await(done)),
        Effect.timeoutOption(Duration.sum(Duration.seconds(timeoutSec), REPLY_GRACE)),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
      if (outcome._tag === "None") {
        return yield* new NodeCommandError({
          machineId,
          reason: "no_reply",
          message: `${machineId}'s node did not answer within ${timeoutSec + Duration.toSeconds(REPLY_GRACE)} s`,
        });
      }
      return outcome.value;
    });

  return NodeCommands.of({ run, attach, resolve });
});

export const layer = Layer.effect(NodeCommands, make);
