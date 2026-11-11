// machine_add_plan, machine_add, machine_add_status, machine_hosts, machine_remove, machine_join and
// machine_claude_login: an owner's or admin's device only, as
// everything on the Hub pages of the app's Settings.
import type { MachineHost, MachineHostSource } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isMachineId, readSetup } from "../../cli/common.ts";
import { workerJoin, workerReachNote } from "../../cli/pair.ts";
import * as machine from "../../cli/setup/machine.ts";
import { type AddArgs, type Found, type HubSide, type Progress, type Resolved, Stop } from "../../cli/setup/machine.ts";
import { isHuman } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { eraseIn } from "../navi/erase.ts";
import { adminEverywhereFix, allowsEverywhere } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { machineSetup, recorder, removedEvent, splitFix, Steps } from "./index.ts";

export function register(tools: Registry): void {
  tools.add("machine_add_plan", async (hub, caller, input) => {
    admin(caller);
    const r = resolve(hub, input.host, input.machineId);
    const ports = machineSetup(hub).ports;
    const steps = new Steps();
    const prepared = await stopped(
      machine.prepare(r, side(hub, by("machine_add_plan", caller)), ports.runner(), ports.builds(), false, collect(steps)),
    );
    const isJoined = joined(hub, r.machineId);
    return {
      machineId: r.machineId,
      ...(input.host !== undefined ? { host: input.host } : {}),
      platform: machine.preparedPlatform(prepared),
      steps: steps.steps.filter((s) => s.state === "planned"),
      notes: [...prepared.plan.notes],
      joined: isJoined,
      next: isJoined
        ? `${r.machineId} is a machine already: adding it again repairs it, and skips what is in place.`
        : "machine_add runs these steps.",
    };
  });

  tools.add("machine_add", (hub, caller, input) => {
    admin(caller);
    const r = resolve(hub, input.host, input.machineId);
    const m = machineSetup(hub);
    const run = m.start(r.machineId, input.host, isoMs(hub.clock.now()));
    if (run === undefined) throw new ToolError("invalid", `${r.machineId} is being added already.`, "machine_add_status follows it.");
    m.emit(run);
    m.spawnAdd(run, r, side(hub, by("machine_add", caller)));
    return {
      next: `Adding ${r.machineId}: each step sends a machine_add.step event with runId ${run.runId}; machine_add_status reads the run.`,
      run,
    };
  });

  tools.add("machine_add_status", (hub, caller, input) => {
    admin(caller);
    const runs = machineSetup(hub)
      .runs()
      .filter((r) => input.runId === undefined || r.runId === input.runId);
    return {
      runs,
      ...(input.runId !== undefined && runs.length === 0
        ? { next: "No such run: the hub forgets runs when it restarts. Add the machine again; finished steps are skipped." }
        : {}),
    };
  });

  tools.add("machine_hosts", async (hub, caller) => {
    admin(caller);
    let recorded = {};
    try {
      recorded = readSetup(hub.config.home)?.machines ?? {};
    } catch {}
    const [sshHosts, peers] = await machineSetup(hub).ports.hosts();
    const hosts: MachineHost[] = [];
    for (const c of machine.candidates(recorded, sshHosts, peers)) {
      if (c.host !== undefined && !isSshHost(c.host)) continue;
      hosts.push({
        joined: joined(hub, c.machineId),
        ...(c.host !== undefined ? { host: c.host } : {}),
        machineId: c.machineId,
        source: SOURCE[c.found],
      });
    }
    return {
      hosts,
      next: "machine_add_plan shows what adding one runs; a machine the hub can't reach joins with machine_join's line.",
    };
  });

  tools.add("machine_remove", async (hub, caller, input) => {
    admin(caller);
    if (input.force !== true) refuseRemoval(hub, input.machineId);
    const steps = new Steps();
    const removed = await stopped(
      machine.remove(
        hub.config.home,
        input.machineId,
        input.purge === true,
        side(hub, by("machine_remove", caller)),
        machineSetup(hub).ports.runner(),
        collect(steps),
      ),
    );
    // Removed whatever its steps on the machine did: every open app drops it and its projects.
    events(hub).append(removedEvent(input.machineId, isoMs(hub.clock.now())));
    const next = [...steps.said];
    if (!removed.remoteOk) next.unshift("A step on the machine failed: its output says which, and what to run there by hand.");
    return { machineId: input.machineId, steps: steps.steps, revoked: removed.revoked, next: next.join("\n") };
  });

  tools.add("machine_join", (hub, caller, input) => {
    admin(caller);
    const mac = input.mac === true;
    let join;
    try {
      join = workerJoin(hub.config.home, input.machineId, input.rejoin === true, mac);
    } catch (e) {
      throw new ToolError("failed", e instanceof Error ? e.message : String(e));
    }
    const on = input.machineId ?? (mac ? "the Mac" : "the computer to add");
    const as = input.machineId === undefined ? " under its own name" : "";
    let next = mac
      ? `Paste the line in Terminal on ${on}, logged in at its screen (an admin's account is fine): it installs fleetd and joins as the agents' Mac${as}. The code works once, until ${join.expiresAt}; the Mac must reach the hub at ${join.hub}, and needs no claude.`
      : `Run the line on ${on}: it installs fleetd and joins${as}. The code works once, until ${join.expiresAt}; the machine needs claude and must reach the hub at ${join.hub}.`;
    const note = workerReachNote(join.hub);
    if (note !== undefined) next += ` ${note}`;
    return {
      next,
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      hubUrl: join.hub,
      code: join.code,
      expiresAt: join.expiresAt,
      ...(join.gitIdentity !== undefined ? { gitIdentity: join.gitIdentity } : {}),
      line: join.line,
    };
  });

  // The code passes through to the node and nowhere else: no log, no event. What claude gets for it stays on the
  // machine.
  tools.add("machine_claude_login", async (hub, caller, input) => {
    admin(caller);
    const m = input.machineId;
    if (store(hub).machineGet(m) === undefined) throw new ToolError("not_found", `${m} is not one of this hub's machines.`);
    const code = input.code?.trim();
    if (code === "") throw new ToolError("invalid", "The code is empty: paste the one the sign-in page shows.");
    let answer;
    try {
      answer = await machineSetup(hub).ports.claudeLogin(hub, m, code);
    } catch (e) {
      const [message, fix] = splitFix(e instanceof Error ? e.message : String(e));
      throw new ToolError("failed", message, fix);
    }
    if (!answer.ok) {
      throw new ToolError(
        "failed",
        answer.message,
        code === undefined ? `Check that claude runs on ${m}, then try again.` : "Start the login again: each sign-in page's code works once.",
      );
    }
    if (answer.loginUrl !== undefined && code === undefined) {
      return {
        next: `Open loginUrl and sign in; then call machine_claude_login again with machineId ${m} and the code the page shows. The login waits 10 minutes.`,
        machineId: m,
        loginUrl: answer.loginUrl,
        message: answer.message,
      };
    }
    return { next: `claude on ${m} is logged in: its sessions can start.`, machineId: m, loggedIn: true, message: answer.message };
  });
}

