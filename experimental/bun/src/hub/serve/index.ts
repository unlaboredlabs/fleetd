// `fleetd hub start` (crates/fleetd/src/hub/serve/mod.rs): parses its flags, opens the database in `--home`, starts
// every module's loops and serves HTTP until SIGTERM/SIGINT.
import { refreshOwnUnit } from "../../cli/setup/units.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startAll } from "../../gen/loops.ts";
import { registerAll } from "../../gen/areas.ts";
import { systemClock } from "../../shared/clock.ts";
import { expandHome, fleetdDir } from "../../shared/home.ts";
import { Hub, type Listen } from "../api/hub.ts";
import { Registry } from "../api/registry.ts";
import { serve, stop } from "../http/index.ts";
import { link } from "../link/index.ts";
import { HubDb } from "../store/db.ts";
import { people } from "../people/store.ts";

export const HUB_START_USAGE = `  hub start [--home <dir>] [--listen <host:port>]
             run the hub (default home ~/.fleetd/hub, listen 127.0.0.1:4790,
             writes to an offline machine wait 24 h)
`;

export const DEFAULT_LISTEN: Listen = { host: "127.0.0.1", port: 4790 };

/** `host:port`, `:port` or `port`; IPv6 hosts in brackets, as in `[::1]:4790`. */
export function parseListen(value: string): Listen | undefined {
  const colon = value.lastIndexOf(":");
  const [rawHost, rawPort] = colon < 0 ? ["", value] : [value.slice(0, colon), value.slice(colon + 1)];
  if (!/^\d+$/.test(rawPort)) return undefined;
  const port = Number(rawPort);
  if (port < 1 || port > 65535) return undefined;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  return { host: host || DEFAULT_LISTEN.host, port };
}

export type HubOptions = { home?: string; listen: Listen };

/** The flags of `hub start`, with node:util parseArgs's strict rules and messages: the last one wins, no positionals. */
export function parseHubArgs(argv: string[]): HubOptions | string {
  const values: { home?: string; listen?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const positional = `Unexpected argument '${arg}'. This command does not take positional arguments`;
    if (arg === "--") {
      const next = argv[i + 1];
      return next === undefined ? parsed(values) : `Unexpected argument '${next}'. This command does not take positional arguments`;
    }
    const body = arg.startsWith("--") ? arg.slice(2) : "";
    if (!body) return arg.length > 1 && arg.startsWith("-") ? `Unknown option '${arg}'` : positional;
    const eq = body.indexOf("=");
    const name = eq < 0 ? body : body.slice(0, eq);
    if (name !== "home" && name !== "listen") return `Unknown option '--${name}'`;
    let value = eq < 0 ? undefined : body.slice(eq + 1);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) return `Option '--${name} <value>' argument missing`;
    }
    values[name] = value;
  }
  return parsed(values);
}

function parsed(values: { home?: string; listen?: string }): HubOptions | string {
  if (values.listen === undefined) return { ...(values.home === undefined ? {} : { home: values.home }), listen: DEFAULT_LISTEN };
  const listen = parseListen(values.listen);
  if (!listen) return `--listen must be host:port, got '${values.listen}'`;
  return { ...(values.home === undefined ? {} : { home: values.home }), listen };
}

/**
 * The URL `fleetd init` saved in `<home>/setup.json` (crates/fleetd/src/hub/serve/mod.rs `configured_url`): undefined
 * without one, when the file isn't valid, or for a wildcard address no device can dial.
 */
export function configuredUrl(home: string): string | undefined {
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(join(home, "setup.json"), "utf8"));
  } catch {
    return undefined;
  }
  const s = state as { listen?: unknown; url?: unknown; machines?: unknown } | null;
  if (!s || typeof s.listen !== "string" || typeof s.url !== "string" || !s.machines || typeof s.machines !== "object") {
    return undefined;
  }
  if (Object.keys(s.machines).some((id) => !/^[a-z0-9-]{1,32}$/.test(id))) return undefined;
  const url = s.url;
  return url === "" || url.includes("0.0.0.0") || url.includes("[::]") ? undefined : url;
}

/** Builds the hub over `<home>/hub.sqlite` and its tool registry, every module's tools registered. */
export function build(home: string, listen: Listen): { hub: Hub; tools: Registry } {
  const db = HubDb.open(home);
  for (const d of db.drift) {
    console.warn(
      d.kind === "changed"
        ? `hub db: migration ${d.name} changed after it ran; it doesn't run again`
        : `hub db: migration ${d.name} was run by a newer fleetd`,
    );
  }
  const url = configuredUrl(home);
  const hub = new Hub({ home, listen, ...(url === undefined ? {} : { url }) }, db, systemClock);
  // An older hub's human keys all become its owner's devices; a new hub gets its owner here.
  people(hub).ensureOwner();
  const tools = new Registry();
  registerAll(tools);
  return { hub, tools };
}

/**
 * How long the hub's stop waits for the lead calls it is answering: agents' fleetd tool calls in flight get their
 * answers rather than a dropped link.
 */
export const LEAD_CALLS_GRACE_MS = 2000;

/** `fleetd hub start <argv>`: 2 on bad flags, 0 after SIGTERM/SIGINT, 1 on a failure. */
export async function hubStart(argv: string[]): Promise<number> {
  const options = parseHubArgs(argv);
  if (typeof options === "string") {
    process.stderr.write(`fleetd: ${options}\n\nusage:\n${HUB_START_USAGE}`);
    return 2;
  }
  const home = options.home === undefined ? join(fleetdDir(), "hub") : expandHome(options.home);
  refreshOwnUnit();
  const { hub, tools } = build(home, options.listen);
  const server = serve(hub, tools);
  console.error(`fleetd hub: home ${home}, listening on ${options.listen.host}:${server.port}`);
  startAll(hub);
  // From here on one task's failure never takes the hub down, as a tokio task's panic doesn't: it is logged and the
  // hub carries on. A failure to start (above) still ends it.
  process.on("unhandledRejection", (reason) => console.error("fleetd hub: a task failed:", reason));
  process.on("uncaughtException", (error) => console.error("fleetd hub: a task failed:", error));
  // The read worker is a separate entry point of the compiled binary: a build that left it out says so at start,
  // not at the first long read.
  hub.db.read("SELECT 1").catch((error: Error) => console.error(`fleetd hub: ${error.message}`));
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => resolve());
  });
  // The lead calls being answered finish first, then every node link closes as a restart (1012), so each node redials
  // at once; the app sockets close as going away (1001) as the shutdown fires.
  await link(hub).stop(LEAD_CALLS_GRACE_MS);
  hub.shutdown.abort();
  await stop(server);
  hub.db.close();
  return 0;
}
