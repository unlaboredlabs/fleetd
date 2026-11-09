// `fleetd machine add|remove|set`. `add` reads the machine (a read-only
// probe over SSH, or here with --local), plans what it lacks (machine_plan.ts), records it in setup.json, runs each
// step showing its command first, then waits until its node is online and checks its claude login.
//
// The hub's machine_setup (Add machine in the app) calls the same `resolve`, `prepare`, `execute`, `remove`,
// `candidates`, `leadsOn` and `repair` with its own Runner, Builds and Progress, as the Rust hub does.
import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ProjectRef } from "../../shared/contracts.ts";
import { NotImplemented } from "../../shared/errors.ts";
import { relocated } from "../../shared/home.ts";
import { VERSION } from "../../shared/version.ts";
import { build, HttpFeed, REPO, sums, type Sums, verified } from "../../update/index.ts";
import { edgeStamp } from "../../update/version.ts";
import type { HubDb } from "../../hub/store/db.ts";
import { eraseIn } from "../../hub/navi/erase.ts";
import { HubStore } from "../../hub/store/hub_store.ts";
import { ArgError, parse } from "../args.ts";
import {
  type GitIdentity,
  isMachineId,
  type MachineRecord,
  readSetup,
  resolveHome,
  type SetupState,
  writeSetup,
} from "../common.ts";
import { workerReachNote } from "../pair.ts";
import { localHostName, machineIdFromHost, machineSetCommand } from "../project.ts";
import { createEnrollToken, openHub } from "../store.ts";
import { machineUsage } from "../usages.ts";
import {
  type Facts,
  factsLayout,
  freshFacts,
  guiSessionProblem,
  localTarget,
  loginCommand,
  loginStatusCommand,
  type MachineAddInput,
  machineLayoutAt,
  type MachineLayout,
  type MachinePlan,
  noGuiSession,
  parseFacts,
  planMachineAdd,
  planMachineRemove,
  probeCommand,
  type Step,
  stepNeedsGuiSession,
} from "./machine_plan.ts";
import { currentExe, noSetupFix, parseListen, probeListen, say } from "./shared.ts";
import { type RunResult, runSsh, showSsh, type SshTarget } from "./ssh.ts";
import { foreignUnit, q, unitPath } from "./units.ts";

export { localHostName, machineIdFromHost };

function usage(message: string): number {
  say(`fleetd: ${message}\n\nusage:\n${machineUsage()}`);
  return 2;
}
function fail(message: string): number {
  say(`fleetd: ${message}`);
  return 1;
}

/** Why `machine add` or `remove` stopped, and the CLI's exit code (2 for a usage error). */
export class Stop extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
  static fail(message: string) {
    return new Stop(1, message);
  }
  print(): number {
    return this.code === 2 ? usage(this.message) : fail(this.message);
  }
}

export const tail = (text: string) => text.trim().split("\n").slice(-15).join("\n");

/** What lets the hub read a host it couldn't, as the start of a "Fix:" ending in ", ". */
export function sshFix(host: string, code: number, stderr: string): string {
  const said = stderr.toLowerCase();
  const any = (words: string[]) => words.some((w) => said.includes(w));
  if (code !== 255) return `fix what it says on ${host}, `;
  if (any(["remote host identification has changed"])) {
    return `${host}'s host key changed (reinstalled?): if you expected that, run \`ssh-keygen -R ${host} && ssh ${host} true\` here and check the new key, `;
  }
  if (any(["host key verification failed"])) return `run \`ssh ${host} true\` here, check ${host}'s host key and answer yes, `;
  if (any(["permission denied", "too many authentication failures"])) {
    return `let this machine log in with its key: \`ssh-copy-id ${host}\` here (it asks for ${host}'s password once), `;
  }
  const silent = [
    "could not resolve hostname",
    "name or service not known",
    "connection refused",
    "connection timed out",
    "operation timed out",
    "no route to host",
    "network is unreachable",
    "connection closed by remote host",
    "host is down",
  ];
  if (any(silent)) {
    return `${host} didn't answer: check it is on and awake, on this machine's network or tailnet, and has SSH on (a Mac: System Settings › General › Sharing › Remote Login); \`ssh ${host} true\` here tries it, `;
  }
  return `make \`ssh ${host} true\` work here without a password, `;
}

// ---- the ports: how a run reaches the machine and reports ----

/** Runs a command on the machine: over SSH, or here for `--local`. The hub's tests stand in a fake. */
export interface Runner {
  run(target: SshTarget, command: string, stdin?: Uint8Array): Promise<RunResult>;
}
export const ssh: Runner = { run: runSsh };

/** The fleetd build for a machine of another OS or CPU: this version's release asset, checked against SHA256SUMS. */
export interface Builds {
  digest(version: string, asset: string): Promise<string>;
  build(version: string, asset: string): Promise<Uint8Array>;
}

