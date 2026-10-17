// One real pass of the train against a GitHub repo: enqueue an open PR (its body needs `Source: done:0`), then run
// the repo's loop until the Change leaves the train. Real `gh` and real git in the checkout, an in-memory hub
// database, no T3 and no claude turns.
//
//   node apps/hub/src/train/testbedCheck.ts <PR URL> [--checkout /home/wynn/src/fleetd-lab/testbed]
import { parseArgs } from "node:util";
import type { MachineId, ProjectId, ProjectRef } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NodeCommands } from "../checks/NodeCommands.ts";
import * as Incidents from "../incidents/Incidents.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import { LeadWakes } from "../leads/LeadWakes.ts";
import * as Decisions from "../ledger/Decisions.ts";
import * as LedgerRepo from "../ledger/LedgerRepo.ts";
import * as Playbooks from "../playbooks/Playbooks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import { Tasks } from "../tasks/Tasks.ts";
import * as ChangeRecords from "./ChangeRecords.ts";
import { localCommands } from "./localCommands.ts";
import * as ReviewGate from "./ReviewGate.ts";
import * as Train from "./Train.ts";
import * as TrainGitHub from "./TrainGitHub.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { checkout: { type: "string", default: "/home/wynn/src/fleetd-lab/testbed" } } });
const prUrl = positionals[0];
if (prUrl === undefined) throw new Error("usage: testbedCheck.ts <PR URL> [--checkout <dir>]");

const REF: ProjectRef = { machineId: "lab" as MachineId, projectId: "testbed" as ProjectId };
// The same scrub a node applies: none of the calling agent's CLAUDE* variables.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
const say = (line: string) => Effect.sync(() => console.log(line));

const fakes = Layer.mergeAll(
  Layer.succeed(NodeCommands, localCommands(env)),
  Layer.succeed(Tasks, {
    message: (_caller: unknown, taskId: string, text: string) => Effect.andThen(say(`[task message to ${taskId}] ${text}`), Effect.die("no tasks here")),
  } as unknown as Tasks["Service"]),
  Layer.succeed(LeadWakes, LeadWakes.of({ trigger: (_ref, t) => say(`[lead wake] ${JSON.stringify(t)}`), digest: () => Effect.succeed("") })),
  ReviewGate.layerTierS,
  TrainGitHub.layer(),
);

const layer = Train.layer({ autoRun: false }).pipe(
  Layer.provideMerge(fakes),
  Layer.provideMerge(
    Layer.mergeAll(ChangeRecords.layer, Incidents.layer, LeadRecords.layer, Playbooks.layer(), Decisions.layer.pipe(Layer.provideMerge(LedgerRepo.layer))),
  ),
  Layer.provideMerge(Layer.mergeAll(HubStore.layer, EventLog.layer)),
  Layer.provide(HubDb.layerMemory),
);

const program = Effect.gen(function* () {
  const store = yield* HubStore.HubStore;
  yield* store.projects.upsertMany(REF.machineId, [
    {
      ...REF,
      title: "testbed",
      workspaceRoot: values.checkout,
      threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
      lastActivityAt: new Date().toISOString(),
    },
  ]);
  const records = yield* LeadRecords.LeadRecords;
  const { workstream } = yield* records.workstreams.create({ ref: REF, title: "train check", source: { text: "train check", channel: "app", by: "human", at: new Date().toISOString() } });
  yield* records.workstreams.put({
    workstream: {
      ...workstream,
      state: "running",
      brief: { goal: "one PR through the train", why: "M7a check", pointers: [], constraints: [], doneWhen: [{ type: "pr_merged", repo: "unlaboredlabs/fleetd-testbed" }], tier: "S" },
    },
    amends: [],
  });

  const train = yield* Train.Train;
  const change = yield* train.enqueue({ projectRef: REF, by: "lab" }, { prUrl, workstreamId: workstream.workstreamId });
  yield* say(`enqueued ${change.changeId}: ${change.state}, head ${change.headSha}, patch ${change.patchId ?? "-"}`);
  for (let pass = 1; pass <= 10; pass++) {
    const took = yield* train.step(change.repo);
    const now = (yield* train.get(change.changeId))!;
    yield* say(`pass ${pass}: took=${took} state=${now.state}${now.lastError === undefined ? "" : ` (${now.lastError})`}`);
    if (!["queued", "reviewing", "ready"].includes(now.state)) break;
  }
  const events = yield* (yield* EventLog.EventLog).wait({ cursor: 0, timeoutSec: 0 });
  for (const e of events.events) yield* say(`event ${e.type}: ${e.summary}`);
  const final = (yield* train.get(change.changeId))!;
  yield* say(JSON.stringify(final, null, 2));
  if (final.state !== "merged") yield* Effect.sync(() => (process.exitCode = 1));
});

Effect.runPromise(Effect.scoped(Effect.provide(program, layer))).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
