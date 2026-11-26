// The agents' Mac's node (jobs.rs): each `mac_call` from the hub is one
// sealed step of an agent's, opened with this node's box key, checked (sealed for the session the hub names, lately,
// never before), and run in that agent's own folder under `<home>/mac/<task or session>/`: its `repo/` checked out
// from the project's mirror, its jobs, the files it put and pulls. The answer goes back sealed with the step's key.
//
// iOS simulators (`sim_start`, `sim_end`) are node/device/ios's (sims.ts), set here as `sims` where the Mac has them;
// a `sim_start`'s frame carries the screen the hub made for the simulator it lends (sim_screen.ts).
// On a Mac that runs agents itself (`own`, its machine's id), its own agents' steps carry their worktree: their jobs
// run there, with no push, and their pulls read from it; a step from any other machine never names one.
// What agents do on the Mac goes to the menu bar (`activity`, ./activity.ts). A task's folder goes, with its snapshot
// in the mirror and what it left running there, once the hub says the task ended (`ended`), else once nothing touched
// it for FOLDER_DAYS (`sweep`); build caches and idle agents' folders go while the disk is short (`relieve`), and a
// step that writes waits for that and is refused under FLOOR (`room`), never left to die on a full disk.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, basename, isAbsolute, join } from "node:path";
import type { Subprocess } from "bun";
import { ToolError } from "../../shared/errors.ts";
import { inTurn } from "../util.ts";
import { type Activity, clipCommand, type JobActivity, type SimActivity } from "./activity.ts";
import type { MacSims } from "../device/ios/sims.ts";
import type { MacCaller, MacCallFrame, MacResultFrame, McpToolError, SimScreen } from "../../shared/screens_wire.ts";
import {
  type Answer,
  type Done,
  type Envelope,
  LOGS_MAX,
  type MacEnv,
  type MacJob,
  PIECE,
  PULL_MAX,
  PUSH_MAX,
  safePart,
  sealAnswer,
  SKEW_MS,
  splitRaw,
  type Step,
} from "./protocol.ts";
import { settingsPath } from "../../shared/settings_path.ts";
import { type JobSpec, masker } from "./job.ts";

/** An agent's folder nothing touched for this many days goes, and so does a build of Xcode's own DerivedData. */
export const FOLDER_DAYS = 3;
/** Below this much free space the Mac frees build caches, oldest first (the Mac's menu bar warns below it too). */
export const LOW_FREE = 30e9;
/** ...until it has this much free again, so one freed cache doesn't leave it at the edge for the next build. */
export const ROOM_FREE = 50e9;
/** Under this much free, even after freeing what it could, a step that writes (a job, a push, a simulator) is refused:
 * a cold iOS build writes gigabytes, and a job whose log can't be written dies before its command starts. */
export const FLOOR = 20e9;
/** A cache touched within this long may be a build's that runs now: it is never freed for room. */
export const CACHE_IDLE = 3600_000;
/** An ended task's folder a step used within this long stays until the hub's next word: the task may have gone on. */
export const ENDED_QUIET = 10 * 60_000;
/** The finished jobs whose logs an agent keeps on the Mac; an older one's goes as a new one starts. */
export const JOBS_KEPT = 20;
/** A job's log stops growing here (its command runs on), so one chatty job can't fill the disk. */
export const LOG_MAX = 256 * 2 ** 20;
/** In a folder freed for room (`relieve`): the agent's pushed work went, so its next job waits for a push. */
export const FREED = ".freed";
/** A foreground job nobody followed for this long ends: its agent stopped waiting for it. */
export const FOREGROUND_IDLE = 60_000;
/** How long `logs` waits for output while the job runs. */
export const LOGS_WAIT = 10_000;
/** The most jobs one agent has running at once. */
export const RUNNING_MAX = 16;
const KILL_GRACE = 5_000;
const HAVE_MAX = 50;
/** The variables a job keeps from the node's own environment; every other is left out. */
const KEPT = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "DEVELOPER_DIR"];
const HOMEBREW_BINS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * Each agent's builds keep their own DerivedData on the agents' Mac, which goes with its folder. A build with no
 * action named (`xcodebuild -workspace … -scheme …`, as `expo run:ios` runs it) builds too: before it counted, those
 * filled Xcode's own DerivedData, which nothing swept (24 GB on Nov 22). Only a line that reads or exports, never
 * builds, goes on as it was.
 *
 * A build waits its turn for one of the Mac's build slots (`$FLEETD_MAC_BUILD_SLOT`, `macBuilds`) and uses its share
 * of the Mac's cores (`-jobs $FLEETD_MAC_BUILD_JOBS`, unless the line names its own): on Nov 26 eight builds at once,
 * each on every core, kept 152 compilers running and the Mac's load between 300 and 470.
 */
export const XCODEBUILD = `#!/bin/sh
# fleetd: each agent's builds keep their own DerivedData on the agents' Mac ($FLEETD_MAC_DERIVED_DATA), and wait
# their turn for one of its build slots.
builds=
settings=
own=
jobs=
for a in "$@"; do
  case "$a" in
    -list|-version|-showsdks|-showdestinations|-showTestPlans|-license|-checkFirstLaunchStatus|-runFirstLaunch|-downloadPlatform|-downloadAllPlatforms|-importPlatform|-exportArchive|-exportNotarizedApp|-exportLocalizations|-importLocalizations|-create-xcframework|-find-executable|-find-library|-usage|-help|-h)
      exec /usr/bin/xcodebuild "$@" ;;
    -showBuildSettings)
      settings=1 ;;
    -derivedDataPath)
      own=1 ;;
    -jobs)
      jobs=1 ;;
    build|build-for-testing|test|test-without-building|analyze|archive|clean|docbuild|-resolvePackageDependencies|-workspace|-project|-scheme|-target|-alltargets)
      builds=1 ;;
  esac
done
[ -n "$builds" ] || [ -n "$settings" ] || exec /usr/bin/xcodebuild "$@"
[ -n "$own" ] || set -- "$@" -derivedDataPath "$FLEETD_MAC_DERIVED_DATA"
# Its settings, read where its builds go (expo run:ios finds the app by them), never wait for a slot.
[ -z "$settings" ] || exec /usr/bin/xcodebuild "$@"
[ -n "$jobs" ] || [ -z "$FLEETD_MAC_BUILD_JOBS" ] || set -- "$@" -jobs "$FLEETD_MAC_BUILD_JOBS"
[ -z "$FLEETD_MAC_BUILD_SLOT" ] || exec "$FLEETD_MAC_BUILD_SLOT" /usr/bin/xcodebuild "$@"
exec /usr/bin/xcodebuild "$@"
`;

