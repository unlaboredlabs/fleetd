// `fleetd init` and `fleetd uninstall`. `init` without a terminal and without
// --yes (or --join) only sets up the hub, as scripts expect: setup.json, and unless --no-service the user service
// that runs it. The wizard (a terminal, --yes, --join, --step) is listed as not ported in PORT_MAP.md.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NotImplemented } from "../../shared/errors.ts";
import { fleetdDir } from "../../shared/home.ts";
import { ArgError, parse } from "../args.ts";
import { type Failure, type GitIdentity, ioMessage, isLiveHubHome, isNoreply, liveHubRefusal, mkdirPrivate, parseGitIdentity, readSetup, resolveHome, type SetupState, writeSetup } from "../common.ts";
import { currentExe, DEFAULT_LISTEN, localDirs, localPlatform, localUid, parseListen, type Probe, probeListen, processesHolding, say, SETUP_USAGE } from "./shared.ts";
import { type InitOptions, joinedHere, openStep, run } from "./wizard.ts";
import { foreignUnit, renderUnit, ServiceManager, type ServiceSpec, systemdName, unitPath } from "./units.ts";

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

/** What `fleetd init` does about the hub, from what it found. */
export function hubAction(withService: boolean, unit: Unit, holders: number[], probe: Probe, listen: string, home: string): HubAction {
  const pids = holders.join(", ");
  const busy = (what: string): Failure => ({
    message: `${listen} is in use by ${what}`,
    fix: "pick a free address: fleetd init --listen 127.0.0.1:4791",
  });
  const held = holders.length > 0;
  if (withService && held && unit === "missing") {
    return {
      message: `a hub started by hand runs on ${home} (pid ${pids})`,
      fix: `stop it (kill ${pids}), then run fleetd init again; or keep running it yourself: fleetd init --no-service`,
    };
  }
  if (withService && held && probe === "hub" && unit === "same") return "keep";
  if (withService && held) return "install";
  if (!withService && held && probe === "hub") return "by_hand";
  if (!withService && held) {
    return {
      message: `a hub runs on ${home} (pid ${pids}) but does not answer at ${listen}`,
      fix: `run fleetd init --no-service --listen <the address it listens on>, or stop it (kill ${pids})`,
    };
  }
  if (probe === "free") return withService ? "install" : "not_running";
  return busy(probe === "hub" ? "another fleetd hub" : "something else");
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
      message: `fleetd runs the hub as a systemd or launchd service, not on ${process.platform}`,
      fix: "fleetd init --no-service, then run fleetd hub start yourself",
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
    throw { message: `${unitFile} runs another fleet's hub`, fix: "pass --no-service to run the hub yourself" } satisfies Failure;
  }
  const holders = processesHolding(join(plan.home, "hub.sqlite"));
  let action = hubAction(plan.withService, unit, holders, await probeListen(listen), plan.listen, plan.home);
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
    return `not started; run it yourself with: fleetd hub start --home ${plan.home} --listen ${plan.listen}`;
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
          ? `systemctl --user status ${systemdName("hub")} shows why. Without a user systemd (a container, WSL), fleetd init --no-service prints how to run the hub yourself`
          : `see ${spec.logPath}`,
    } satisfies Failure;
  }
  const deadline = Date.now() + 30_000;
  while ((await probeListen(listen)) !== "hub") {
    if (Date.now() > deadline) {
      throw {
        message: `the hub service did not answer at ${plan.listen} within 30 s`,
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
    return usage(`--url must be the hub's address, e.g. https://devbox.tailnet.ts.net, got '${url}'`);
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
  say(`hub home ${opts.home}`);
  if (identity === undefined) {
    say(`no commit identity yet: add one with --git-identity "Name <id+user@users.noreply.github.com>" before adding machines`);
  } else {
    say(`commit identity ${identity.name} <${identity.email}>${isNoreply(identity) ? "" : " (not a GitHub noreply address: commits in public repos will show it)"}`);
  }
  try {
    const how = await installHub({ home: opts.home, listen, url, ...(identity ? { identity } : {}), withService: opts.withService, restart: false }, say);
    say(`the hub ${how}`);
  } catch (f) {
    const failure = f as Failure;
    if (typeof failure?.message !== "string" || f instanceof Error) throw f;
    return fail(`${failure.message}. Fix: ${failure.fix}`);
  }
  say("next: run fleetd init in a terminal to add workers, a first project and the desktop app (fleetd init --yes takes every default)");
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

export async function uninstallCommand(argv: string[]): Promise<number> {
  const v = parse(argv, { options: { purge: "bool" }, positionals: false });
  if (v instanceof ArgError) return usage(v.message);
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
    const file = unitPath(platform, localDirs(), "hub");
    let existing: string | undefined;
    try {
      existing = readFileSync(file, "utf8");
    } catch {}
    if (foreignUnit(existing, home)) {
      say(`left ${file} alone: it runs another fleet's hub, not the one in ${home}`);
    } else if (existing !== undefined) {
      const uid = localUid();
      try {
        await sh(new ServiceManager(platform, uid, () => file).remove("hub"), say);
      } catch (error) {
        return fail((error as Error).message);
      }
      try {
        rmSync(file);
      } catch (error) {
        return fail(`cannot remove ${file}: ${ioMessage(error)}`);
      }
      say(`removed ${file}`);
      if (platform === "linux") await sh(`XDG_RUNTIME_DIR=/run/user/${uid} systemctl --user daemon-reload`, say).catch(() => {});
    } else {
      say(`no hub service at ${file}`);
    }
  }
  const machines = Object.keys(state?.machines ?? {});
  if (machines.length > 0) {
    say(`machines still set up from this hub: ${machines.join(", ")} (fleetd machine remove <id> undoes each)`);
  }
  if (!v.flag("purge")) {
    say(`kept the hub's data in ${home}; fleetd init starts it again, --purge deletes it`);
    return 0;
  }
  if (!existsSync(join(home, "hub.sqlite")) && state === undefined) {
    return fail(`${home} does not look like a hub home (no hub.sqlite or setup.json); not deleting it`);
  }
  const holders = processesHolding(join(home, "hub.sqlite"));
  if (holders.length > 0) return fail(`a hub still runs on ${home} (pid ${holders.join(", ")}); stop it before --purge`);
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (error) {
    return fail(`cannot delete ${home}: ${ioMessage(error)}`);
  }
  say(`deleted ${home}`);
  return 0;
}
