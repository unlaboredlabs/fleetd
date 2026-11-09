// `fleetd update [--check] [--channel edge|stable] [--flavour rust|bun] [--now]` (crates/fleetd/src/cli/update.rs), on
// src/update: replaces this binary with the latest build of a release channel, then restarts the hub and node services
// that run it: the hub at once, the node once its agents finish the step they're on (held meanwhile, node/hold), 2
// minutes at most; `--now` doesn't wait. The desktop app's Update button does the same through the hub (`hub_update`).
//
// `--flavour rust` switches the machine back to the release's Rust build, at the same path; the Rust build's
// `--flavour bun` switches it here. A Bun update brings the Rust session host beside it along (updateHelper).
//
// Not here: replacing the pre-Electron GPUI app (the Rust CLI's App migration), which no Bun-built machine has.
import { spawnSync } from "node:child_process";
import { claudeBinary, TESTED } from "../node/runner/claude.ts";
import { bringTo, RealClaude } from "../node/runner/install.ts";
import { VERSION } from "../shared/version.ts";
import { ArgError, parse } from "./args.ts";
import { resolveHome } from "./common.ts";
import { usageText } from "./index.ts";
import { sendToNode, nodeSocketPath } from "./agent_mcp/socket.ts";
import { connectAs } from "./setup/doctor.ts";
import { hubInfo, versionShown } from "./versions.ts";

/** How often `fleetd update` looks at its node's agents again while it waits for them. */
const WAIT_POLL_MS = 2000;

export async function updateCommand(argv: string[]): Promise<number> {
  const v = parse(argv, { options: { check: "bool", channel: "str", flavour: "str", now: "bool" }, positionals: false });
  if (v instanceof ArgError) {
    process.stderr.write(`fleetd: ${v.message}\n\n${usageText()}`);
    return 2;
  }
  try {
    await run({
      check: v.flag("check"),
      ...(v.str("channel") === undefined ? {} : { channel: v.str("channel")! }),
      ...(v.str("flavour") === undefined ? {} : { flavour: v.str("flavour")! }),
      now: v.flag("now"),
    });
    return 0;
  } catch (error) {
    process.stderr.write(`fleetd: ${(error as Error).message}\n`);
    return 1;
  }
}

/** The version the hub on this machine runs (`hub_info`), through the CLI's own key. */
async function askHub(): Promise<string | undefined> {
  try {
    const client = await connectAs(resolveHome(), "fleetd-update");
    const info = await hubInfo(client);
    return typeof info?.version === "string" ? info.version : undefined;
  } catch {
    return undefined;
  }
}

export async function run(args: { check: boolean; channel?: string; flavour?: string; now: boolean }): Promise<void> {
  const { FLAVOUR, HttpFeed, assetOf, baseUrl, channelOf, checkedTo, installedExe, parseChannel, parseFlavour, release, sums, updateHelper } = await import(
    "../update/index.ts"
  );
  const { isHubService, services: servicesOf } = await import("../update/service.ts");
  const current = VERSION;
  const releaseBuild = process.env.FLEETD_VERSION !== undefined;
  const named = args.channel ?? process.env.FLEETD_CHANNEL;
  const channel = named !== undefined ? parseChannel(named) : channelOf(current, releaseBuild);
  const flavour = args.flavour !== undefined ? parseFlavour(args.flavour) : FLAVOUR;
  const switching = flavour !== FLAVOUR;
  const feed = new HttpFeed(baseUrl(channel));
  const rel = await release(feed);
  // A switch installs the other flavour's build of the newest release, even one of this version.
  const cliLatest = rel.cliVersion !== undefined && (switching || rel.cliVersion !== current) ? rel.cliVersion : undefined;
  const exe = installedExe();
  const services = servicesOf(exe);
  const hub = services.some(isHubService) ? await askHub() : undefined;
  // An earlier update installed this binary, and the hub still runs the one before.
  const pending = hub !== undefined && cliLatest === undefined && hub !== current && hub !== "0.0.0" ? hub : undefined;
  if (cliLatest !== undefined && switching) console.log(`fleetd ${versionShown(current)} (${FLAVOUR}) -> ${versionShown(cliLatest)} (${flavour}) (${channel})`);
  else if (cliLatest !== undefined) console.log(`fleetd ${versionShown(current)} -> ${versionShown(cliLatest)} (${channel})`);
  else if (rel.cliVersion !== undefined) console.log(`fleetd ${versionShown(current)} is up to date (${channel})`);
  else console.log(`the ${channel} channel has no fleetd CLI build yet`);
  if (pending !== undefined) console.log(`the hub still runs ${versionShown(pending)}; a restart moves it to ${versionShown(current)}`);
  const restartDue = services.length > 0 && (cliLatest !== undefined || pending !== undefined);
  if (args.check || !restartDue) {
    if (args.check && switching) console.log(`run \`fleetd update --flavour ${flavour}\` to install`);
    else if (args.check && cliLatest !== undefined) console.log("run `fleetd update` to install");
    else if (args.check && pending !== undefined) console.log("run `fleetd update` to restart it");
    return;
  }
  if (cliLatest !== undefined) {
    if (!releaseBuild) throw new Error("this fleetd is a local build; install a release with: curl -fsSL https://fleetd.sh | sh");
    try {
      const s = await sums(feed);
      // Staying on Bun: its session host moves with it first. Back to Rust: the Rust build needs none.
      if (flavour === "bun") await updateHelper(feed, s, exe);
      await checkedTo(feed, s, assetOf(flavour), exe);
    } catch (error) {
      throw new Error(`replacing ${exe}: ${(error as Error).message}`);
    }
    console.log(`updated ${exe}`);
  }
  if (restartDue) await restart(services, !args.now, exe);
  // This machine runs agents: its Claude Code goes to the version the installed build was tested with.
  if (cliLatest !== undefined && services.some((s) => !isHubService(s))) {
    const status = spawnSync(exe, ["update-claude"], { stdio: "inherit" });
    if (status.status !== 0) console.error("Claude Code wasn't brought to the version fleetd is tested with; `fleetd doctor` says more");
  }
}