const refuse = (message: string, fix?: string) => new ToolError("invalid", message, fix);
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
/** The steps that write to the Mac's disk: each makes room first (`room`). */
const WRITES = new Set(["put", "checkout", "run", "sim_start"]);
const failed = (what: string, e: unknown) => new ToolError("failed", `${what}: ${e instanceof Error ? e.message : String(e)}`);

/** An agent's folder on the Mac, by task (else by session), and the project it works on; on its own Mac, the
 * worktree its jobs run in (`repo`). */
export type Agent = { dir: string; project: string; name: string; repo?: string };
const repoOf = (a: Agent) => a.repo ?? join(a.dir, "repo");

/** `argv`, awaited off the event loop: a checkout of a whole tree never stalls the Mac's link or its other jobs. */
async function run(argv: string[], stdin?: Blob): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

async function git(dir: string, args: string[]): Promise<string> {
  const out = await run(["git", "-C", dir, ...args]);
  if (out.code !== 0) throw new ToolError("failed", `git ${args[0]} failed on the Mac: ${out.stderr.trim()}`);
  return out.stdout;
}

/** A job: its relay's pid (its group's id, job.ts), its log and its end file; `exit` once it ended. */
type Job = { command: string; background: boolean; startedMs: number; pid: number; log: string; end: string; exit: number | undefined; followed: number; signaled?: number };
/** What a job's `<n>.json` beside its log keeps for the next node (`adoptJobs`). */
type JobRecord = { command: string; background: boolean; startedMs: number; pid: number; project: string };

/**
 * A job's shell: zsh as a login shell where there is one, so the agent's tools are on the PATH. A login shell's
 * path_helper (/etc/zprofile) puts the system's folders first, so the job's own PATH (`jobEnv`, its `xcodebuild`
 * and agent-device first) goes back in front of it.
 */
export function shellLine(args: string[]): string[] {
  const line = args.join(" ");
  return existsSync("/bin/zsh") ? ["/bin/zsh", "-lc", `PATH="$FLEETD_MAC_PATH:$PATH"; ${line}`] : ["/bin/sh", "-c", line];
}

/** A job's environment: KEPT from the node's, the agent's folders, and the variables it named. */
export function jobEnv(
  agent: Agent,
  cache: string,
  named: MacEnv[],
  node: Record<string, string | undefined>,
  /** The agent's simulator's variables, while it holds one (sims.ts `env`), given the job's PATH. */
  sim?: (path: string) => [string, string][] | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of KEPT) if (node[k] !== undefined && k !== "PATH") env[k] = node[k]!;
  const path = node.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  // Homebrew's commands last, CocoaPods' among them: a launchd service's PATH has none.
  const brew = HOMEBREW_BINS.filter((b) => !path.split(":").includes(b)).map((b) => `:${b}`).join("");
  // CocoaPods refuses to run outside UTF-8, and a launchd service gets no LANG.
  env.LANG ??= "en_US.UTF-8";
  Object.assign(env, {
    PATH: `${join(agent.dir, "bin")}:${path}${brew}`,
    TMPDIR: join(agent.dir, "tmp"),
    FLEETD_MAC_DIR: agent.dir,
    FLEETD_MAC_REPO: repoOf(agent),
    FLEETD_MAC_DERIVED_DATA: join(agent.dir, "DerivedData"),
    FLEETD_MAC_CACHE: cache,
    // Manners, not a fence: the Mac's node takes no calls from its jobs.
    FLEETD_NODE_SOCK: "/dev/null",
  });
  // The agent's simulator: agent-device's wrapper first on the PATH, pointed at it, and for plain simctl its udid and set.
  for (const [k, v] of sim?.(env.PATH!) ?? []) env[k] = v;
  // What the login shell puts back in front of its own (`shellLine`).
  env.FLEETD_MAC_PATH = env.PATH!;
  for (const { name, value } of named) env[name] = value;
  return env;
}

export class Host {
  /** Nonces seen within twice the skew. */
  private readonly seen = new Map<string, number>();
  private readonly jobs = new Map<string, { project: string; next: number; jobs: Map<number, Job> }>();
  /** The Mac's iOS simulators, where it has them (node/device/ios). */
  sims: MacSims | undefined;
  /** On a Mac that runs agents: its machine's id, whose agents' steps name their worktree. */
  own: string | undefined;
  /** How many simulators at once the machine's screens settings say, as the hub's last `mac_call` carried it. */
  simCap: number | undefined;
  /** Xcode's own DerivedData (`~/Library/Developer/Xcode/DerivedData`), for the builds that went past an agent's. */
  xcodeData: string | undefined;
  /** The free bytes on the disk that holds `path`. */
  freeBytes: (path: string) => number = (path) => {
    const s = statfsSync(path);
    return s.bavail * s.bsize;
  };
  /** Where a job's log stops growing (LOG_MAX; tests set less). */
  logMax = LOG_MAX;
  /** The command that holds a job (job.ts): this binary's `mac-job`, or job.ts itself from source. */
  relay: string[] = Bun.main.startsWith("/$bunfs/") ? [process.execPath, "mac-job"] : [process.execPath, join(import.meta.dir, "job.ts")];
  /** The Mac's build slots (macBuilds): the command a build waits in (heavy_slots.ts), and the jobs each runs. */
  builds: { slot: string; jobs: number } | undefined;
  /** Whether the Mac's link to the hub is up: while it's down no agent can follow its job, so none counts as left. */
  linked: () => boolean = () => true;
  /** The node stopped: what watches its jobs lets go, and the jobs run on for the next one. */
  private stopped = false;
  /** The upkeep under way, which every caller shares (`housekeep`). */
  private keeping: Promise<string[]> | undefined;

