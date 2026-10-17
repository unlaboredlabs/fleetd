import { MachineId } from "@fleetd/contracts";
import { Data, Deferred, Effect, Exit, Schema } from "effect";
import * as Socket from "effect/socket/Socket";
import pkg from "../package.json" with { type: "json" };
import { defaultNodeHome, type NodeConfig, readConfig, writeConfig } from "./config.ts";
import { loadOrCreateBoxKey, loadOrCreateIdentity } from "./identity.ts";
import { leadSocketPath, makeLeadRelay, serveLeadSocket } from "./LeadCalls.ts";
import { fetchT3Info, linkUrl, runNode } from "./link.ts";
import * as T3Sessions from "./T3Sessions.ts";
import { restartCommand } from "./T3Supervisor.ts";

export { LinkFatal } from "./link.ts";

export class NodeSetupError extends Data.TaggedError("NodeSetupError")<{ readonly message: string }> {}

export interface JoinInput {
  readonly hub: string;
  readonly token: string;
  readonly machine: string;
  readonly t3Home: string;
  readonly t3Url: string;
  /** Command that runs T3's CLI, split on whitespace. Default `t3`. */
  readonly t3Cmd?: string;
  /** Command that restarts T3 when it is down, split on whitespace. No default: without it the node never restarts T3. */
  readonly t3RestartCmd?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly name?: string;
  readonly home?: string;
  /** Stop once the hub has accepted the node's key, instead of keeping the link up (`fleetd machine add` enrolls, then starts the service). */
  readonly exitWhenEnrolled?: boolean;
}

const splitArgv = (command: string) => command.split(/\s+/u).filter((part) => part.length > 0);

const run = (home: string, config: NodeConfig, enrollToken?: string, exitWhenEnrolled = false) =>
  Effect.gen(function* () {
    const enrolled = yield* Deferred.make<void>();
    const identity = yield* Effect.try({
      try: () => loadOrCreateIdentity(home),
      catch: () => new NodeSetupError({ message: `cannot read or create the node key in ${home}` }),
    });
    const box = yield* Effect.tryPromise({
      try: () => loadOrCreateBoxKey(home),
      catch: () => new NodeSetupError({ message: `cannot read or create the node box key in ${home}` }),
    });
    yield* Effect.logInfo("fleetd node starting").pipe(
      Effect.annotateLogs({ machineId: config.machineId, hub: config.hub, t3Url: config.t3Url }),
    );
    const leadCalls = yield* makeLeadRelay();
    yield* serveLeadSocket(leadSocketPath(home), leadCalls.call);
    const node = runNode({
      settings: { machineId: config.machineId, name: config.name, tags: config.tags, nodeVersion: pkg.version, t3Url: config.t3Url },
      identity,
      dial: Socket.makeWebSocket(linkUrl(config.hub)).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
      t3Info: fetchT3Info(config.t3Url),
      leadCalls,
      secrets: { box, home },
      ...(config.cmdRoots === undefined ? {} : { cmdRoots: config.cmdRoots }),
      ...(config.t3RestartCmd === undefined ? {} : { t3Restart: restartCommand(config.t3RestartCmd) }),
      ...(enrollToken === undefined
        ? {}
        : {
            enrollToken,
            onEnrolled: Effect.sync(() => writeConfig(home, { ...config, enrolled: true })).pipe(
              Effect.andThen(Effect.logInfo("enrolled with the hub; later starts use `fleetd node run`")),
              Effect.andThen(Deferred.succeed(enrolled, undefined)),
            ),
          }),
    });
    return yield* exitWhenEnrolled ? Effect.raceFirst(node, Deferred.await(enrolled)) : node;
  }).pipe(Effect.scoped, Effect.provide(T3Sessions.layerCli({ t3Cmd: config.t3Cmd, t3Home: config.t3Home })));

/** `fleetd node join`: creates the node key and config, enrolls with the one-time token, then keeps the link up. */
export const join = (input: JoinInput) =>
  Effect.gen(function* () {
    const machineId = Schema.decodeUnknownExit(MachineId)(input.machine);
    if (Exit.isFailure(machineId)) {
      return yield* new NodeSetupError({ message: `machine id '${input.machine}' must match [a-z0-9-]{1,32}` });
    }
    const home = input.home ?? defaultNodeHome();
    const config: NodeConfig = {
      hub: input.hub,
      machineId: machineId.value,
      name: input.name ?? machineId.value,
      tags: input.tags ?? [],
      t3Home: input.t3Home,
      t3Url: input.t3Url,
      t3Cmd: splitArgv(input.t3Cmd ?? "t3"),
      ...(input.t3RestartCmd === undefined ? {} : { t3RestartCmd: splitArgv(input.t3RestartCmd) }),
      enrolled: false,
    };
    yield* Effect.try({
      try: () => writeConfig(home, config),
      catch: () => new NodeSetupError({ message: `cannot write the node config in ${home}` }),
    });
    return yield* run(home, config, input.token, input.exitWhenEnrolled);
  });

/** `fleetd node run`: keeps the link up for a node that has joined. */
export const start = (input: { readonly home?: string } = {}) =>
  Effect.gen(function* () {
    const home = input.home ?? defaultNodeHome();
    const config = yield* Effect.try({
      try: () => readConfig(home),
      catch: () => new NodeSetupError({ message: `node config in ${home} is unreadable` }),
    });
    if (config === undefined || !config.enrolled) {
      return yield* new NodeSetupError({
        message: `this node has not joined a hub (no enrolled config in ${home}): run fleetd node join first`,
      });
    }
    return yield* run(home, config);
  });
