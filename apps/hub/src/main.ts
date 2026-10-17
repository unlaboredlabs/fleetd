import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AppSocket from "./api/AppSocket.ts";
import * as FleetApi from "./api/FleetApi.ts";
import * as HttpApp from "./api/HttpApp.ts";
import * as Auth from "./auth/Auth.ts";
import * as HumanDigests from "./digests/HumanDigests.ts";
import * as Intake from "./intake/Intake.ts";
import * as IntakeRouter from "./intake/Router.ts";
import * as ChecksLayer from "./checks/layer.ts";
import * as Judges from "./checks/Judges.ts";
import * as NodeCommands from "./checks/NodeCommands.ts";
import * as Estimates from "./estimates/Estimates.ts";
import * as Executors from "./executor/Executors.ts";
import * as LeadCallHandler from "./leads/LeadCallHandler.ts";
import * as LeadsLayer from "./leads/layer.ts";
import * as Leases from "./leases/Leases.ts";
import * as Policy from "./leases/Policy.ts";
import * as NodeLinkServer from "./link/NodeLinkServer.ts";
import * as Receipts from "./receipts/Receipts.ts";
import * as EventLog from "./store/EventLog.ts";
import * as HubDb from "./store/HubDb.ts";
import * as HubStore from "./store/HubStore.ts";
import * as Slots from "./slots/Slots.ts";
import * as Tasks from "./tasks/Tasks.ts";
import * as Train from "./train/Train.ts";
import * as TrainGitHub from "./train/TrainGitHub.ts";
import * as TrainGate from "./reviews/trainGate.ts";
import * as PrHeads from "./valuebar/PrHeads.ts";
import * as ValueBar from "./valuebar/ValueBar.ts";
import * as Webhooks from "./webhooks/Webhooks.ts";
import * as WriteQueue from "./queue/WriteQueue.ts";
import * as Sweep from "./sweep/Sweep.ts";
import * as Wakes from "./wakes/Wakes.ts";
import * as Watchdog from "./watchdog/Watchdog.ts";

export interface HubOptions {
  /** Absent means the default, `~/.fleetd/hub`. */
  readonly home?: string;
  readonly listen: { readonly host: string; readonly port: number };
  /** How long a write to an offline machine waits in the queue; absent means 24 h. */
  readonly queueTtlSec?: number;
  /** The intake router's model; absent means claude-haiku-5-5. */
  readonly routerModel?: string;
}

export const HUB_START_USAGE = `  hub start [--home <dir>] [--listen <host:port>] [--queue-ttl <seconds>] [--router-model <model>]
             run the hub (default home ~/.fleetd/hub, listen 127.0.0.1:4790,
             writes to an offline machine wait 24 h, intents without a project
             are routed by the claude CLI with claude-haiku-5-5)
`;

/** `host:port`, `:port` or `port`; IPv6 hosts in brackets, as in `[::1]:4790`. */
export const parseListen = (value: string): HubOptions["listen"] | undefined => {
  const colon = value.lastIndexOf(":");
  const rawHost = colon === -1 ? "" : value.slice(0, colon);
  const rawPort = colon === -1 ? value : value.slice(colon + 1);
  const port = Number(rawPort);
  if (!/^\d+$/u.test(rawPort) || port < 1 || port > 65535) return undefined;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  return { host: host.length === 0 ? HttpApp.DEFAULT_LISTEN.host : host, port };
};

export const parseHubArgs = (argv: ReadonlyArray<string>): HubOptions | { readonly error: string } => {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: { home: { type: "string" }, listen: { type: "string" }, "queue-ttl": { type: "string" }, "router-model": { type: "string" } }, strict: true });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const { home, listen } = parsed.values;
  const address = listen === undefined ? HttpApp.DEFAULT_LISTEN : parseListen(listen);
  if (address === undefined) return { error: `--listen must be host:port, got '${listen}'` };
  const ttl = parsed.values["queue-ttl"];
  if (ttl !== undefined && !/^[1-9]\d*$/u.test(ttl)) return { error: `--queue-ttl must be a whole number of seconds, got '${ttl}'` };
  const routerModel = parsed.values["router-model"];
  return {
    ...(home === undefined ? {} : { home }),
    listen: address,
    ...(ttl === undefined ? {} : { queueTtlSec: Number(ttl) }),
    ...(routerModel === undefined ? {} : { routerModel }),
  };
};