  constructor(
    /** `~/work`: each agent's folder, and `.mirrors/` of each project's snapshots. */
    readonly root: string,
    /** This node's box key: what the agents' nodes seal their steps to. */
    private readonly key: { open(sealed: Uint8Array): Uint8Array | null },
    private readonly clock: () => number = Date.now,
  ) {}

  /** How many simulators the Mac runs at once, as its screens settings say now (null: its own default). */
  setSims(n: number | null): void {
    this.simCap = n ?? undefined;
    if (this.sims) this.sims.cap = this.simCap;
  }

  /** What the Mac is called in what agents read. */
  private called(): string {
    return this.own === undefined ? "The agents' Mac" : "This Mac";
  }

  private cache(): string {
    return join(this.root, ".cache");
  }

  /** One `mac_call`: its step opened, run, and its answer sealed back. */
  async answer(frame: MacCallFrame): Promise<MacResultFrame> {
    const refused = (error: McpToolError): MacResultFrame => ({ id: frame.id, error });
    let envelope: Envelope;
    let raw: Uint8Array;
    try {
      [envelope, raw] = this.open(frame.caller, frame.sealed);
    } catch (e) {
      return refused(e instanceof ToolError ? e.toJSON() : { code: "invalid", message: String(e) });
    }
    const answerKey = Buffer.from(envelope.answerKey ?? "", "base64");
    if (answerKey.length !== 32) return refused({ code: "invalid", message: "the step's answer key is not 32 bytes" });
    let answer: Answer;
    let out: Uint8Array = new Uint8Array();
    try {
      // Room first: on a full disk even the agent's folder can't be made.
      if (WRITES.has(envelope.step.step)) await this.room();
      const agent = this.agent(frame.caller, this.worktree(frame.caller, envelope.worktree));
      if (frame.sims !== undefined) this.setSims(frame.sims);
      // Any step of the agent's keeps its simulator.
      this.sims?.touch(agent.name);
      const [done, after] = await this.step(agent, envelope.step, raw, frame.screen);
      answer = { done };
      out = after;
    } catch (e) {
      answer = { error: e instanceof ToolError ? e.toJSON() : { code: "failed", message: (e as Error).message } };
    }
    return { id: frame.id, sealed: sealAnswer(answerKey, answer, out) };
  }

  /** The step inside and the raw bytes after it, if it was sealed to this Mac for the session the hub names, lately, and never before. */
  open(caller: MacCaller, sealed: string): [Envelope, Uint8Array] {
    const plain = this.key.open(Buffer.from(sealed, "base64"));
    if (!plain) throw refuse("the step was not sealed to this Mac's key");
    let envelope: Envelope;
    let raw: Uint8Array;
    try {
      [envelope, raw] = splitRaw<Envelope>(plain);
    } catch (e) {
      throw refuse(`the step doesn't read: ${(e as Error).message}`);
    }
    if (envelope.thread !== caller.threadId) throw refuse("the step was sealed for another agent's session");
    const now = this.clock();
    if (Math.abs(now - envelope.atMs) > SKEW_MS) {
      throw refuse("the step's clock is more than 5 minutes from the Mac's", "check both machines' clocks, then run the command again");
    }
    for (const [n, at] of this.seen) if (now - at > 2 * SKEW_MS) this.seen.delete(n);
    if (this.seen.has(envelope.nonce)) throw refuse("the step came a second time");
    this.seen.set(envelope.nonce, now);
    return [envelope, raw];
  }

  /** The worktree a step of the Mac's own agents names: an existing folder, from this machine only. */
  private worktree(caller: MacCaller, named: string | undefined): string | undefined {
    if (named === undefined || this.own === undefined || caller.machineId !== this.own) return undefined;
    if (!isAbsolute(named) || !existsSync(named) || !statSync(named).isDirectory()) throw refuse(`${named} is no worktree on this Mac`);
    return named;
  }

  /** The caller's folder, made with its `bin/` the first time: by task, else by session. */
  agent(caller: MacCaller, repo?: string): Agent {
    const named = caller.taskId ?? caller.threadId;
    const name = safePart(named);
    if (!name) throw refuse(`${named} can't name a folder`);
    const project = safePart(caller.projectId);
    if (!project) throw refuse("the bot's id can't name a folder");
    const dir = join(this.root, name);
    try {
      for (const sub of ["jobs", "in", "out", "tmp", "bin", "DerivedData"]) mkdirSync(join(dir, sub), { recursive: true });
      const shim = join(dir, "bin", "xcodebuild");
      // A folder from an older node gets this one's: its builds went past it.
      if (!existsSync(shim) || readFileSync(shim, "utf8") !== XCODEBUILD) writeFileSync(shim, XCODEBUILD, { mode: 0o755 });
      // Touched by every step: what the sweep goes by.
      writeFileSync(join(dir, ".used"), "");
    } catch (e) {
      throw failed("the agent's folder on the Mac was not made", e);
    }
    return { dir, project, name, ...(repo === undefined ? {} : { repo }) };
  }

  private mirror(project: string): string {
    return join(this.root, ".mirrors", `${project}.git`);
  }

