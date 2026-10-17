// Test kit for checks: the tasks kit (real store, leads, ledger, tasks on an in-memory database under a TestClock)
// plus the checks layer with a fake node, a fake `gh` binary and an Estimates that records which workstreams were done.
import type { Brief, CheckSpec, MachineId, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Estimates } from "../estimates/Estimates.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import { makeKit, REF } from "../tasks/testKit.ts";
import type { GhRunner } from "./GitHub.ts";
import * as Judges from "./Judges.ts";
import * as ChecksLayer from "./layer.ts";
import { type CommandInput, type CommandOutcome, NodeCommandError, NodeCommands } from "./NodeCommands.ts";

export { REF };

export type GhReply = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export const makeChecksKit = () => {
  const tasksKit = makeKit();
  const commands: Array<{ readonly machineId: MachineId; readonly input: CommandInput }> = [];
  /** What the fake node answers; a string is an exit reason that fails the run as offline. */
  let node: (input: CommandInput) => CommandOutcome | "offline" = () => ({ exitCode: 0, outputTail: "", timedOut: false });
  const ghCalls: Array<ReadonlyArray<string>> = [];
  let gh: (path: string) => GhReply | "missing" = () => ({ exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
  const done: Array<WorkstreamId> = [];

  const fakeNode = NodeCommands.of({
    run: (machineId, input) =>
      Effect.suspend(() => {
        commands.push({ machineId, input });
        const out = node(input);
        return out === "offline"
          ? Effect.fail(new NodeCommandError({ machineId, reason: "offline", message: `${machineId}'s node is not linked to the hub` }))
          : Effect.succeed(out);
      }),
    attach: () => Effect.void,
    resolve: () => Effect.void,
  });
  const ghRunner: GhRunner = (args) =>
    Effect.suspend(() => {
      ghCalls.push(args);
      const reply = gh(args.at(-1)!);
      return reply === "missing" ? Effect.fail({ spawnError: "ENOENT" }) : Effect.succeed(reply);
    });

  const layer = ChecksLayer.layer({ gh: ghRunner }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(NodeCommands, fakeNode),
        Judges.layerVerdicts,
        Layer.succeed(
          Estimates,
          Estimates.of({ recordStart: () => Effect.void, recordDone: (id) => Effect.sync(() => void done.push(id)), eta: () => Effect.succeed(undefined) }),
        ),
      ),
    ),
    Layer.provideMerge(tasksKit.layer),
  );

  /** The tasks kit's project, lead and running W1, with `doneWhen` as its brief's checks. */
  const setup = (doneWhen: ReadonlyArray<CheckSpec>) =>
    Effect.gen(function* () {
      const id = yield* tasksKit.setup;
      const records = yield* LeadRecords.LeadRecords;
      const stored = (yield* records.workstreams.get(id))!;
      const brief: Brief = { ...stored.workstream.brief!, doneWhen };
      yield* records.workstreams.put({ ...stored, workstream: { ...stored.workstream, brief } });
      return id;
    });

  return {
    layer,
    tasksKit,
    commands,
    ghCalls,
    done,
    setup,
    setNode: (f: typeof node) => {
      node = f;
    },
    setGh: (f: typeof gh) => {
      gh = f;
    },
  };
};

export type ChecksKit = ReturnType<typeof makeChecksKit>;

export const runChecksKit = <A, E>(kit: ChecksKit, effect: Effect.Effect<A, E, Layer.Success<ChecksKit["layer"]>>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, kit.layer)));

export const json = (body: unknown): GhReply => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: "" });
