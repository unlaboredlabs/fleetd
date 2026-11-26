// `fleetd init` and `fleetd uninstall`. `init` without a terminal and without
// --yes (or --join) only sets up the hub, as scripts expect: setup.json, and unless --no-service the user service
// that runs it. The wizard (a terminal, --yes, --join, --step) is listed as not ported in PORT_MAP.md.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { NotImplemented } from "../../shared/errors.ts";
import { fleetdDir, relocated } from "../../shared/home.ts";
import { settingsPath } from "../../shared/settings_path.ts";
import { ArgError, parse } from "../args.ts";
import { type Failure, type GitIdentity, ioMessage, isLiveHubHome, isNoreply, liveHubRefusal, mkdirPrivate, parseGitIdentity, readSetup, resolveHome, type SetupState, writeSetup } from "../common.ts";
import { keyDir, VaultKeys } from "../../hub/vault/keys.ts";
import { machineLayout, machineLayoutAt, planMachineRemove } from "./machine_plan.ts";
import { currentExe, DEFAULT_LISTEN, listeners, localDirs, localPlatform, localUid, parseListen, type Platform, type Probe, probeListen, processesHolding, say, SETUP_USAGE } from "./shared.ts";
import { type InitOptions, joinedHere, openStep, run } from "./wizard.ts";
import { foreignUnit, managerDropIn, renderUnit, ServiceManager, type ServiceSpec, systemdName, undoManagerScript, unitPath } from "./units.ts";

const STEPS = ["address", "machines", "claude", "github", "onepassword", "people", "mac"];

function fail(message: string): number {
  say(`fleetd: ${message}`);
  return 1;
}
function usage(message: string): number {
  say(`fleetd: ${message}\n\nusage:\n${SETUP_USAGE}`);
  return 2;
}