  /**
   * The step, with the raw bytes after it (a `put`'s piece); the answer, with those that go after it (a raw `get`'s).
   * `screen`: the screen the hub made for a `sim_start`, which the simulator it lends shows as.
   */
  async step(agent: Agent, step: Step, raw: Uint8Array = new Uint8Array(), screen?: SimScreen): Promise<[Done, Uint8Array]> {
    const none = new Uint8Array();
    switch (step.step) {
      case "have":
        return [{ step: "have", snapshots: await haves(this.mirror(agent.project), agent.name), raw: true }, none];
      case "put": {
        const name = safePart(step.name);
        if (!name) throw refuse(`${step.name} can't name a file`);
        const data = step.dataB64 === "" ? raw : Buffer.from(step.dataB64, "base64");
        return [put(join(agent.dir, "in", name), step.offset, data), none];
      }
      case "checkout": {
        let pack: string | undefined;
        if (step.pack != null) {
          const name = safePart(step.pack);
          if (!name) throw refuse(`${step.pack} can't name a file`);
          pack = join(agent.dir, "in", name);
        }
        const done = await checkout(this.mirror(agent.project), repoOf(agent), agent.name, step.snapshot, pack);
        rmSync(join(agent.dir, FREED), { force: true });
        return [done, none];
      }
      case "run":
        return [this.start(agent, step.args, step.env ?? [], step.background), none];
      case "logs":
        return [await this.logs(agent.name, step.job, step.offset), none];
      case "ps":
        return [{ step: "ps", jobs: this.list(agent.name) }, none];
      case "kill":
        return [{ step: "kill", job: step.job, killed: this.kill(agent.name, step.job) }, none];
      case "get":
        return await get(agent.dir, repoOf(agent), step.path, step.offset, step.raw ?? false, agent.repo !== undefined);
      case "sim_start":
        if (!this.sims) {
          throw new ToolError(
            "failed",
            `${this.called()} has no iOS simulators: its golden simulator isn't made.`,
            `do without a simulator and say so; an admin finishes the Mac's setup in ${settingsPath()} › Machines`,
          );
        }
        return [
          await this.sims.start(agent, step.device, step.wait ?? false, screen, {
            ...(step.person === undefined ? {} : { person: step.person }),
            ...(step.runtime === undefined ? {} : { runtime: step.runtime }),
          }),
          none,
        ];
      case "sim_control": {
        if (!this.sims) throw new ToolError("invalid", "You hold no simulator on the Mac.", "mac sim start first");
        const { shot, device } = await this.sims.control(agent.name, step.control, step.value);
        if (!shot) return [{ step: "sim_control", device }, none];
        const path = join(agent.dir, "out", `sim-${new Date(this.clock()).toISOString().replace(/[:.]/g, "-")}.png`);
        writeFileSync(path, shot.png);
        return [{ step: "sim_control", device, path, width: shot.width, height: shot.height }, none];
      }
      case "sim_end":
        return [{ step: "sim_end", ended: this.sims?.end(agent.name) ?? false }, none];
      default:
        throw refuse(`the Mac doesn't know the step ${(step as { step: string }).step}`);
    }
  }

  // ---- jobs (jobs.rs) ----