/** Holds this machine's node's agents between steps and waits until none is mid-step, `deadlineMs` at most. */
async function waitForAgents(deadlineMs: number) {
  const socket = nodeSocketPath(process.env.FLEETD_NODE_SOCK);
  const started = Date.now();
  let said: number | undefined;
  for (;;) {
    let steps = 0;
    try {
      const answer = await sendToNode(socket, { t: "hold" }, 10_000, 0);
      steps = typeof answer.steps === "number" ? answer.steps : 0;
    } catch {}
    if (steps === 0) return;
    if (Date.now() - started >= deadlineMs) {
      console.log(`restarting the node with ${steps} still mid-step: they carry on by themselves afterwards`);
      return;
    }
    if (said !== steps) {
      console.log(
        `waiting for ${steps} agent${steps === 1 ? "" : "s"} to finish ${steps === 1 ? "its" : "their"} step (at most ${Math.floor(deadlineMs / 60_000)} min; --now doesn't wait)`,
      );
      said = steps;
    }
    await Bun.sleep(WAIT_POLL_MS);
  }
}

/** Restarts `services`: the hub's at once, a node's once its agents finish their step when `wait`. Run as one of the
 * node's approved commands, the node restarts only once this command ended (`node restart --after`). */
async function restart(services: { name: string; unit: string }[], wait: boolean, exe: string) {
  const { isHubService, restart: restartOne, spawnOutside } = await import("../update/service.ts");
  const { DRAIN_MINUTES, drainIn } = await import("../hub/update/index.ts");
  const { APPROVED_RUN_ENV } = await import("../node/secrets/index.ts");
  const one = (s: { name: string; unit: string }) => {
    try {
      restartOne(s);
      console.log(`restarted ${s.name}`);
    } catch (error) {
      console.error(`${(error as Error).message}; restart ${s.name} yourself`);
    }
  };
  const hubs = services.filter(isHubService);
  const nodes = services.filter((s) => !isHubService(s));
  hubs.forEach(one);
  if (wait && nodes.length > 0) {
    const fallback = DRAIN_MINUTES * 60_000;
    let deadline = fallback;
    try {
      deadline = drainIn(resolveHome(), fallback);
    } catch {}
    await waitForAgents(deadline);
  }
  const approved = process.env[APPROVED_RUN_ENV] !== undefined;
  for (const s of nodes) {
    if (!approved) {
      one(s);
      continue;
    }
    try {
      spawnOutside(exe, ["node", "restart", "--after", String(process.pid)]);
      console.log(`${s.name} restarts once this command ends`);
    } catch (error) {
      console.error(`${(error as Error).message}; restart ${s.name} yourself`);
    }
  }
  console.log(
    "anything that was running carries on by itself: leads and agents resume in their threads, and the merge train takes up what it was merging",
  );
}

/** `fleetd update-claude`: brings this machine's Claude Code to the version this build was tested with, saying how it
 * went. Sessions already running finish on the version they started with. */
export async function runClaude(): Promise<number> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  try {
    const done = await bringTo(new RealClaude(claudeBinary(), env), TESTED);
    if (done.kind === "current") console.log(`Claude Code ${done.version} is the version fleetd is tested with`);
    else if (done.kind === "left") console.log(done.said);
    else console.log(`Claude Code ${done.from} -> ${done.to}: new sessions start on ${done.to}, running ones finish on ${done.from}`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}
