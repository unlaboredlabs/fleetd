import os from "node:os";
import { parseArgs } from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AppSocket from "./api/AppSocket.ts";
import * as FleetApi from "./api/FleetApi.ts";
import * as HttpApp from "./api/HttpApp.ts";
import * as Auth from "./auth/Auth.ts";
import * as Executors from "./executor/Executors.ts";
import * as NodeLinkServer from "./link/NodeLinkServer.ts";
import * as EventLog from "./store/EventLog.ts";
import * as HubDb from "./store/HubDb.ts";
import * as HubStore from "./store/HubStore.ts";
import * as Webhooks from "./webhooks/Webhooks.ts";

export interface HubOptions {
  /** Absent means the default, `~/.fleetd/hub`. */
  readonly home?: string;
  readonly listen: { readonly host: string; readonly port: number };
}

export const HUB_START_USAGE = `  hub start [--home <dir>] [--listen <host:port>]
             run the hub (default home ~/.fleetd/hub, listen 127.0.0.1:4790)
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
    parsed = parseArgs({ args: [...argv], options: { home: { type: "string" }, listen: { type: "string" } }, strict: true });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const { home, listen } = parsed.values;
  const address = listen === undefined ? HttpApp.DEFAULT_LISTEN : parseListen(listen);
  if (address === undefined) return { error: `--listen must be host:port, got '${listen}'` };
  return { ...(home === undefined ? {} : { home }), listen: address };
};

const layerMachines = Layer.effect(
  NodeLinkServer.NodeLinkServer,
  Effect.gen(function* () {
    return yield* NodeLinkServer.make({ hubId: `fleetd-${os.hostname()}`, executors: yield* Executors.Executors });
  }),
).pipe(Layer.provideMerge(Executors.layer));

/** The whole hub over the database in `home` (already resolved by `HubDb.resolveHubHome`). */
export const hubLayer = (home: string, listen: HubOptions["listen"]) =>
  HttpApp.layer(listen).pipe(
    Layer.provide(
      AppSocket.layer.pipe(
        Layer.provideMerge(FleetApi.layer),
        Layer.provideMerge(Webhooks.layer(home)),
        Layer.provideMerge(layerMachines),
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
      Layer.launch(hubLayer(home, options.listen)),
    ),
  );