/** Runs `command` with /bin/sh, `log` hearing it first. Throws the failure's words. */
async function sh(command: string, log: (line: string) => void) {
  log(`  $ ${command}`);
  const proc = Bun.spawn(["/bin/sh", "-c", command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${command} failed (exit ${code}): ${stderr.trim()}`);
}

function serviceFailure(said: string): string {
  const at = said.indexOf("): ");
  const why = at < 0 ? "" : said.slice(at + 3).trim();
  return why === "" ? "service didn't start" : `service didn't start: ${why}`;
}

/** The hub service runs this very binary. */
export function hubServiceSpec(home: string, listen: string, exe: string, path: string, userHome: string): ServiceSpec {
  return {
    role: "hub",
    description: "fleetd hub",
    program: [exe, "hub", "start", "--home", home, "--listen", listen],
    env: [
      ["HOME", userHome],
      ["PATH", path],
      ["LANG", "C.UTF-8"],
    ],
    workingDirectory: home,
    logPath: `${home}/hub.log`,
  };
}

type Unit = "missing" | "same" | "changed";
type HubAction = "install" | "keep" | "by_hand" | "not_running" | Failure;

/** What holds the hub's address when something else does: the program seen listening there (`by`, "nginx (pid
 * 812)"), and the command that moves the hub to a free port on the same address (`move`). */
export type Busy = { by?: string; move?: string };

/** What `fleetd init` does about the hub, from what it found. */
export function hubAction(
  withService: boolean,
  unit: Unit,
  holders: number[],
  probe: Probe,
  listen: string,
  home: string,
  taken: Busy = {},
): HubAction {
  const pids = holders.join(", ");
  // Never onto another address: a hub on the LAN or the tailnet moved to 127.0.0.1 is out of its devices' reach.
  const busy = (what: string): Failure => ({
    message: `${listen} is in use by ${what}${taken.by === undefined ? "" : `: ${taken.by}`}`,
    fix: `stop it, and the workspace's service starts again by itself within seconds; or move the workspace to another port on the same address: ${taken.move ?? `fleetd init --listen ${listen.slice(0, listen.lastIndexOf(":") + 1)}<free port>`} (paired devices then reach it there)`,
  });
  const held = holders.length > 0;
  // A program seen on the port that isn't this home's hub: so whatever this hub's service does (it starts again every
  // 5 s, and may hold its database just then), it can't listen there.
  if (probe === "other" && taken.by !== undefined) return busy("something else");
  if (withService && held && unit === "missing") {
    return {
      message: `a workspace started by hand runs on ${home} (pid ${pids})`,
      fix: `stop it (kill ${pids}), then run fleetd init again; or keep running it yourself: fleetd init --no-service`,
    };
  }
  if (withService && held && probe === "hub" && unit === "same") return "keep";
  if (withService && held) return "install";
  if (!withService && held && probe === "hub") return "by_hand";
  if (!withService && held) {
    return {
      message: `a workspace runs on ${home} (pid ${pids}) but does not answer at ${listen}`,
      fix: `run fleetd init --no-service --listen <the address it listens on>, or stop it (kill ${pids})`,
    };
  }
  if (probe === "free") return withService ? "install" : "not_running";
  return busy(probe === "hub" ? "another fleetd workspace" : "something else");
}

/** Who holds `listen` besides this fleet's hub (`hubs`, the processes with its database open), and the first free port after it on the same host, as `fleetd init`
 * would be told to move there (with `url`'s port moved along when it was the same). */
async function taken([host, port]: [string, number], url: string, hubs: number[]): Promise<Busy> {
  const held = listeners(port).filter((l) => l.pid !== process.pid && !hubs.includes(l.pid));
  const by = held.length === 0 ? undefined : held.map((l) => `${l.name || "a program"} (pid ${l.pid})`).join(", ");
  let free = port + 1;
  while (free < port + 20 && (await probeListen([host, free])) !== "free") free++;
  if (free >= port + 20) return by === undefined ? {} : { by };
  const h = host.includes(":") ? `[${host}]` : host;
  let move = `fleetd init --listen ${h}:${free}`;
  try {
    const u = new URL(url);
    if (u.port === String(port)) {
      u.port = String(free);
      move += ` --url ${u.toString().replace(/\/$/, "")}`;
    }
  } catch {}
  return { ...(by === undefined ? {} : { by }), move };
}

export type HubPlan = { home: string; listen: string; url: string; identity?: GitIdentity; withService: boolean; restart: boolean };

/** The hub home, setup.json and, unless --no-service, the user service that runs the hub; how the hub runs now. */
export async function installHub(plan: HubPlan, log: (line: string) => void): Promise<string> {
  const failure = (message: string): Failure => ({ message, fix: "fix the cause above, then run fleetd init again" });
  const listen = parseListen(plan.listen);
  if (!listen) throw { message: `--listen must be host:port, got '${plan.listen}'`, fix: "fleetd init --listen 127.0.0.1:4790" } satisfies Failure;
  const platform = localPlatform();
  if (plan.withService && platform === undefined) {
    throw {
      message: `fleetd runs the workspace as a systemd or launchd service, not on ${process.platform}`,
      fix: "fleetd init --no-service, then run fleetd workspace start yourself",
    } satisfies Failure;
  }
  const dirs = localDirs();
  const unitFile = platform === undefined ? undefined : unitPath(platform, dirs, "hub");
  let exe: string;
  try {
    exe = currentExe();
  } catch (error) {
    throw failure((error as Error).message);
  }
  const path = `${dirname(exe)}:${process.env.PATH ?? ""}`;
  const spec = hubServiceSpec(plan.home, plan.listen, exe, path, dirs.home);
  const text = platform === undefined ? undefined : renderUnit(platform, spec);
  let existing: string | undefined;
  try {
    existing = unitFile === undefined ? undefined : readFileSync(unitFile, "utf8");
  } catch {}
  const unit: Unit = existing === undefined ? "missing" : existing === text ? "same" : "changed";
  if (plan.withService && foreignUnit(existing, plan.home) && unitFile !== undefined) {
    throw { message: `${unitFile} runs another fleet's workspace`, fix: "pass --no-service to run the workspace yourself" } satisfies Failure;
  }
  const holders = processesHolding(join(plan.home, "hub.sqlite"));
  const probe = await probeListen(listen);
  let action = hubAction(plan.withService, unit, holders, probe, plan.listen, plan.home, probe === "free" ? {} : await taken(listen, plan.url, holders));
  if (typeof action === "object") throw action;
  if (action === "keep" && plan.restart) action = "install";
  try {
    mkdirPrivate(plan.home);
    let machines: SetupState["machines"] = {};
    try {
      machines = readSetup(plan.home)?.machines ?? {};
    } catch {}
    writeSetup(plan.home, {
      listen: plan.listen,
      url: plan.url,
      ...(plan.identity === undefined ? {} : { gitIdentity: plan.identity }),
      machines,
    });
  } catch (error) {
    throw failure((error as Error).message);
  }
  if (action === "keep") return `runs as a service and answers at ${plan.listen}`;
  if (action === "by_hand") return `answers at ${plan.listen}; you run it yourself`;
  if (action === "not_running") {
    return `not started; run it yourself with: fleetd workspace start --home ${plan.home} --listen ${plan.listen}`;
  }
  try {
    mkdirSync(dirname(unitFile!), { recursive: true });
    writeFileSync(unitFile!, text!);
  } catch (error) {
    throw failure(`cannot write ${unitFile}: ${ioMessage(error)}`);
  }
  log(`${unit === "same" ? "kept" : "wrote"} ${unitFile}`);
  try {
    await sh(new ServiceManager(platform!, localUid(), () => unitFile!).restart("hub", unit === "changed"), log);
  } catch (error) {
    throw {
      message: serviceFailure((error as Error).message),
      fix:
        platform === "linux"
          ? `systemctl --user status ${systemdName("hub")} shows why. Without a user systemd (a container, WSL), fleetd init --no-service prints how to run the workspace yourself`
          : `see ${spec.logPath}`,
    } satisfies Failure;
  }
  const deadline = Date.now() + 30_000;
  while ((await probeListen(listen)) !== "hub") {
    if (Date.now() > deadline) {
      throw {
        message: `the workspace service did not answer at ${plan.listen} within 30 s`,
        fix: `read ${spec.logPath} for why, then run fleetd init again`,
      } satisfies Failure;
    }
    await Bun.sleep(500);
  }
  return `runs as a service and answers at ${plan.listen}`;
}


function initOptions(argv: string[]): InitOptions | number {
  const v = parse(argv, {
    options: {
      listen: "str",
      url: "str",
      "git-identity": "str",
      "no-service": "bool",
      yes: "bool",
      join: "str",
      code: "str",
      "machine-id": "str",
      rejoin: "bool",
      mac: "bool",
      "claude-config-dir": "str",
      step: "str",
    },
    positionals: false,
  });
  if (v instanceof ArgError) return usage(v.message);
  const home = resolveHome();
  let previous: SetupState | undefined;
  try {
    previous = readSetup(home);
  } catch (error) {
    return fail((error as Error).message);
  }
  const listen = v.str("listen");
  if (listen !== undefined && !parseListen(listen)) return usage(`--listen must be host:port, got '${listen}'`);
  const url = v.str("url");
  if (url !== undefined && !URL.canParse(url)) {
    return usage(`--url must be the workspace's address, e.g. https://devbox.tailnet.ts.net, got '${url}'`);
  }
  const idText = v.str("git-identity");
  const identity = idText === undefined ? undefined : parseGitIdentity(idText);
  if (idText !== undefined && identity === undefined) {
    return usage(`--git-identity must look like "Name <email>", got '${idText}'`);
  }
  const [joinHub, code] = [v.str("join"), v.str("code")];
  if ((joinHub === undefined) !== (code === undefined)) {
    return usage("--join and --code go together: both are in what fleetd pair --worker prints");
  }
  if (v.flag("mac") && joinHub === undefined) {
    return usage("--mac goes with --join and --code: the line Add machine › A Mac for agents shows");
  }
  const step = v.str("step");
  if (step !== undefined && !STEPS.includes(step)) return usage(`--step takes one of ${STEPS.join(", ")}, got '${step}'`);
  return {
    home,
    ...(previous ? { previous } : {}),
    ...(listen !== undefined ? { listen } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(identity ? { identity } : {}),
    withService: !v.flag("no-service"),
    yes: v.flag("yes"),
    ...(joinHub !== undefined ? { join: [joinHub, code!] as [string, string] } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(v.str("machine-id") === undefined ? {} : { machineId: v.str("machine-id")! }),
    rejoin: v.flag("rejoin"),
    mac: v.flag("mac"),
    ...(v.str("claude-config-dir") === undefined ? {} : { claudeConfigDir: v.str("claude-config-dir")! }),
  };
}

/** Without a terminal and without --yes: only the hub, so scripts see no prompt. */
async function initPlain(opts: InitOptions): Promise<number> {
  const listen = opts.listen ?? opts.previous?.listen ?? DEFAULT_LISTEN;
  const url = opts.url ?? opts.previous?.url ?? `http://${listen}`;
  const identity = opts.identity ?? opts.previous?.gitIdentity;
  say(`workspace home ${opts.home}`);
  if (identity === undefined) {
    say(`no commit identity yet: add one with --git-identity "Name <id+user@users.noreply.github.com>" before adding machines`);
  } else {
    say(`commit identity ${identity.name} <${identity.email}>${isNoreply(identity) ? "" : " (not a GitHub noreply address: commits in public repos will show it)"}`);
  }
  try {
    const how = await installHub({ home: opts.home, listen, url, ...(identity ? { identity } : {}), withService: opts.withService, restart: false }, say);
    say(`the workspace ${how}`);
  } catch (f) {
    const failure = f as Failure;
    if (typeof failure?.message !== "string" || f instanceof Error) throw f;
    return fail(`${failure.message}. Fix: ${failure.fix}`);
  }
  say("next: run fleetd init in a terminal to add workers, a first bot and the desktop app (fleetd init --yes takes every default)");
  return 0;
}


export async function initCommand(argv: string[]): Promise<number> {
  const opts = initOptions(argv);
  if (typeof opts === "number") return opts;
  if (isLiveHubHome(opts.home)) return fail(liveHubRefusal("fleetd init"));
  const terminal = process.stdin.isTTY === true && process.stderr.isTTY === true;
  if (opts.step !== undefined) return openStep(opts, opts.step, terminal && !opts.yes);
  // A worker that joined by itself is repaired, even from a script; only a fresh machine gets the plain hub setup.
  const joinedWorker = opts.previous === undefined && joinedHere() !== undefined;
  if (opts.yes || terminal || opts.join !== undefined || joinedWorker) return run(opts, terminal && !opts.yes);
  return initPlain(opts);
}

/** `fleetd uninstall`: everything fleetd runs on this machine stops and goes, its data stays (`--purge` deletes it).
 * The node first, with the agents it left running, then the hub, then, once no fleetd service is left, the root
 * drop-in setup wrote for the user's service manager, with linger when fleetd turned that on. A machine still running
 * this hub's node elsewhere is named, with the line that removes fleetd there. */
export async function uninstallCommand(argv: string[]): Promise<number> {
  const v = parse(argv, { options: { purge: "bool" }, positionals: false });
  if (v instanceof ArgError) return usage(v.message);
  const purge = v.flag("purge");
  const home = resolveHome();
  if (isLiveHubHome(home)) return fail(liveHubRefusal("fleetd uninstall"));
  let state: SetupState | undefined;
  try {
    state = readSetup(home);
  } catch (error) {
    return fail((error as Error).message);
  }
  const platform = localPlatform();
  if (platform !== undefined) {
    const node = await removeNode(platform, purge, state === undefined);
    if (typeof node === "number") return node;
    let removed = node.removed;
    const file = unitPath(platform, localDirs(), "hub");
    let existing: string | undefined;
    try {
      existing = readFileSync(file, "utf8");
    } catch {}
    if (foreignUnit(existing, home)) {
      say(`left ${file} alone: it runs another fleet's workspace, not the one in ${home}`);
    } else if (existing !== undefined) {
      const uid = localUid();
      try {
        await sh(new ServiceManager(platform, uid, () => file).remove("hub"), () => {});
      } catch (error) {
        return fail((error as Error).message);
      }
      try {
        rmSync(file);
      } catch (error) {
        return fail(`cannot remove ${file}: ${ioMessage(error)}`);
      }
      say(`stop and remove the workspace service (${file})`);
      removed = true;
      if (platform === "linux") await sh(`XDG_RUNTIME_DIR=/run/user/${uid} systemctl --user daemon-reload`, () => {}).catch(() => {});
    } else if (state !== undefined || existsSync(home)) {
      say(`no workspace service at ${file}`);
    }
    if (platform === "linux" && removed) await removeManagerDropIn();
  }
  const elsewhere = Object.entries(state?.machines ?? {})
    .filter(([, r]) => r.local !== true)
    .map(([id]) => id);
  if (elsewhere.length > 0) {
    say(
      `${elsewhere.join(", ")} still ${elsewhere.length === 1 ? "runs" : "run"} this workspace's node: on each, run ${UNINSTALL_LINE} (or remove it from here first: fleetd machine remove <id>)`,
    );
  }
  if (!purge) {
    if (state !== undefined || existsSync(join(home, "hub.sqlite"))) say(`kept the workspace's data in ${home}; fleetd init starts it again, --purge deletes it`);
    return 0;
  }
  // A worker or a laptop has no hub to delete.
  if (!existsSync(home)) return 0;
  if (!existsSync(join(home, "hub.sqlite")) && state === undefined) {
    return fail(`${home} does not look like a workspace home (no hub.sqlite or setup.json); not deleting it`);
  }
  const holders = processesHolding(join(home, "hub.sqlite"));
  if (holders.length > 0) return fail(`a workspace still runs on ${home} (pid ${holders.join(", ")}); stop it before --purge`);
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (error) {
    return fail(`cannot delete ${home}: ${ioMessage(error)}`);
  }
  say(`deleted ${home}`);
  // The vault's key sits beside the home, not in it: with an old copy of the database it would open every item.
  const keys = new VaultKeys(keyDir(home));
  try {
    if (await keys.destroy()) say(`deleted the vault's key in ${keys.dir}`);
  } catch (error) {
    return fail(`cannot delete the vault's key in ${keys.dir}: ${ioMessage(error)}`);
  }
  return 0;
}

/** What removes fleetd from a machine, as a person pastes it there. */
export const UNINSTALL_LINE = "curl -fsSL https://fleetd.sh | sh -s -- --uninstall";

/** This machine's node, as `machine remove` undoes it (machine_plan.ts planMachineRemove): its service stopped and
 * removed, the agents it left running stopped, and with `purge` its files deleted. A worker that joined by itself
 * (`worker`, no hub here) says where the hub still lists it. Whether a service was removed, or the exit code of a step
 * that failed. */
async function removeNode(platform: Platform, purge: boolean, worker: boolean): Promise<{ removed: boolean } | number> {
  const dirs = localDirs();
  const fleetd = relocated();
  const layout = fleetd === undefined ? machineLayout(dirs.home) : machineLayoutAt(dirs.home, fleetd);
  const file = unitPath(platform, dirs, "node");
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  if (text !== undefined && foreignUnit(text, layout.nodeHome)) {
    say(`left ${file} alone: it runs another fleet's node`);
    return { removed: false };
  }
  if (text === undefined && !(purge && existsSync(layout.nodeHome))) return { removed: false };
  let joined: { hub?: unknown; machineId?: unknown } | undefined;
  try {
    joined = JSON.parse(readFileSync(layout.nodeConfig, "utf8"));
  } catch {}
  const steps = planMachineRemove(platform, dirs.home, fleetd, dirs.configHome, localUid(), text !== undefined, purge);
  for (const [i, step] of steps.entries()) {
    const proc = Bun.spawn(["/bin/sh", "-c", step.command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) {
      const rest = steps.slice(i).map((s) => `    ${s.command}`);
      return fail(`couldn't ${step.title} (exit ${code}): ${stderr.trim()}. Fix: run the remaining steps yourself:\n${rest.join("\n")}`);
    }
    if (step.title.startsWith("forget")) continue;
    say(`${step.title}${i === 0 ? ` (${file})` : ""}${stdout.trim() === "" ? "" : `: ${stdout.trim()}`}`);
  }
  if (!purge && existsSync(layout.nodeHome)) say(`kept the node's files in ${layout.nodeHome}; --purge deletes them`);
  if (worker && typeof joined?.hub === "string" && typeof joined.machineId === "string") {
    say(`the workspace at ${joined.hub} still lists ${joined.machineId}: an admin removes it there, in ${settingsPath("Machines")}`);
  }
  return { removed: text !== undefined };
}

/** The drop-in setup writes as root so systemd starts the user's service manager again (units.ts keepManagerScript),
 * and linger when fleetd turned that on: undone once no fleetd service is left, as root where that needs no password,
 * else said with the one command. Only by an uninstall that removed one of this home's services: another fleet on this
 * machine (its own fleetd dir), or a throwaway HOME (tests, the docs' captures), shares the user and leaves them. */
async function removeManagerDropIn(): Promise<void> {
  if (relocated() !== undefined) return;
  const dirs = localDirs();
  if ((["hub", "node"] as const).some((role) => existsSync(unitPath("linux", dirs, role)))) return;
  const uid = localUid();
  const file = managerDropIn(uid);
  let dropIn: string;
  try {
    dropIn = readFileSync(file, "utf8");
  } catch {
    return;
  }
  // As the probe names the user (machine_plan.ts): userInfo() can't always.
  const user = Bun.spawnSync(["id", "-un"], { stdin: "ignore", stderr: "ignore" }).stdout.toString().trim() || userInfo().username;
  const script = undoManagerScript(user, uid, dropIn);
  const linger = script.includes("disable-linger");
  const what = `${file}${linger ? ` and linger for ${user}` : ""}`;
  const asRoot = uid === 0 ? "" : Bun.spawnSync(["sudo", "-n", "true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode === 0 ? "sudo -n " : undefined;
  if (asRoot !== undefined) await sh(`${asRoot}sh -c "${script}"`, () => {}).catch(() => {});
  // logind keeps linger as a file per user.
  const undone = !existsSync(file) && !(linger && existsSync(`/var/lib/systemd/linger/${user}`));
  say(undone ? `removed ${what}` : `left ${what}, which only root can remove: sudo sh -c "${script}"`);
  if (!linger) say(`linger stays on for ${user}, as fleetd didn't turn it on; sudo loginctl disable-linger ${user} turns it off`);
}