/**
 * The merge train with its review gate. The gate spawns reviewers and needs `Train.markReady`, the train needs the
 * gate, so the train is handed to the gate once built (`layerBindTrain` over `Train.layer` over `layerGate`). The
 * train runs git on the project's machine through NodeCommands and asks GitHub through the hub machine's `gh`; it
 * holds a repo while its freeze decision is set and records merges it did not do as `policy_bypass` incidents.
 */
const layerTrain = TrainGate.layerBindTrain.pipe(
  Layer.provideMerge(Train.layer()),
  Layer.provideMerge(TrainGate.layerGate),
  Layer.provideMerge(TrainGitHub.layer()),
);

/**
 * Node links; lead-side `fleetd` calls they forward are answered over the ledger, leads, tasks, claims and the train.
 * Claims and the train run commands on the nodes through the same NodeCommands the links answer.
 */
const layerMachines = Layer.effect(
  NodeLinkServer.NodeLinkServer,
  Effect.gen(function* () {
    return yield* NodeLinkServer.make({
      hubId: `fleetd-${os.hostname()}`,
      executors: yield* Executors.Executors,
      leadCalls: yield* LeadCallHandler.make,
      commands: yield* NodeCommands.NodeCommands,
    });
  }),
).pipe(Layer.provideMerge(layerTrain), Layer.provideMerge(ChecksLayer.layer()), Layer.provideMerge(NodeCommands.layer));

/** The sweep's overdue-wakes check; the wake scheduler does the firing. */
const layerWakeSweep = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* Sweep.Sweep;
    const wakes = yield* Wakes.Wakes;
    yield* sweep.register({ name: "wakes", run: wakes.sweepOverdue(Sweep.WAKE_OVERDUE_MS) });
  }),
);

/**
 * Tasks with the slot board, area leases, the repo policy file read through each machine's T3, and the value bar
 * with receipts; recorded verdicts complete waiting judges. Estimates and incidents come with the leads layer; the
 * estimate clock starts on each workstream.running.
 */
const layerTasks = Tasks.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Slots.layer(),
      Leases.layer,
      Policy.layer.pipe(Layer.provide(Policy.layerSourceT3)),
      ValueBar.layer,
      Receipts.layer,
      Estimates.layerStartOnRunning,
    ),
  ),
  Layer.provideMerge(Layer.merge(PrHeads.layerGh, Judges.layerJudgeHook.pipe(Layer.provideMerge(Judges.layerVerdicts)))),
);

/** The whole hub over the database in `home` (already resolved by `HubDb.resolveHubHome`). */
export const hubLayer = (home: string, options: HubOptions) =>
  HttpApp.layer(options.listen).pipe(
    Layer.provide(
      AppSocket.layer.pipe(
        Layer.provideMerge(FleetApi.layer),
        Layer.provideMerge(Intake.layer.pipe(Layer.provide(IntakeRouter.layer({ home, ...(options.routerModel === undefined ? {} : { model: options.routerModel }) })))),
        Layer.provideMerge(Layer.merge(layerWakeSweep, Leases.layerSweep)),
        // The sweep reports failing webhooks, so it sits above them.
        Layer.provideMerge(Sweep.layer().pipe(Layer.provideMerge(Watchdog.layer()))),
        Layer.provideMerge(Webhooks.layer(home)),
        Layer.provideMerge(layerMachines),
        // Wakes sit above the leads layer: a firing waits while the usage layer holds its thread.
        Layer.provideMerge(Layer.merge(HumanDigests.layer, Wakes.layer)),
        Layer.provideMerge(layerTasks),
        // Leads and the ledger; lead wakes go out through the write queue below.
        Layer.provideMerge(LeadsLayer.layerWithLedger({ playbookOverrides: path.join(home, "playbooks") })),
        Layer.provideMerge(
          WriteQueue.layer(options.queueTtlSec === undefined ? {} : { ttl: Duration.seconds(options.queueTtlSec) }),
        ),
        Layer.provideMerge(Executors.layer),
        Layer.provideMerge(Layer.mergeAll(HubStore.layer, EventLog.layer, Auth.layer)),
        Layer.provide(HubDb.layer(home)),
      ),
    ),
  );

/** Runs the hub until interrupted. Refuses a home inside ~/.t3. */
export const hubProgram = (options: HubOptions) =>
  Effect.flatMap(HubDb.resolveHubHome(options.home), (home) =>
    Effect.andThen(
      Effect.logInfo(`fleetd hub: home ${home}, listening on ${options.listen.host}:${options.listen.port}`),
      Layer.launch(hubLayer(home, options)),
    ),
  );