/** The real one: the release of `version` (`v<version>`, or for an edge build the edge release while it is still that
 * build), or the directory FLEETD_BASE_URL names. */
export const releases: Builds = {
  async digest(version, asset) {
    const [, listed] = await buildOf(version, asset);
    const digest = listed.get(asset);
    if (digest === undefined) throw new Error(missing(asset, version, "its release has none"));
    return digest;
  },
  async build(version, asset) {
    const [feed, listed] = await buildOf(version, asset);
    try {
      return await verified(feed, listed, asset);
    } catch (error) {
      throw new Error(missing(asset, version, (error as Error).message));
    }
  },
};

/** `version`'s release and its checksums: on edge, which republishes its names in place, the build and its checksums
 * from one read of its release.json; elsewhere its SHA256SUMS. */
async function buildOf(version: string, asset: string): Promise<[HttpFeed, Sums]> {
  const [feed, edge] = feedOf(version);
  let now: { cliVersion?: string; sums: Sums };
  try {
    now = edge ? await build(feed) : { sums: await sums(feed) };
  } catch (error) {
    throw new Error(missing(asset, version, (error as Error).message));
  }
  if (edge) stillHolds(now.cliVersion, version, asset);
  return [feed, now.sums];
}

const feedOf = (version: string): [HttpFeed, boolean] => {
  const [base, edge] = releaseOf(version, process.env.FLEETD_BASE_URL);
  return [new HttpFeed(base), edge];
};

/** Where fleetd `version`'s release assets are, and whether that is the rolling edge release (which holds it only
 * while its release.json still names it): `override` (FLEETD_BASE_URL) when set, else its own `v<version>` release. */
export function releaseOf(version: string, override?: string): [string, boolean] {
  if (override !== undefined && override !== "") return [override, false];
  if (edgeStamp(version) !== undefined) return [`https://github.com/${REPO}/releases/download/edge`, true];
  return [`https://github.com/${REPO}/releases/download/v${version}`, false];
}

/** The edge release holds `version` only until the next edge build: its release.json says which it is now. */
function stillHolds(now: string | undefined, version: string, asset: string) {
  if (now === version) return;
  throw new Error(
    `this hub runs fleetd ${version}, and the edge release is now ${now ?? "another build"}, so it has no ${asset} of this hub's build. Fix: update the hub (fleetd update)`,
  );
}

const missing = (asset: string, version: string, why: string) =>
  `no ${asset} of fleetd ${version} to copy to the machine: ${why.replace(/\.+$/, "")}. Fix: run a released fleetd on the hub`;

/** Where a step stands in a run, as the CLI labels it. */
export type Stage = { kind: "probe" } | { kind: "step"; index: number; total: number } | { kind: "hub" };
/** A step as it begins. */
export type Begin = { stage: Stage; title: string; command?: string; stdin?: string };

/** What `machine add` and `machine remove` report as they go: the CLI prints it, the hub streams it to the app. */
export interface Progress {
  planned?(steps: Begin[]): void;
  begin(step: Begin): void;
  done(output: string): void;
  failed(code: number, output: string, fix: string): void;
  say(line: string): void;
}

/** The CLI's: every step and its command printed before it runs. */
export const print: Progress = {
  begin(step) {
    if (step.stage.kind === "probe") say(`[probe] ${step.title}`);
    else if (step.stage.kind === "hub") say(`[hub] ${step.title}`);
    else {
      say(`[${step.stage.index}/${step.stage.total}] ${step.title}`);
      if (step.command !== undefined) say(`  $ ${step.command}`);
      if (step.stdin !== undefined) say(`    (${step.stdin})`);
    }
  },
  done(output) {
    const shown = output.trim();
    if (shown !== "" && Buffer.byteLength(shown) < 200 && !shown.includes("\n")) say(`  → ${shown}`);
  },
  failed(code, output, fix) {
    say(`  failed (exit ${code}): ${output}`);
    say(`  Fix: ${fix}`);
  },
  say,
};

/** Erases one project as deleting it would: its chat, memory, skills, files and orders (Rust: navi::erase::erase_in). */
export type Erase = (db: HubDb, home: string, r: ProjectRef) => void | Promise<void>;

/** The hub's database as `machine add` and `remove` use it: opened beside the hub by the CLI, the hub's own in its
 * tools. `by` names who runs it in the hub log's line for an enroll code. `erase` is src/hub/navi/erase.ts's
 * `eraseIn` (T2285's), which the caller imports by its literal path (a computed `import()` isn't bundled by
 * `bun build --compile`, D355); `remove` refuses without it. */
export type HubSide = { db: HubDb; home: string; by: string; erase?: Erase };

function describeStdin(step: Step, what: string, len: number): string | undefined {
  if (step.stdin === undefined) return undefined;
  if (step.stdin.kind === "binary") return `stdin: the fleetd binary ${what} (${len} bytes)`;
  if (step.stdin.kind === "enrollToken") return "stdin: one-time enroll token (not shown)";
  return `stdin: ${step.stdin.label} (${Buffer.byteLength(step.stdin.text)} bytes)`;
}

