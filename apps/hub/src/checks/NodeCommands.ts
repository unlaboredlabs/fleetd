// Commands the hub runs on a machine through its node: a `cmd_check` frame out, the matching `cmd_result` back.
// `cmd` checks use it now; the merge train reuses it for git operations, hence timeouts up to 30 minutes. M8 adds
// sealed secrets (`secret_deliver` / `secret_result`) and approved commands (`gated_run` / `gated_result`).
import { randomUUID } from "node:crypto";
import type { CmdCheck, CmdResult, GatedResult, GatedRun, MachineId, NodeAction, NodeActionResult, SecretDeliver, SecretResult } from "@fleetd/contracts";
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
export type SecretOutcome = Omit<SecretResult, "t" | "id">;
export type GatedOutcome = Omit<GatedResult, "t" | "id">;

/** What the hub sends a node and what comes back, matched by id. */
export type NodeRequest = CmdCheck | SecretDeliver | GatedRun | NodeAction;
export type NodeReply = CmdResult | SecretResult | GatedResult | NodeActionResult;
export type ActionOutcome = Omit<NodeActionResult, "t" | "id">;

/** How long the hub waits for a node to write a secret. */
const SECRET_REPLY = Duration.seconds(30);

export class NodeCommandError extends Data.TaggedError("NodeCommandError")<{
  readonly machineId: MachineId;
  readonly reason: "offline" | "lost" | "no_reply" | "invalid";
  readonly message: string;
}> {}

export class NodeCommands extends Context.Service<
  NodeCommands,
  {
    readonly run: (machineId: MachineId, input: CommandInput) => Effect.Effect<CommandOutcome, NodeCommandError>;
    /** Relays a sealed secret to the sink's node; the node answers with the fingerprint or why it could not write it. */
    readonly deliverSecret: (machineId: MachineId, input: Omit<SecretDeliver, "t" | "id">) => Effect.Effect<SecretOutcome, NodeCommandError>;
    /** Runs an approved command on the node, waiting up to its own timeout plus a grace. */
    readonly runGated: (machineId: MachineId, input: Omit<GatedRun, "t" | "id">) => Effect.Effect<GatedOutcome, NodeCommandError>;
    /** The node link registers each welcomed link here; commands in flight on it fail when the scope closes. */
    readonly attach: (machineId: MachineId, send: (frame: NodeRequest) => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>;
    /** The node link hands over each reply frame. */
    readonly resolve: (machineId: MachineId, frame: NodeReply) => Effect.Effect<void>;
  }
>()("fleetd/checks/NodeCommands") {}

/**
 * The doctor's node actions (M11): re-mint the hub's T3 session, restart T3 with the node's own restart command, or
 * probe its commit email and free disk. Sent over the same links as NodeCommands, from the same layer.
 */
export class NodeActions extends Context.Service<
  NodeActions,
  { readonly run: (machineId: MachineId, action: NodeAction["action"]) => Effect.Effect<ActionOutcome, NodeCommandError> }
>()("fleetd/checks/NodeActions") {}

/** Each action's wait: the node caps its restart command at 3 min and its re-mint at 30 s. */
const ACTION_WAIT: Record<NodeAction["action"], Duration.Duration> = {
  probe: Duration.seconds(30),
  remint_session: Duration.seconds(45),
  restart_t3: Duration.seconds(210),
};

interface Pending {
  readonly machineId: MachineId;
  readonly linkId: number;
  /** The reply frame's tag this request expects. */
  readonly reply: NodeReply["t"];
  readonly done: Deferred.Deferred<NodeReply, NodeCommandError>;
}

const REPLY_OF = { cmd_check: "cmd_result", secret_deliver: "secret_result", gated_run: "gated_result", node_action: "node_action_result" } as const;

const makeBoth = Effect.sync(() => {
  const links = new Map<MachineId, { readonly id: number; readonly send: (frame: NodeRequest) => Effect.Effect<void> }>();
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
      // Only the machine it was sent to may answer it, and only with the reply its request expects.
      if (p === undefined || p.machineId !== machineId || p.reply !== frame.t) return Effect.void;
      pending.delete(frame.id);
      return Deferred.succeed(p.done, frame).pipe(Effect.asVoid);
    });

  /** Sends one request over the machine's live link and waits for its reply, at most `wait`. */
  const request = <R extends NodeReply>(machineId: MachineId, frame: (id: string) => NodeRequest, wait: Duration.Duration) =>
    Effect.gen(function* () {
      const link = links.get(machineId);
      if (link === undefined) {
        return yield* new NodeCommandError({ machineId, reason: "offline", message: `${machineId}'s node is not linked to the hub` });
      }
      const id = randomUUID();
      const sent = frame(id);
      const done = yield* Deferred.make<NodeReply, NodeCommandError>();
      pending.set(id, { machineId, linkId: link.id, reply: REPLY_OF[sent.t], done });
      const outcome = yield* link.send(sent).pipe(
        Effect.andThen(Deferred.await(done)),
        Effect.timeoutOption(wait),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
      if (outcome._tag === "None") {
        return yield* new NodeCommandError({
          machineId,
          reason: "no_reply",
          message: `${machineId}'s node did not answer within ${Duration.toSeconds(wait)} s`,
        });
      }
      const { t: _, id: __, ...reply } = outcome.value as R;
      return reply as Omit<R, "t" | "id">;
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
      return yield* request<CmdResult>(
        machineId,
        (id) => ({ t: "cmd_check", id, cwd: input.cwd, argv: input.argv, timeoutSec }),
        Duration.sum(Duration.seconds(timeoutSec), REPLY_GRACE),
      );
    });

  const deliverSecret: NodeCommands["Service"]["deliverSecret"] = (machineId, input) =>
    request<SecretResult>(machineId, (id) => ({ t: "secret_deliver", id, ...input }), SECRET_REPLY);

  const runGated: NodeCommands["Service"]["runGated"] = (machineId, input) =>
    request<GatedResult>(machineId, (id) => ({ t: "gated_run", id, ...input }), Duration.sum(Duration.seconds(input.timeoutSec), REPLY_GRACE));

  const actions = NodeActions.of({
    run: (machineId, action) => request<NodeActionResult>(machineId, (id) => ({ t: "node_action", id, action }), ACTION_WAIT[action]),
  });

  return { commands: NodeCommands.of({ run, deliverSecret, runGated, attach, resolve }), actions };
});

export const make = Effect.map(makeBoth, (both) => both.commands);

/** NodeCommands and the doctor's NodeActions over the same node links. */
export const layer = Layer.effectContext(Effect.map(makeBoth, ({ commands, actions }) => Context.make(NodeCommands, commands).pipe(Context.add(NodeActions, actions))));

/** For fakes that only run commands: no secret reaches, and no approved command runs on, any machine. */
export const unlinked = (machineId: MachineId) =>
  Effect.fail(new NodeCommandError({ machineId, reason: "offline", message: `${machineId}'s node is not linked to the hub` }));