const SOURCE: Record<Found, MachineHostSource> = { here: "hub", set_up: "set_up", ssh_config: "ssh_config", tailnet: "tailnet" };

/** The contracts' SshHost: what `ssh` connects to, never an option. */
const isSshHost = (s: string) => s.length > 0 && s.length <= 253 && !s.startsWith("-") && /^[A-Za-z0-9._@-]+$/.test(s);

/** Adding a machine runs commands on it and enrolls it, so it takes a person with Admin on every machine. */
function admin(caller: Caller): void {
  if (allowsEverywhere(caller, "admin") && isHuman(caller)) return;
  throw new ToolError(
    "forbidden",
    "Adding and removing machines is for the hub's owners and admins, from their own device.",
    adminEverywhereFix(caller),
  );
}

/** A Stop as the tool's error: a usage error is `invalid`, anything else `failed`. */
function stopError(stop: Stop): ToolError {
  const [message, fix] = splitFix(stop.message);
  return new ToolError(stop.code === 2 ? "invalid" : "failed", message, fix);
}

async function stopped<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw e instanceof Stop ? stopError(e) : e;
  }
}

/** The ssh_config file a machine at `host` was set up with (`machine add --ssh-config`), so a repair or a retry
 * connects as the first run did, and its record keeps it. */