export function planStep(index: number, total: number, step: Step, what: string, len: number): Begin {
  const stdin = describeStdin(step, what, len);
  return { stage: { kind: "step", index, total }, title: step.title, command: step.command, ...(stdin === undefined ? {} : { stdin }) };
}

const waitStep = (machineId: string): Begin => ({ stage: { kind: "hub" }, title: `waiting until ${machineId} is online (up to 2 min)` });

// ---- add ----

/** Where the one-time enrollment token comes from: the hub's database, a code `fleetd pair --worker` printed, or
 * nowhere (a joined worker being repaired keeps its enrolment). */
export type Enroll = { kind: "hub" } | { kind: "token"; token: string } | { kind: "keep" };

export type AddArgs = {
  host?: string;
  machineId?: string;
  dryRun: boolean;
  hubUrl?: string;
  sshConfig?: string;
  /** The hub home, when not this machine's default. */
  home?: string;
  enroll: Enroll;
  gitIdentity?: GitIdentity;
  noService: boolean;
  claudeConfigDir?: string;
  mac: boolean;
};

/** This machine, nothing else set. */
export const localArgs = (machineId: string, service: boolean): AddArgs => ({
  machineId,
  dryRun: false,
  enroll: { kind: "hub" },
  noService: !service,
  mac: false,
});

function parseAdd(argv: string[]): AddArgs | number {
  const v = parse(argv, {
    options: {
      local: "bool",
      "machine-id": "str",
      "dry-run": "bool",
      "hub-url": "str",
      "ssh-config": "str",
      "no-service": "bool",
      "claude-config-dir": "str",
    },
    positionals: true,
  });
  if (v instanceof ArgError) return usage(v.message);
  const p = v.positionals;
  let host: string | undefined;
  if (p.length === 1 && !v.flag("local")) host = p[0];
  else if (!(p.length === 0 && v.flag("local"))) return usage("machine add takes one ssh host, or --local for this machine");
  const opt = (k: string) => v.str(k);
  return {
    ...(host === undefined ? {} : { host }),
    ...(opt("machine-id") === undefined ? {} : { machineId: opt("machine-id")! }),
    dryRun: v.flag("dry-run"),
    ...(opt("hub-url") === undefined ? {} : { hubUrl: opt("hub-url")! }),
    ...(opt("ssh-config") === undefined ? {} : { sshConfig: opt("ssh-config")! }),
    enroll: { kind: "hub" },
    noService: v.flag("no-service"),
    ...(opt("claude-config-dir") === undefined ? {} : { claudeConfigDir: opt("claude-config-dir")! }),
    mac: false,
  };
}

/** `machine add`'s arguments, checked and resolved against the hub's setup, before anything touches the machine. */
export type Resolved = {
  machineId: string;
  local: boolean;
  host: string;
  joining: boolean;
  home: string;
  state?: SetupState;
  target: SshTarget;
  input: MachineAddInput;
  binary: Uint8Array;
  exe: string;
  /** How to run it again. */
  again: string;
  enroll: Enroll;
  claudeConfigDir?: string;
};

/** The machine as its read found it, and what `machine add` will run there. */
export type Prepared = {
  facts: Facts;
  plan: MachinePlan;
  input: MachineAddInput;
  /** The release asset fetched for a machine of another OS or CPU, and its bytes; undefined: this fleetd's own. */
  fetched?: [string, Uint8Array];
};

/** The fleetd the machine gets, named, and its bytes. */
const binaryOf = (r: Resolved, p: Prepared): [string, Uint8Array] =>
  p.fetched === undefined ? [r.exe, r.binary] : [`${p.fetched[0]} ${VERSION}`, p.fetched[1]];

/** The plan's steps as they will begin, numbered. */
export function preparedSteps(r: Resolved, p: Prepared): Begin[] {
  const [what, bytes] = binaryOf(r, p);
  return p.plan.steps.map((s, i) => planStep(i + 1, p.plan.steps.length, s, what, bytes.length));
}

/** `linux-x64`, `darwin-arm64`. */
export const preparedPlatform = (p: Prepared) => `${p.facts.platform}-${p.facts.arch}`;

/** The join to run again after one that stopped before it enrolled. */
function joinAgain(a: AddArgs, hub: string, code: string, machineId: string): string {
  if (a.mac) return "the join line you pasted again (it has --mac and the hub's version)";
  let line = `fleetd init --join ${q(hub)} --code ${q(code)} --machine-id ${q(machineId)}`;
  if (a.gitIdentity) line += ` --git-identity ${q(`${a.gitIdentity.name} <${a.gitIdentity.email}>`)}`;
  if (a.claudeConfigDir !== undefined) line += ` --claude-config-dir ${q(a.claudeConfigDir)}`;
  if (a.noService) line += " --no-service";
  return line;
}