  private start(agent: Agent, args: string[], named: MacEnv[], background: boolean): Done {
    if (args.every((a) => a.trim() === "")) throw refuse("mac run needs a command", "mac run -- <command line>");
    let mine = this.jobs.get(agent.name);
    if (!mine) this.jobs.set(agent.name, (mine = { project: agent.project, next: 0, jobs: new Map() }));
    const running = [...mine.jobs.values()].filter((j) => j.exit === undefined).length;
    if (running >= RUNNING_MAX) {
      throw refuse(`you have ${running} jobs running on the Mac, the most at once`, "end some with mac kill (mac ps lists them)");
    }
    if (!existsSync(repoOf(agent)) && existsSync(join(agent.dir, FREED))) {
      throw refuse("Your pushed work on the Mac was freed for room after an hour unused.", "run mac push, then this command again");
    }
    mkdirSync(this.cache(), { recursive: true });
    // The oldest finished jobs' logs go, so an agent's many jobs don't pile up on the disk.
    const finished = [...mine.jobs].filter(([, j]) => j.exit !== undefined);
    for (const [n, j] of finished.slice(0, Math.max(finished.length - JOBS_KEPT + 1, 0))) {
      for (const f of [j.log, j.end, join(dirname(j.log), `${n}.json`)]) rmSync(f, { force: true });
      mine.jobs.delete(n);
    }
    const job = ++mine.next;
    const log = join(agent.dir, "jobs", `${job}.log`);
    const end = join(agent.dir, "jobs", `${job}.end`);
    try {
      closeSync(openSync(log, "w"));
      rmSync(end, { force: true });
    } catch (e) {
      throw failed("the job's log was not made on the Mac", e);
    }
    const cwd = existsSync(repoOf(agent)) ? repoOf(agent) : agent.dir;
    const spec: JobSpec = { argv: shellLine(args), cwd, named, logMax: this.logMax };
    let child: Subprocess<"pipe", "ignore", "ignore">;
    try {
      // Its own session, so it outlives the node and `kill` ends its whole group; the values to mask go on stdin.
      child = Bun.spawn([...this.relay, log, end], {
        cwd,
        env: {
          ...(this.builds ? { FLEETD_MAC_BUILD_SLOT: this.builds.slot, FLEETD_MAC_BUILD_JOBS: String(this.builds.jobs) } : {}),
          ...jobEnv(agent, this.cache(), named, process.env, (path) => this.sims?.env(agent.name, path)),
        },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      child.stdin.write(JSON.stringify(spec));
      void child.stdin.end();
      child.unref();
    } catch (e) {
      throw failed("the command didn't start on the Mac", e);
    }
    const entry: Job = { command: masker(named)(args.join(" ")), background, startedMs: this.clock(), pid: child.pid, log, end, exit: undefined, followed: Date.now() };
    mine.jobs.set(job, entry);
    const record: JobRecord = { command: entry.command, background, startedMs: entry.startedMs, pid: child.pid, project: agent.project };
    try {
      writeFileSync(join(agent.dir, "jobs", `${job}.json`), JSON.stringify(record));
    } catch {
      // Without it the job runs on, and only a restarted node loses sight of it.
    }
    void child.exited.then(() => this.finish(agent.name, entry));
    if (!background) void this.endUnfollowed(agent.name, job);
    return { step: "run", job };
  }

  /** The job's end as its relay wrote it; none written, it was killed (`signaled`) or its relay died. */
  private finish(agent: string, entry: Job): void {
    if (entry.exit !== undefined) return;
    let code: number | undefined;
    try {
      const text = readFileSync(entry.end, "utf8").trim();
      if (/^[0-9]+$/.test(text)) code = Number(text);
    } catch {}
    entry.exit = code ?? (entry.signaled !== undefined ? 128 + entry.signaled : 1);
    // A job that drove the agent's simulator is a line in its screen's log.
    this.sims?.ran(agent, entry.command, entry.exit === 0, this.clock() - entry.startedMs);
  }

  /** A job a node before started: its end, looked for every second until its relay is gone. */
  private async watch(agent: string, entry: Job): Promise<void> {
    while (!this.stopped && entry.exit === undefined && alive(entry.pid)) await Bun.sleep(1000);
    if (!this.stopped) this.finish(agent, entry);
  }

  /** A foreground job its agent stopped following ends. While the Mac's link is down no one can follow it: that time
   * doesn't count. */
  private async endUnfollowed(agent: string, job: number): Promise<void> {
    for (;;) {
      const j = this.jobs.get(agent)?.jobs.get(job);
      if (this.stopped || !j || j.exit !== undefined) return;
      if (!this.linked()) j.followed = Date.now();
      const left = FOREGROUND_IDLE - (Date.now() - j.followed);
      if (left <= 0) {
        this.kill(agent, job);
        return;
      }
      await Bun.sleep(Math.min(left, 1000));
    }
  }

  /** Output from `offset`, waiting up to LOGS_WAIT for some while the job runs. */
  private async logs(agent: string, job: number, offset: number): Promise<Done> {
    const j = this.jobs.get(agent)?.jobs.get(job);
    if (!j) throw new ToolError("not_found", `You have no job ${job} on the Mac.`, "mac ps lists your jobs");
    j.followed = Date.now();
    const deadline = Date.now() + LOGS_WAIT;
    for (;;) {
      const ended = j.exit;
      const size = existsSync(j.log) ? statSync(j.log).size : 0;
      if (size > offset || ended !== undefined || Date.now() >= deadline) {
        const data = readFrom(j.log, offset, LOGS_MAX);
        const next = offset + data.length;
        const done = ended !== undefined && next >= size;
        return { step: "logs", dataB64: Buffer.from(data).toString("base64"), offset: next, done, ...(done && ended !== undefined ? { exitCode: ended } : {}) };
      }
      await Bun.sleep(200);
    }
  }

  private list(agent: string): MacJob[] {
    return [...(this.jobs.get(agent)?.jobs.entries() ?? [])]
      .map(([job, j]) => ({
        job,
        command: j.command,
        background: j.background,
        running: j.exit === undefined,
        ...(j.exit === undefined ? {} : { exitCode: j.exit }),
        startedMs: j.startedMs,
      }))
      .sort((a, b) => a.job - b.job);
  }

  /** SIGTERM to the job's process group (its relay's), SIGKILL after KILL_GRACE; false when it wasn't running. */
  private kill(agent: string, job: number): boolean {
    const j = this.jobs.get(agent)?.jobs.get(job);
    if (!j || j.exit !== undefined) return false;
    const signal = (sig: NodeJS.Signals, n: number) => {
      j.signaled = n;
      try {
        process.kill(-j.pid, sig);
      } catch {}
    };
    signal("SIGTERM", 15);
    setTimeout(() => j.exit === undefined && signal("SIGKILL", 9), KILL_GRACE).unref();
    return true;
  }

  /** What agents do on the Mac now, for the menu bar: the simulators they hold and the jobs they run, oldest first. */
  activity(): Activity {
    const simulators: SimActivity[] = this.sims?.activity() ?? [];
    const jobs: JobActivity[] = [...this.jobs]
      .flatMap(([agent, mine]) =>
        [...mine.jobs]
          .filter(([, j]) => j.exit === undefined)
          .map(([job, j]) => ({ agent, projectId: mine.project, job, command: clipCommand(j.command), startedMs: j.startedMs })),
      )
      .sort((a, b) => a.startedMs - b.startedMs || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0) || a.job - b.job);
    return { simulators, jobs };
  }

  /** The agents with a job running or a simulator held: their folders never go. */
  busy(): Set<string> {
    const { simulators, jobs } = this.activity();
    return new Set([...simulators.map((s) => s.agent), ...jobs.map((j) => j.agent)]);
  }

  /**
   * The hub's word that these tasks ended (`node_action` mac_ended): their folders go, with their snapshots, and what
   * they left running there ends first (a background Metro, a simulator: fleetd's own jobs and clones, nothing else).
   * One a step used within ENDED_QUIET stays for the next word: its task may have gone on since the hub looked.
   */
  async ended(tasks: string[], now = Date.now()): Promise<string[]> {
    const names: string[] = [];
    for (const t of tasks) {
      if (safePart(t) !== t || !existsSync(join(this.root, t))) continue;
      if ((usedAt(join(this.root, t)) ?? 0) > now - ENDED_QUIET) continue;
      for (const job of this.jobs.get(t)?.jobs.keys() ?? []) this.kill(t, job);
      this.jobs.delete(t);
      this.sims?.end(t);
      names.push(t);
    }
    return removeFolders(this.root, names);
  }

  /** The Mac's upkeep: folders nothing touched for FOLDER_DAYS and old builds in Xcode's own DerivedData go, then
   * caches and idle folders while the disk is short of LOW_FREE. What went, by name. One runs at a time: a caller
   * while it runs gets its answer. */
  housekeep(now = Date.now()): Promise<string[]> {
    this.keeping ??= (async () => {
      const busy = this.busy();
      const gone = await sweep(this.root, FOLDER_DAYS, now, busy);
      if (this.xcodeData) gone.push(...(await sweepXcode(this.xcodeData, FOLDER_DAYS, now)));
      gone.push(...(await relieve(this.root, this.xcodeData, busy, this.freeBytes, now)));
      return gone;
    })().finally(() => (this.keeping = undefined));
    return this.keeping;
  }

  /** Free bytes where the agents' folders are; unknown reads as plenty. */
  free(): number {
    try {
      return this.freeBytes(existsSync(this.root) ? this.root : dirname(this.root));
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Room for a step that writes: short of LOW_FREE the upkeep starts; under FLOOR the step waits for it, and is refused
   * if it still has too little, saying how much is free and what went.
   */
  async room(): Promise<void> {
    if (this.free() >= LOW_FREE) return;
    const keeping = this.housekeep().catch((e: unknown) => {
      console.warn(`${new Date().toISOString()} WARN the Mac's agent folders were not swept {"error":${JSON.stringify(String(e))}}`);
      return [] as string[];
    });
    if (this.free() >= FLOOR) return;
    const gone = await keeping;
    const left = this.free();
    if (left >= FLOOR) return;
    const named = gone.length > 8 ? `${gone.slice(0, 8).join(", ")} and ${gone.length - 8} more` : gone.join(", ");
    const freed = gone.length === 0 ? "fleetd found none of its own folders, builds or caches left to free" : `fleetd freed ${named} first`;
    throw new ToolError(
      "failed",
      `${this.called()} has ${gb(left)} free on its disk, under the ${gb(FLOOR)} a job, push or simulator needs; ${freed}.`,
      `do without the Mac and say so in your result; a person frees space on it (${settingsPath("Machines")} shows its disk)`,
    );
  }

  /**
   * At the node's start: the jobs a node before started are their agents' again, those still running watched to their
   * end (job.ts holds them through the restart); a log without its record (an older node's, whose jobs ended with
   * it) goes.
   */
  adoptJobs(): void {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const dir = join(this.root, name);
      const jobs = join(dir, "jobs");
      let files: string[];
      try {
        files = readdirSync(jobs);
      } catch {
        continue;
      }
      let at: Date | undefined;
      try {
        at = statSync(dir).mtime;
      } catch {}
      const kept = new Set<string>();
      for (const file of files) {
        const n = /^([0-9]+)\.json$/.exec(file)?.[1];
        if (!n) continue;
        let record: JobRecord;
        try {
          record = JSON.parse(readFileSync(join(jobs, file), "utf8")) as JobRecord;
        } catch {
          continue;
        }
        const log = join(jobs, `${n}.log`);
        const end = join(jobs, `${n}.end`);
        if (!existsSync(log) || !Number.isInteger(record.pid)) continue;
        let mine = this.jobs.get(name);
        if (!mine) this.jobs.set(name, (mine = { project: record.project, next: 0, jobs: new Map() }));
        mine.next = Math.max(mine.next, Number(n));
        const entry: Job = { command: record.command, background: record.background, startedMs: record.startedMs, pid: record.pid, log, end, exit: undefined, followed: Date.now() };
        mine.jobs.set(Number(n), entry);
        for (const f of [file, `${n}.log`, `${n}.end`]) kept.add(f);
        // Its relay, by its pid and the log it holds: a pid another process took since is never its.
        if (!existsSync(end) && relayOf(record.pid, log)) {
          void this.watch(name, entry);
          if (!record.background) void this.endUnfollowed(name, Number(n));
        } else this.finish(name, entry);
      }
      for (const file of files) if (!kept.has(file)) rmSync(join(jobs, file), { recursive: true, force: true });
      // The folder's own time stays: an older node's folder without `.used` goes by it (`usedAt`), and a removal here
      // at each start kept it new for ever (T2970 on Nov 26).
      if (at) utimesSync(dir, at, at);
    }
  }

  /** The node stops: its jobs run on (job.ts) for the next node to take back (`adoptJobs`). */
  stop(): void {
    this.stopped = true;
  }

  /** Every job ends: for tests, and a Mac that leaves. */
  endJobs(): void {
    for (const [agent, mine] of this.jobs) for (const job of mine.jobs.keys()) this.kill(agent, job);
  }
}

/** Whether `pid` runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** Whether `pid` is the relay holding the job's `log` (job.ts), which its command line names. */
function relayOf(pid: number, log: string): boolean {
  if (!alive(pid)) return false;
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  return ps.stdout.toString().includes(log);
}

/** A name fleetd gives an agent's folder: a task's id, or a session's. Only such a folder without `.used` is fleetd's. */
const OURS = /^(T[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** When a step last touched the agent's folder `dir` (its `.used`); a folder of fleetd's an older node made without
 * one goes by its own time (a Rust node's, Nov 10, held 7 GB to Nov 26); undefined for any other. */
function usedAt(dir: string): number | undefined {
  try {
    return statSync(join(dir, ".used")).mtimeMs;
  } catch {
    if (!OURS.test(basename(dir))) return undefined;
    try {
      return statSync(dir).mtimeMs;
    } catch {
      return undefined;
    }
  }
}

/** The agents' folders under `root` (never a dot's: the mirrors, the shared cache), each with when a step last
 * touched it (`usedAt`; one that isn't fleetd's is left alone), least recently first. */
async function folders(root: string): Promise<{ name: string; used: number }[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: { name: string; used: number }[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const used = usedAt(join(root, name));
    if (used !== undefined) out.push({ name, used });
  }
  return out.sort((a, b) => a.used - b.used);
}

/** Removes the agents' folders under `root` nothing touched for `days` (by their `.used`), with their snapshots in the
 * mirrors, but none of `busy`'s. Off the event loop throughout (Rust runs it in `spawn_blocking`): a big folder's
 * removal or a mirror's `git gc` never stalls the node's link. */
export async function sweep(root: string, days: number, now = Date.now(), busy: Set<string> = new Set()): Promise<string[]> {
  const old = now - days * 86_400_000;
  return removeFolders(
    root,
    (await folders(root)).filter((f) => f.used < old && !busy.has(f.name)).map((f) => f.name),
  );
}

/** Removes the agents' folders `names` under `root`, with their snapshots in the mirrors. */
export async function removeFolders(root: string, names: string[]): Promise<string[]> {
  const gone: string[] = [];
  for (const name of names) {
    await rm(join(root, name), { recursive: true, force: true });
    gone.push(name);
  }
  if (gone.length === 0) return gone;
  let mirrors: string[];
  try {
    mirrors = await readdir(join(root, ".mirrors"));
  } catch {
    return gone;
  }
  for (const mirror of mirrors) {
    const dir = join(root, ".mirrors", mirror);
    const run = (args: string[]) => Bun.spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
    for (const name of gone) await run(["update-ref", "-d", `refs/fleetd/${name}`]);
    await run(["worktree", "prune"]);
    await run(["gc", "--auto", "--quiet"]);
  }
  return gone;
}

/** When a build last wrote to `dir`, one of Xcode's DerivedData folders: the folder, its build logs or its build. */
async function builtAt(dir: string): Promise<number> {
  let at = 0;
  for (const sub of ["", "Logs/Build", "Build/Intermediates.noindex", "Build/Products"]) {
    try {
      at = Math.max(at, (await stat(join(dir, sub))).mtimeMs);
    } catch {}
  }
  return at;
}

/** Xcode's own DerivedData folders under `dir`, each with when a build last wrote to it, least recently first. */
async function xcodeBuilds(dir: string): Promise<{ name: string; at: number }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: { name: string; at: number }[] = [];
  for (const name of names) out.push({ name, at: await builtAt(join(dir, name)) });
  return out.sort((a, b) => a.at - b.at);
}

/** Removes the builds in Xcode's own DerivedData `dir` no build wrote to for `days`: Xcode keeps them for ever. */
export async function sweepXcode(dir: string, days: number, now = Date.now()): Promise<string[]> {
  const old = now - days * 86_400_000;
  const gone: string[] = [];
  for (const b of await xcodeBuilds(dir)) {
    if (b.at >= old) continue;
    await rm(join(dir, b.name), { recursive: true, force: true });
    gone.push(`DerivedData/${b.name}`);
  }
  return gone;
}

/**
 * While the disk holding `root` has less than LOW_FREE free, frees what fleetd made until it has ROOM_FREE, least
 * recently used first and none touched within CACHE_IDLE: Xcode's own DerivedData builds, then each idle agent's
 * DerivedData (its next build starts cold), then each idle agent's whole folder (its next job asks for a push first,
 * FREED), then the agents' shared cache while no agent is busy. `busy`'s are never touched. What went, by name.
 */
export async function relieve(
  root: string,
  xcodeData: string | undefined,
  busy: Set<string>,
  freeBytes: (path: string) => number,
  now = Date.now(),
): Promise<string[]> {
  const free = () => {
    try {
      return freeBytes(root);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  if (free() >= LOW_FREE) return [];
  const idle = now - CACHE_IDLE;
  const gone: string[] = [];
  for (const b of xcodeData ? await xcodeBuilds(xcodeData) : []) {
    if (free() >= ROOM_FREE) return gone;
    if (b.at >= idle) continue;
    await rm(join(xcodeData!, b.name), { recursive: true, force: true });
    gone.push(`DerivedData/${b.name}`);
  }
  const agents = (await folders(root)).filter((f) => f.used < idle && !busy.has(f.name));
  for (const f of agents) {
    if (free() >= ROOM_FREE) return gone;
    const data = join(root, f.name, "DerivedData");
    if ((await readdir(data).catch(() => [])).length === 0) continue;
    await rm(data, { recursive: true, force: true });
    await mkdir(data, { recursive: true });
    gone.push(`${f.name}/DerivedData`);
  }
  for (const f of agents) {
    if (free() >= ROOM_FREE) return gone;
    const dir = join(root, f.name);
    // Nothing pushed there, or freed already.
    if (!existsSync(join(dir, "repo"))) continue;
    await removeFolders(root, [f.name]);
    // What the sweep goes by stays as it was, and the agent hears why its work is gone.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FREED), "");
    writeFileSync(join(dir, ".used"), "");
    utimesSync(join(dir, ".used"), f.used / 1000, f.used / 1000);
    gone.push(f.name);
  }
  if (busy.size > 0) return gone;
  const cache = join(root, ".cache");
  const cached: { name: string; at: number }[] = [];
  for (const name of await readdir(cache).catch(() => [] as string[])) {
    const at = await stat(join(cache, name)).then((s) => s.mtimeMs, () => now);
    if (at < idle) cached.push({ name, at });
  }
  for (const c of cached.sort((a, b) => a.at - b.at)) {
    if (free() >= ROOM_FREE) return gone;
    await rm(join(cache, c.name), { recursive: true, force: true });
    gone.push(`.cache/${c.name}`);
  }
  return gone;
}

function readFrom(path: string, offset: number, max: number): Uint8Array {
  if (!existsSync(path)) return new Uint8Array();
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const out = Buffer.alloc(Math.max(Math.min(max, size - offset), 0));
    if (out.length > 0) readSync(fd, out, 0, out.length, offset);
    return out;
  } finally {
    closeSync(fd);
  }
}

/** The snapshots of the project the Mac holds: the agent's own first, then the newest, at most HAVE_MAX. */
export async function haves(mirror: string, agent: string): Promise<string[]> {
  if (!existsSync(mirror)) return [];
  let listed = "";
  try {
    listed = await git(mirror, ["for-each-ref", "--sort=-committerdate", "--format=%(objectname)", "refs/fleetd/"]);
  } catch {
    // An empty mirror.
  }
  const out: string[] = [];
  try {
    const own = (await git(mirror, ["rev-parse", "--verify", "-q", `refs/fleetd/${agent}`])).trim();
    if (own) out.push(own);
  } catch {
    // No snapshot of its own yet.
  }
  for (const id of listed.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (!out.includes(id)) out.push(id);
    if (out.length === HAVE_MAX) break;
  }
  return out;
}

/** One piece of a file the next step reads: the first starts it again, each other follows the last. */
export function put(path: string, offset: number, data: Uint8Array): Done {
  if (data.length > PIECE || offset + data.length > PUSH_MAX) throw refuse("the push is larger than the Mac takes");
  const fd = openSync(path, offset === 0 ? "w" : existsSync(path) ? "r+" : "w");
  try {
    const size = fstatSync(fd).size;
    if (size < offset) throw refuse(`the piece starts at ${offset}, and the Mac has ${size} bytes of it`);
    ftruncateSync(fd, offset);
    writeSync(fd, data, 0, data.length, offset);
  } finally {
    closeSync(fd);
  }
  return { step: "put", bytes: offset + data.length };
}

const snapshotId = (id: string) => (id.length === 40 || id.length === 64) && /^[0-9a-fA-F]+$/.test(id);

/** Each mirror's checkouts, one after another, as when they ran on the event loop. */
const mirrorTurns = new Map<string, Promise<unknown>>();

/**
 * The agent's `repo/` becomes `snapshot`: the pack goes into the project's mirror first, the snapshot is kept there
 * under the agent's name, and the worktree is checked out at it. Files git ignores (builds, node_modules) stay.
 */
export const checkout = (mirror: string, repo: string, name: string, snapshot: string, pack: string | undefined): Promise<Done> =>
  inTurn(mirrorTurns, mirror, () => checkoutNow(mirror, repo, name, snapshot, pack));

async function checkoutNow(mirror: string, repo: string, name: string, snapshot: string, pack: string | undefined): Promise<Done> {
  if (!snapshotId(snapshot)) throw refuse(`${snapshot} is not a commit id`);
  if (!existsSync(mirror)) {
    mkdirSync(mirror, { recursive: true });
    await git(mirror, ["init", "--quiet", "--bare"]);
  }
  const commit = `${snapshot}^{commit}`;
  const has = () => git(mirror, ["cat-file", "-e", commit]).then(
    () => true,
    () => false,
  );
  // A checkout sent again after its answer was lost: its pack went into the mirror already.
  if (pack !== undefined && !(!existsSync(pack) && (await has()))) {
    if (!existsSync(pack)) throw refuse("the push's pack is missing", "run mac push again");
    const out = await run(["git", "-C", mirror, "index-pack", "--stdin", "--fix-thin"], Bun.file(pack));
    rmSync(pack, { force: true });
    if (out.code !== 0) {
      throw new ToolError("failed", `the push's pack didn't index: ${out.stderr.trim()}`, "run mac push again");
    }
  }
  if (!(await has())) throw refuse("the Mac doesn't have that snapshot", "run mac push again");
  await git(mirror, ["update-ref", `refs/fleetd/${name}`, snapshot]);
  let fresh = !existsSync(join(repo, ".git"));
  if (!fresh) {
    try {
      await git(repo, ["rev-parse", "--git-dir"]);
    } catch {
      fresh = true;
    }
  }
  if (fresh) {
    await rm(repo, { recursive: true, force: true });
    try {
      await git(mirror, ["worktree", "prune"]);
    } catch {
      // Nothing to prune.
    }
    await git(mirror, ["worktree", "add", "--force", "--detach", repo, snapshot]);
  } else {
    await git(repo, ["checkout", "--quiet", "--force", "--detach", snapshot]);
    await git(repo, ["clean", "-fdq"]);
  }
  return { step: "checkout", folder: repo };
}

/** A path the agent named: inside its own folder only (or, on its own Mac, `worktree` too: its `repo`), relative
 * ones from `repo/`. */
export function inside(dir: string, repo: string, path: string, worktree = false): string {
  const full = isAbsolute(path) ? path : join(repo, path);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw refuse(`${path} isn't on the Mac`);
  }
  let home = dir;
  try {
    home = realpathSync(dir);
  } catch {
    // As it is.
  }
  const under = (top: string) => real === top || real.startsWith(`${top}/`);
  if (!under(home) && !(worktree && under(realpathSync(repo)))) {
    throw refuse(`${path} is outside your folder on the Mac (${dir})`, "copy it into your folder with mac run first");
  }
  return real;
}

/** One piece of a file in the agent's folder, or of a folder packed as a tar.gz (the first piece packs it). */
export async function get(dir: string, repo: string, path: string, offset: number, raw: boolean, worktree = false): Promise<[Done, Uint8Array]> {
  const real = inside(dir, repo, path, worktree);
  const folder = statSync(real).isDirectory();
  let source = real;
  if (folder) {
    const tag = createHash("sha256").update(real).digest("hex").slice(0, 16);
    source = join(dir, "out", `pull-${tag}.tgz`);
    if (offset === 0) {
      // Links followed: what comes back holds files and folders only.
      const out = await run(["tar", "-czhf", source, "-C", dirname(real), basename(real)]);
      if (out.code !== 0) throw new ToolError("failed", `${path} wasn't packed: ${out.stderr.trim()}`);
    }
  }
  const total = existsSync(source) ? statSync(source).size : 0;
  if (total > PULL_MAX) {
    throw refuse(`${path} is ${total >> 20} MB, more than a pull brings back (${PULL_MAX >> 20} MB)`);
  }
  const data = readFrom(source, offset, PIECE);
  if (folder && offset + data.length >= total) rmSync(source, { force: true });
  if (raw) return [{ step: "get", dataB64: "", total, folder }, data];
  return [{ step: "get", dataB64: Buffer.from(data).toString("base64"), total, folder }, new Uint8Array()];
}