function recordedSshConfig(hub: Hub, host: string, machineId: string | undefined): string | undefined {
  let machines;
  try {
    machines = readSetup(hub.config.home)?.machines;
  } catch {
    return undefined;
  }
  for (const [id, r] of Object.entries(machines ?? {})) {
    if (!r.local && r.sshHost === host && (machineId === undefined || machineId === id) && r.sshConfig) return r.sshConfig;
  }
  return undefined;
}

/** `machine add <host>` or `--local`, as the hub runs it: its own home, its own enrollment, and the ssh_config the
 * machine was set up with before. */
function resolve(hub: Hub, host: string | undefined, machineId: string | undefined): Resolved {
  let exe: string;
  try {
    exe = machineSetup(hub).ports.exe();
  } catch (e) {
    throw new ToolError("failed", e instanceof Error ? e.message : String(e));
  }
  const sshConfig = host === undefined ? undefined : recordedSshConfig(hub, host, machineId);
  const args: AddArgs = {
    ...(host !== undefined ? { host } : {}),
    ...(machineId !== undefined ? { machineId } : {}),
    dryRun: false,
    ...(sshConfig !== undefined ? { sshConfig } : {}),
    home: hub.config.home,
    enroll: { kind: "hub" },
    noService: false,
    mac: false,
  };
  try {
    return machine.resolve(args, exe);
  } catch (e) {
    throw e instanceof Stop ? stopError(e) : e;
  }
}

/** The hub's database for `machine add` and `remove`, which erases a removed machine's projects as deleting each would. */
const side = (hub: Hub, by: string): HubSide => ({ db: hub.db, home: hub.config.home, by, erase: eraseIn });

/** The tool and the key that called it: who minted an enroll code, so a burst of them shows its caller in the log. */
const by = (tool: string, caller: Caller) => `${tool}, key ${caller.keyId} (${caller.name})`;

function joined(hub: Hub, machineId: string): boolean {
  return isMachineId(machineId) && store(hub).machineGet(machineId) !== undefined;
}

/** Collects what a run reports, for a tool that answers once it is over. */
const collect = (steps: Steps): Progress => recorder(steps);

/** A removal that would undo something: a machine_add run for the machine still going (the removal would undo it
 * halfway), or the machine runs projects' leads (they would stop). Refused, with what it would undo and the way to
 * repair instead; `force` removes it anyway (the app's Remove anyway). */
function refuseRemoval(hub: Hub, machineId: string): void {
  const why: string[] = [];
  const run = machineSetup(hub)
    .runs()
    .find((r) => r.machineId === machineId && r.state === "running");
  if (run) why.push(`${machineId} is being added right now (run ${run.runId}, since ${run.startedAt}): removing it undoes that run halfway`);
  let leads: string | undefined;
  try {
    leads = machine.leadsOn(side(hub, "machine_remove"), machineId);
  } catch (e) {
    throw e instanceof Stop ? stopError(e) : new ToolError("failed", e instanceof Error ? e.message : String(e));
  }
  if (leads !== undefined) why.push(leads);
  if (why.length === 0) return;
  throw new ToolError(
    "invalid",
    `${why.join("; ")}.`,
    `${machine.repair(machineId)}; to remove it anyway, call machine_remove again with force: true (Remove anyway in the app)`,
  );
}