/** Checks `a` and reads what `machine add` needs from the hub's setup and from `exe`. Throws a Stop. */
export function resolve(a: AddArgs, exe: string): Resolved {
  const local = a.host === undefined;
  const host = a.host ?? "localhost";
  const machineId = a.machineId ?? machineIdFromHost(local ? localHostName() : host);
  if (!isMachineId(machineId)) throw new Stop(2, `'${machineId}' is not a machine id ([a-z0-9-]{1,32}); pass --machine-id`);
  const joining = a.enroll.kind !== "hub";
  const home = resolveHome(a.home);
  let state: SetupState | undefined;
  if (!joining) {
    try {
      state = readSetup(home);
    } catch (error) {
      throw Stop.fail((error as Error).message);
    }
    if (state === undefined) throw Stop.fail(`${home} has no hub set up. Fix: ${noSetupFix(home)}`);
  }
  const hubUrl = a.hubUrl ?? state?.url;
  if (hubUrl === undefined) throw new Stop(2, "--hub-url is required to join a hub");
  let binary: Uint8Array;
  try {
    binary = new Uint8Array(readFileSync(exe));
  } catch (error) {
    throw Stop.fail(`machine add copies the running fleetd to the machine, and ${exe} is unreadable: ${(error as Error).message}`);
  }
  const gitIdentity = a.gitIdentity ?? state?.gitIdentity;
  const input: MachineAddInput = {
    machineId,
    hubUrl,
    ...(gitIdentity === undefined ? {} : { gitIdentity }),
    binaryDigest: new Bun.CryptoHasher("sha256").update(binary).digest("hex"),
    binaryTarget: localTarget(),
    // As the Rust binary names it: its crate version.
    version: "0.0.0",
    hubHasNodeKey: false,
    service: !a.noService,
    ...(a.claudeConfigDir === undefined ? {} : { claudeConfigDir: a.claudeConfigDir }),
    mac: a.mac,
  };
  const again =
    a.enroll.kind === "token"
      ? joinAgain(a, hubUrl, a.enroll.token, machineId)
      : joining
        ? "fleetd init again"
        : local
          ? "fleetd machine add --local"
          : `fleetd machine add ${host}`;
  return {
    machineId,
    local,
    host,
    joining,
    home,
    ...(state === undefined ? {} : { state }),
    target: {
      host,
      ...(a.sshConfig === undefined ? {} : { config: isAbsolute(a.sshConfig) ? a.sshConfig : resolvePath(a.sshConfig) }),
      local,
    },
    input,
    binary,
    exe,
    again,
    enroll: a.enroll,
    ...(a.claudeConfigDir === undefined ? {} : { claudeConfigDir: a.claudeConfigDir }),
  };
}

/** `--dry-run`: the plan for a fresh machine, printed; nothing connects. */
function dryRun(r: Resolved) {
  const at = r.host.indexOf("@");
  const user = at >= 0 ? r.host.slice(0, at) : (process.env.USER ?? process.env.LOGNAME ?? "user");
  let plan: MachinePlan;
  try {
    plan = planMachineAdd(freshFacts(user, r.input.binaryTarget[1]), r.input);
  } catch (error) {
    throw Stop.fail((error as Error).message);
  }
  const shownHome = plan.layout.fleetd.endsWith("/.fleetd") ? plan.layout.fleetd.slice(0, -8) : plan.layout.fleetd;
  say(
    `dry run: nothing runs. Planned for a fresh Linux machine at ${r.host} (home ${shownHome}); a real run first reads the machine's state and leaves out what is already done:`,
  );
  const note = r.local ? undefined : workerReachNote(r.input.hubUrl);
  if (note !== undefined) say(`note: ${note}`);
  say("[probe] read the machine's state (read-only)");
  plan.steps.forEach((s, i) => print.begin(planStep(i + 1, plan.steps.length, s, r.exe, r.binary.length)));
  say(`[hub] wait until ${r.machineId} is online`);
  for (const n of plan.notes) say(`note: ${n}`);
}

/** The hub already holds a node key for the machine. */
const hasNodeKey = (db: HubDb, machineId: string) =>
  db.conn.query("SELECT 1 FROM node_keys WHERE machine_id = ?").get(machineId) !== null;

/** True once the hub has heard from the machine's node at or after `sinceMs` (online, or degraded with a reason). */
async function waitLinked(db: HubDb, machineId: string, sinceMs: number, timeoutMs: number): Promise<boolean> {
  const store = new HubStore(db);
  while (Date.now() < sinceMs + timeoutMs) {
    const m = store.machineGet(machineId) as { status?: string; lastSeenAt?: string } | undefined;
    const seen = m?.lastSeenAt === undefined ? NaN : Date.parse(m.lastSeenAt);
    if (m !== undefined && m.status !== "offline" && seen >= sinceMs) return true;
    await Bun.sleep(1000);
  }
  return false;
}

/** `claude auth status --json` says it is logged in. */
export const loggedIn = (stdout: string) => {
  try {
    return JSON.parse(stdout.trim())?.loggedIn === true;
  } catch {
    return false;
  }
};

/** Reads the machine (read-only) and plans `machine add` there; changes nothing. With `fetch`, another OS's or
 * CPU's release build is downloaded and checked as a step of its own; without (a plan), the step is only listed. */
export async function prepare(
  r: Resolved,
  hub: HubSide | undefined,
  runner: Runner,
  builds: Builds,
  fetch: boolean,
  progress: Progress,
): Promise<Prepared> {
  progress.say(`setting up ${r.machineId}${r.local ? "" : ` on ${r.host}`}; every command is shown before it runs.`);
  const note = r.local ? undefined : workerReachNote(r.input.hubUrl);
  if (note !== undefined) progress.say(`note: ${note}`);
  progress.begin({ stage: { kind: "probe" }, title: "read the machine's state (read-only)" });
  const probed = await runner.run(r.target, probeCommand(r.local ? relocated() : undefined));
  let facts: Facts;
  try {
    if (probed.code !== 0) throw undefined;
    facts = parseFacts(probed.stdout);
  } catch (error) {
    const why = probed.code === 0 && error instanceof Error ? error.message : tail(probed.stderr);
    throw Stop.fail(
      `cannot read ${r.host}${r.local ? "" : " over SSH"} (exit ${probed.code}): ${why}\nFix: ${r.local ? "" : sshFix(r.host, probed.code, probed.stderr)}then run ${r.again}`,
    );
  }
  progress.done("");
  const input: MachineAddInput = {
    ...r.input,
    hubHasNodeKey: r.enroll.kind === "keep" || (hub !== undefined && hasNodeKey(hub.db, r.machineId)),
  };
  let fetched: [string, Uint8Array] | undefined;
  let listed: Begin | undefined;
  const target: [string, string] = [facts.platform, facts.arch];
  // The release's builds: fleetd-bun-<os>-<arch> for Linux and macOS, x64 and arm64 (.github/release/bun-build.sh).
  const buildable = (target[0] === "linux" || target[0] === "darwin") && (target[1] === "x64" || target[1] === "arm64");
  if ((target[0] !== input.binaryTarget[0] || target[1] !== input.binaryTarget[1]) && buildable) {
    const asset = `fleetd-bun-${target[0]}-${target[1]}`;
    const again = (e: unknown) => Stop.fail(`${e instanceof Error ? e.message : String(e)}, then run ${r.again}`);
    const wanted = await builds.digest(VERSION, asset).catch((e: unknown) => {
      throw again(e);
    });
    const has = facts.digests.get(factsLayout(facts).bin) === wanted;
    const step: Begin = {
      stage: { kind: "hub" },
      title: `download fleetd ${VERSION} for ${target[0]}-${target[1]} (this hub's is a ${input.binaryTarget[0]}-${input.binaryTarget[1]} build), checked against its release's SHA256SUMS`,
    };
    if (!has && fetch) {
      progress.begin(step);
      const bytes = await builds.build(VERSION, asset).catch((e: unknown) => {
        throw again(e);
      });
      if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== wanted) {
        throw again(new Error(`the release's ${asset} changed while it was being read (a new edge build?)`));
      }
      progress.done("");
      fetched = [asset, bytes];
    } else if (!has) listed = step;
    input.binaryDigest = wanted;
    input.binaryTarget = target;
  }
  const gui = guiSessionProblem(facts, input.service, r.joining);
  if (gui !== undefined) throw Stop.fail(`${gui}, then run ${r.again}.`);
  let plan: MachinePlan;
  try {
    plan = planMachineAdd(facts, input);
  } catch (error) {
    throw Stop.fail(`${(error as Error).message}, then run ${r.again}`);
  }
  // Never stop or re-enrol a joined node without a fresh code: that is what --join with --rejoin is for.
  if (r.enroll.kind === "keep" && plan.steps.some((s) => s.stdin?.kind === "enrollToken")) {
    throw Stop.fail(
      `this machine's node is no longer enrolled with ${input.hubUrl} as ${r.machineId}. Fix: on the hub, run fleetd pair --worker ${r.machineId}, then run what it prints here with --rejoin`,
    );
  }
  const prepared: Prepared = { facts, plan, input, ...(fetched === undefined ? {} : { fetched }) };
  const steps = [...(listed ? [listed] : []), ...preparedSteps(r, prepared)];
  if (plan.runByHand === undefined && hub !== undefined) steps.push(waitStep(r.machineId));
  progress.planned?.(steps);
  return prepared;
}

/** What a finished `machine add` set up, for `fleetd init` to check and fix fleetd's Claude login there. */
export type Added = {
  machineId: string;
  target: SshTarget;
  layout: MachineLayout;
  claude: string;
  loggedIn: boolean;
  runByHand?: string;
  claudeConfigDir?: string;
  notes: string[];
};

/** Runs the plan `prepare` made: records the machine, runs each step, waits until its node is online, checks claude. */
export async function execute(
  r: Resolved,
  p: Prepared,
  hub: HubSide | undefined,
  runner: Runner,
  progress: Progress,
): Promise<Added> {
  const [what, binary] = binaryOf(r, p);
  const { facts, plan, input } = p;
  // Recorded before anything changes, so `machine remove` can undo a run that stopped half way.
  if (r.state !== undefined) {
    const record: MachineRecord = {
      sshHost: r.host,
      ...(r.target.config === undefined ? {} : { sshConfig: r.target.config }),
      ...(r.local ? { local: true } : {}),
      platform: plan.platform,
      home: facts.home,
      configHome: facts.configHome,
      uid: facts.uid,
    };
    try {
      writeSetup(r.home, { ...r.state, machines: { ...r.state.machines, [r.machineId]: record } });
    } catch (error) {
      throw Stop.fail((error as Error).message);
    }
  }
  let stepsDone = Date.now();
  for (const [i, step] of plan.steps.entries()) {
    progress.begin(planStep(i + 1, plan.steps.length, step, what, binary.length));
    let stdin: Uint8Array | undefined;
    if (step.stdin?.kind === "text") stdin = new TextEncoder().encode(step.stdin.text);
    else if (step.stdin?.kind === "binary") stdin = binary;
    else if (step.stdin?.kind === "enrollToken") {
      if (r.enroll.kind === "token") stdin = new TextEncoder().encode(`${r.enroll.token}\n`);
      else if (r.enroll.kind === "hub" && hub !== undefined) {
        try {
          stdin = new TextEncoder().encode(`${createEnrollToken(hub.db, r.machineId).token}\n`);
        } catch (error) {
          throw Stop.fail((error as Error).message);
        }
      } else throw new Error("only a hub or a code enrolls");
    }
    const result = await runner.run(r.target, step.command, stdin);
    if (result.code !== 0 && stepNeedsGuiSession(plan.platform, result.code)) {
      throw Stop.fail(`${noGuiSession(facts.user, r.joining)}, then run ${r.again}; finished steps are skipped.`);
    }
    if (result.code !== 0) {
      const fix =
        step.stdin?.kind === "enrollToken" && r.joining
          ? "the code is single use and lasts 15 minutes: on the hub, run fleetd pair --worker for a new one"
          : `fix that, then run ${r.again}; finished steps are skipped`;
      throw Stop.fail(`step ${i + 1} failed (exit ${result.code}):\n${tail(`${result.stdout}\n${result.stderr}`)}\nFix: ${fix}.`);
    }
    stepsDone = Date.now();
    progress.done(result.stdout);
  }
  if (plan.runByHand !== undefined) {
    progress.say(
      `${r.machineId} is enrolled; with --no-service, start its node yourself${r.local ? "" : ` on ${r.host}`}:\n  ${plan.runByHand}`,
    );
  } else if (hub !== undefined) {
    const m = new HubStore(hub.db).machineGet(r.machineId) as { status?: string } | undefined;
    const already = !plan.nodeRestarts && m !== undefined && m.status !== "offline";
    if (!already) {
      progress.begin(waitStep(r.machineId));
      if (!(await waitLinked(hub.db, r.machineId, stepsDone, 120_000))) {
        throw Stop.fail(
          `${r.machineId} did not come online within 2 min. Its node log is ${plan.layout.logs}/node.log on ${r.host}; the node must reach the hub at ${input.hubUrl}. Fix: make that address reachable from ${r.host} (fleetd init --url <address>), then run ${r.again}`,
        );
      }
      progress.done("");
    }
    progress.say(`${r.machineId} is online.`);
  }
  const claude = facts.claude ?? "";
  const ok =
    r.input.mac || loggedIn((await runner.run(r.target, loginStatusCommand(plan.layout, claude, r.claudeConfigDir))).stdout);
  const notes = [...plan.notes];
  if (!ok) {
    const login = loginCommand(claude, r.claudeConfigDir);
    notes.push(
      `claude on ${r.machineId} is not logged in, so its sessions can't start. Fix: ${r.local ? login : `ssh -t ${r.host} ${q(login)}`}`,
    );
  }
  for (const n of notes) progress.say(`note: ${n}`);
  return {
    machineId: r.machineId,
    target: r.target,
    layout: plan.layout,
    claude,
    loggedIn: ok,
    ...(plan.runByHand === undefined ? {} : { runByHand: plan.runByHand }),
    ...(r.claudeConfigDir === undefined ? {} : { claudeConfigDir: r.claudeConfigDir }),
    notes,
  };
}

/** `machine add`, returning what it set up (undefined for a dry run); throws a Stop. */
export async function add(a: AddArgs, progress: Progress = print): Promise<Added | undefined> {
  let exe: string;
  try {
    exe = currentExe();
  } catch (error) {
    throw Stop.fail((error as Error).message);
  }
  const r = resolve(a, exe);
  if (a.dryRun) {
    dryRun(r);
    return undefined;
  }
  let db: HubDb | undefined;
  if (!r.joining) {
    const listen = parseListen(r.state!.listen) ?? ["", 0];
    if ((await probeListen(listen)) !== "hub") {
      throw Stop.fail(`no hub answers at ${listen[0]}:${listen[1]}. Fix: fleetd init (it starts the hub), then run ${r.again}`);
    }
    db = openHub(r.home);
  }
  try {
    const side: HubSide | undefined = db === undefined ? undefined : { db, home: r.home, by: "the fleetd CLI (machine add or init)" };
    const prepared = await prepare(r, side, ssh, releases, true, progress);
    return await execute(r, prepared, side, ssh, progress);
  } finally {
    db?.conn.close();
  }
}

/** A worker joining by itself (`fleetd init --join`), or repaired after it did: `machine add --local` against a hub
 * this machine reaches but whose database it doesn't hold. */
export async function join(hubUrl: string, enroll: Enroll, args: AddArgs, progress: Progress = print): Promise<Added> {
  const { home: _home, host: _host, ...rest } = args;
  void _home;
  void _host;
  return (await add({ ...rest, hubUrl, enroll }, progress))!;
}

// ---- remove ----

export type Removed = { revoked: boolean; remoteOk: boolean };

/** `machine remove`: stops and removes the node's service on a machine `machine add` set up (with `purge` its files
 * too), then erases its projects, revokes its key on the hub and forgets it. A step that fails is reported with the
 * steps left to run by hand, and the key is revoked anyway. */
export async function remove(
  home: string,
  machineId: string,
  purge: boolean,
  hub: HubSide,
  runner: Runner,
  progress: Progress,
): Promise<Removed> {
  const erase = hub.erase;
  if (erase === undefined) throw new NotImplemented("src/hub/navi/erase.ts: erasing a removed machine's projects");
  let state: SetupState | undefined;
  try {
    state = readSetup(home);
  } catch (error) {
    throw Stop.fail((error as Error).message);
  }
  const record = state?.machines[machineId];
  let remoteOk = true;
  if (record === undefined) {
    progress.say(
      `${machineId} was not set up by fleetd machine add from this hub, so only its key is revoked here; stop its node by hand.`,
    );
  } else {
    const target: SshTarget = {
      host: record.sshHost,
      ...(record.sshConfig ? { config: record.sshConfig } : {}),
      local: record.local === true,
    };
    const fleetd = record.local ? relocated() : undefined;
    let ownService = true;
    if (fleetd !== undefined) {
      const unit = unitPath(record.platform, { home: record.home, configHome: record.configHome }, "node");
      let text: string | undefined;
      try {
        text = readFileSync(unit, "utf8");
      } catch {}
      ownService = !foreignUnit(text, machineLayoutAt(record.home, fleetd).nodeHome);
      if (!ownService) progress.say(`left ${unit} alone: it runs another fleet's node`);
    }
    const steps = planMachineRemove(record.platform, record.home, fleetd, record.configHome, record.uid, ownService, purge);
    const begins = steps.map((s, i) => planStep(i + 1, steps.length, s, "", 0));
    progress.planned?.(begins);
    for (const [i, begin] of begins.entries()) {
      progress.begin(begin);
      const result = await runner.run(target, steps[i]!.command);
      if (result.code !== 0) {
        remoteOk = false;
        const rest = steps.slice(i).map((s) => `    ${showSsh(target, s.command)}`);
        progress.failed(result.code, tail(result.stderr), `run the remaining steps yourself:\n${rest.join("\n")}`);
        break;
      }
      progress.done(result.stdout);
    }
  }
  const store = new HubStore(hub.db);
  let erased: number;
  let revoked: boolean;
  let rows: number;
  try {
    const projects = store.projectsList(machineId);
    for (const p of projects) await erase(hub.db, home, { machineId, projectId: p.projectId } as ProjectRef);
    erased = projects.length;
    revoked = hub.db.conn.query("DELETE FROM node_keys WHERE machine_id = ?").run(machineId).changes > 0;
    rows = store.machineRemove(machineId);
  } catch (error) {
    if (error instanceof NotImplemented) throw error;
    throw Stop.fail((error as Error).message);
  }
  progress.say(
    revoked ? `revoked ${machineId}'s node key; the hub refuses that node from now on.` : `the hub held no node key for ${machineId}.`,
  );
  if (erased === 1) progress.say(`erased ${machineId}'s project: its chat, memory, skills, files, orders and tasks.`);
  else if (erased > 1) progress.say(`erased ${machineId}'s ${erased} projects: their chats, memory, skills, files, orders and tasks.`);
  if (rows > 0) {
    progress.say(
      `the hub forgot ${machineId}'s sessions, checkouts and settings (${rows} rows); the factory metrics stay as history.`,
    );
  }
  if (state !== undefined && record !== undefined) {
    const machines = { ...state.machines };
    delete machines[machineId];
    try {
      writeSetup(home, { ...state, machines });
    } catch (error) {
      throw Stop.fail((error as Error).message);
    }
  }
  if (record !== undefined && !purge) {
    progress.say(`fleetd's Claude login and the node's files stay on ${record.sshHost}; --purge deletes them.`);
  }
  return { revoked, remoteOk };
}

/** What removing the machine stops, when it runs projects' leads; undefined when it runs none. `machine remove` and
 * the app's Remove refuse it unless forced. */
export function leadsOn(hub: HubSide, machineId: string): string | undefined {
  const titles = new HubStore(hub.db).machineLeadProjects(machineId);
  if (titles.length === 0) return undefined;
  let named = titles.slice(0, 5).join(", ");
  if (titles.length > 5) named += ` and ${titles.length - 5} more`;
  const projects = titles.length === 1 ? "1 project" : `${titles.length} projects`;
  return `${machineId} runs the leads of ${projects} (${named}): removing it stops them and erases its projects, with their chats and history`;
}

/** How to bring a machine back instead of removing it. */
export const repair = (machineId: string) =>
  `to repair ${machineId} instead, run fleetd pair --worker ${machineId} on the hub and the line it prints on ${machineId} with --rejoin`;

// ---- candidates (fleetd init and the app's Add machine) ----

export type Found = "here" | "set_up" | "ssh_config" | "tailnet";
export type Candidate = { machineId: string; host?: string; sshConfig?: string; found: Found };
export type Peer = { name: string; dnsName: string };

/** This machine, those set up before, then the hosts in ~/.ssh/config and the tailnet's peers: each id once, the
 * first place it was found winning. */
export function candidates(recorded: Record<string, MachineRecord>, sshHosts: string[], peers: Peer[]): Candidate[] {
  const ids = Object.keys(recorded).sort();
  const localId = ids.find((id) => recorded[id]!.local) ?? machineIdFromHost(localHostName());
  const out: Candidate[] = [{ machineId: localId, found: "here" }];
  for (const id of ids) {
    const r = recorded[id]!;
    if (r.local) continue;
    out.push({ machineId: id, host: r.sshHost, ...(r.sshConfig ? { sshConfig: r.sshConfig } : {}), found: "set_up" });
  }
  const found: [string, string, Found][] = [
    ...sshHosts.map((h): [string, string, Found] => [machineIdFromHost(h), h, "ssh_config"]),
    ...peers.map((p): [string, string, Found] => [machineIdFromHost(p.name), p.dnsName, "tailnet"]),
  ];
  for (const [machineId, host, how] of found) {
    if (isMachineId(machineId) && !out.some((c) => c.machineId === machineId)) out.push({ machineId, host, found: how });
  }
  return out;
}

// ---- the command ----

async function removeCommand(argv: string[]): Promise<number> {
  const v = parse(argv, { options: { purge: "bool", force: "bool" }, positionals: true });
  if (v instanceof ArgError) return usage(v.message);
  const machineId = v.positionals[0];
  if (machineId === undefined || !isMachineId(machineId)) return usage("machine remove takes a machine id");
  const home = resolveHome();
  let db: HubDb;
  try {
    db = openHub(home);
  } catch (error) {
    return fail((error as Error).message);
  }
  try {
    const side: HubSide = { db, home, by: "the fleetd CLI (machine remove)", erase: eraseIn };
    if (!v.flag("force")) {
      const leads = leadsOn(side, machineId);
      if (leads !== undefined) {
        return Stop.fail(`${leads}. Fix: ${repair(machineId)}; to remove it anyway, run fleetd machine remove ${machineId} --force`).print();
      }
    }
    const removed = await remove(home, machineId, v.flag("purge"), side, ssh, print);
    return removed.remoteOk ? 0 : 1;
  } catch (error) {
    if (error instanceof Stop) return error.print();
    throw error;
  } finally {
    db.conn.close();
  }
}

export async function machineCommand(argv: string[]): Promise<number> {
  switch (argv[0]) {
    case "add": {
      const a = parseAdd(argv.slice(1));
      if (typeof a === "number") return a;
      try {
        await add(a);
        return 0;
      } catch (error) {
        if (error instanceof Stop) return error.print();
        throw error;
      }
    }
    case "remove":
      return removeCommand(argv.slice(1));
    case "set":
      return machineSetCommand(argv.slice(1));
    case undefined:
      return usage("missing machine command");
    default:
      return usage(`unknown machine command '${argv[0]}'`);
  }
}
