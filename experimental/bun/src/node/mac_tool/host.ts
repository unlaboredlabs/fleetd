// The agents' Mac's node (crates/fleetd/src/node/mac_tool/host.rs, jobs.rs): each `mac_call` from the hub is one
// sealed step of an agent's, opened with this node's box key, checked (sealed for the session the hub names, lately,
// never before), and run in that agent's own folder under `<home>/mac/<task or session>/`: its `repo/` checked out
// from the project's mirror, its jobs, the files it put and pulls. The answer goes back sealed with the step's key.
//
// iOS simulators (`sim_start`, `sim_end`) are node/device/ios's (sims.ts), set here as `sims` where the Mac has them.
//
// TODO(bun): the menu bar's activity, and the sweep of folders untouched for FOLDER_DAYS.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, basename, isAbsolute, join } from "node:path";
import type { Subprocess } from "bun";
import { ToolError } from "../../shared/errors.ts";
import type { MacSims } from "../device/ios/sims.ts";
import type { MacCaller, MacCallFrame, MacResultFrame, McpToolError } from "../../shared/screens_wire.ts";
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

/** Each agent's builds keep their own DerivedData on the agents' Mac. */
const XCODEBUILD = `#!/bin/sh
# fleetd: each agent's builds keep their own DerivedData on the agents' Mac ($FLEETD_MAC_DERIVED_DATA).
for a in "$@"; do
  case "$a" in -derivedDataPath) exec /usr/bin/xcodebuild "$@" ;; esac
done
for a in "$@"; do
  case "$a" in
    build|build-for-testing|test|test-without-building|analyze|archive|clean|docbuild|-resolvePackageDependencies|-showBuildSettings)
      exec /usr/bin/xcodebuild "$@" -derivedDataPath "$FLEETD_MAC_DERIVED_DATA" ;;
  esac
done
exec /usr/bin/xcodebuild "$@"
`;

const refuse = (message: string, fix?: string) => new ToolError("invalid", message, fix);
const failed = (what: string, e: unknown) => new ToolError("failed", `${what}: ${e instanceof Error ? e.message : String(e)}`);

/** An agent's folder on the Mac, by task (else by session), and the project it works on. */
export type Agent = { dir: string; project: string; name: string };
const repoOf = (a: Agent) => join(a.dir, "repo");

function git(dir: string, args: string[], stdin?: Uint8Array): string {
  const out = Bun.spawnSync(["git", "-C", dir, ...args], { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new ToolError("failed", `git ${args[0]} failed on the Mac: ${out.stderr.toString().trim()}`);
  return out.stdout.toString();
}

type Job = { command: string; background: boolean; startedMs: number; child: Subprocess; log: string; exit: number | undefined; followed: number };

/** A job's shell: zsh as a login shell where there is one, so the agent's tools are on the PATH. */
export function shellLine(args: string[]): string[] {
  const line = args.join(" ");
  return existsSync("/bin/zsh") ? ["/bin/zsh", "-lc", line] : ["/bin/sh", "-c", line];
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
    FLEETD_MAC_REPO: join(agent.dir, "repo"),
    FLEETD_MAC_DERIVED_DATA: join(agent.dir, "DerivedData"),
    FLEETD_MAC_CACHE: cache,
    // Manners, not a fence: the Mac's node takes no calls from its jobs.
    FLEETD_NODE_SOCK: "/dev/null",
  });
  // The agent's simulator: agent-device's wrapper first on the PATH, pointed at it, and for plain simctl its udid and set.
  for (const [k, v] of sim?.(env.PATH!) ?? []) env[k] = v;
  for (const { name, value } of named) env[name] = value;
  return env;
}

/** Masks the values the agent sent along with its job in what the job logs. */
function masker(named: MacEnv[]): (text: string) => string {
  const values = named.map((e) => [e.value, `***${e.name}***`] as const).filter(([v]) => v.length >= 4).sort((a, b) => b[0].length - a[0].length);
  return (text) => values.reduce((t, [v, shown]) => t.split(v).join(shown), text);
}

export class Host {
  /** Nonces seen within twice the skew. */
  private readonly seen = new Map<string, number>();
  private readonly jobs = new Map<string, { next: number; jobs: Map<number, Job> }>();
  /** The Mac's iOS simulators, where it has them (node/device/ios). */
  sims: MacSims | undefined;

  constructor(
    /** `<home>/mac`: each agent's folder, and `.mirrors/` of each project's snapshots. */
    readonly root: string,
    /** This node's box key: what the agents' nodes seal their steps to. */
    private readonly key: { open(sealed: Uint8Array): Uint8Array | null },
    private readonly clock: () => number = Date.now,
  ) {}

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
      const agent = this.agent(frame.caller);
      // Any step of the agent's keeps its simulator.
      this.sims?.touch(agent.name);
      const [done, after] = await this.step(agent, envelope.step, raw);
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

  /** The caller's folder, made with its `bin/` the first time: by task, else by session. */
  agent(caller: MacCaller): Agent {
    const named = caller.taskId ?? caller.threadId;
    const name = safePart(named);
    if (!name) throw refuse(`${named} can't name a folder`);
    const project = safePart(caller.projectId);
    if (!project) throw refuse("the project's id can't name a folder");
    const dir = join(this.root, name);
    try {
      for (const sub of ["jobs", "in", "out", "tmp", "bin", "DerivedData"]) mkdirSync(join(dir, sub), { recursive: true });
      const shim = join(dir, "bin", "xcodebuild");
      if (!existsSync(shim)) writeFileSync(shim, XCODEBUILD, { mode: 0o755 });
      // Touched by every step: what the sweep goes by.
      writeFileSync(join(dir, ".used"), "");
    } catch (e) {
      throw failed("the agent's folder on the Mac was not made", e);
    }
    return { dir, project, name };
  }

  private mirror(project: string): string {
    return join(this.root, ".mirrors", `${project}.git`);
  }

  /** The step, with the raw bytes after it (a `put`'s piece); the answer, with those that go after it (a raw `get`'s). */
  async step(agent: Agent, step: Step, raw: Uint8Array = new Uint8Array()): Promise<[Done, Uint8Array]> {
    const none = new Uint8Array();
    switch (step.step) {
      case "have":
        return [{ step: "have", snapshots: haves(this.mirror(agent.project), agent.name), raw: true }, none];
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
        return [checkout(this.mirror(agent.project), repoOf(agent), agent.name, step.snapshot, pack), none];
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
        return get(agent.dir, repoOf(agent), step.path, step.offset, step.raw ?? false);
      case "sim_start":
        if (!this.sims) {
          throw new ToolError(
            "failed",
            "The agents' Mac has no iOS simulators: its golden simulator isn't made.",
            "do without a simulator and say so; an admin finishes the Mac's setup in Settings › Hub › Machines",
          );
        }
        return [await this.sims.start(agent, step.device), none];
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
    if (!mine) this.jobs.set(agent.name, (mine = { next: 0, jobs: new Map() }));
    const running = [...mine.jobs.values()].filter((j) => j.exit === undefined).length;
    if (running >= RUNNING_MAX) {
      throw refuse(`you have ${running} jobs running on the Mac, the most at once`, "end some with mac kill (mac ps lists them)");
    }
    mkdirSync(this.cache(), { recursive: true });
    const job = ++mine.next;
    const log = join(agent.dir, "jobs", `${job}.log`);
    const mask = masker(named);
    const fd = openSync(log, "w");
    const cwd = existsSync(repoOf(agent)) ? repoOf(agent) : agent.dir;
    let child: Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(shellLine(args), {
        cwd,
        env: jobEnv(agent, this.cache(), named, process.env, (path) => this.sims?.env(agent.name, path)),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
    } catch (e) {
      closeSync(fd);
      throw failed("the command didn't start on the Mac", e);
    }
    const entry: Job = { command: mask(args.join(" ")), background, startedMs: this.clock(), child, log, exit: undefined, followed: Date.now() };
    mine.jobs.set(job, entry);
    const copy = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) writeSync(fd, mask(decoder.decode(chunk, { stream: true })));
    };
    void Promise.all([copy(child.stdout), copy(child.stderr)]).then(async () => {
      const code = await child.exited;
      closeSync(fd);
      entry.exit = child.signalCode ? 128 + (signalNumber(String(child.signalCode)) ?? 0) : code;
    });
    if (!background) void this.endUnfollowed(agent.name, job);
    return { step: "run", job };
  }

  /** A foreground job its agent stopped following ends. */
  private async endUnfollowed(agent: string, job: number): Promise<void> {
    for (;;) {
      const j = this.jobs.get(agent)?.jobs.get(job);
      if (!j || j.exit !== undefined) return;
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

  /** SIGTERM to the job's process group, SIGKILL after KILL_GRACE; false when it wasn't running. */
  private kill(agent: string, job: number): boolean {
    const j = this.jobs.get(agent)?.jobs.get(job);
    if (!j || j.exit !== undefined) return false;
    const pgid = j.child.pid;
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pgid, sig);
      } catch {
        j.child.kill(sig);
      }
    };
    signal("SIGTERM");
    setTimeout(() => j.exit === undefined && signal("SIGKILL"), KILL_GRACE);
    return true;
  }

  /** Every job ends with the node. */
  stop(): void {
    for (const [agent, mine] of this.jobs) for (const job of mine.jobs.keys()) this.kill(agent, job);
  }
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
const signalNumber = (name: string) => SIGNALS[name];

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
export function haves(mirror: string, agent: string): string[] {
  if (!existsSync(mirror)) return [];
  let listed = "";
  try {
    listed = git(mirror, ["for-each-ref", "--sort=-committerdate", "--format=%(objectname)", "refs/fleetd/"]);
  } catch {
    // An empty mirror.
  }
  const out: string[] = [];
  try {
    const own = git(mirror, ["rev-parse", "--verify", "-q", `refs/fleetd/${agent}`]).trim();
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

/**
 * The agent's `repo/` becomes `snapshot`: the pack goes into the project's mirror first, the snapshot is kept there
 * under the agent's name, and the worktree is checked out at it. Files git ignores (builds, node_modules) stay.
 */
export function checkout(mirror: string, repo: string, name: string, snapshot: string, pack: string | undefined): Done {
  if (!snapshotId(snapshot)) throw refuse(`${snapshot} is not a commit id`);
  if (!existsSync(mirror)) {
    mkdirSync(mirror, { recursive: true });
    git(mirror, ["init", "--quiet", "--bare"]);
  }
  const commit = `${snapshot}^{commit}`;
  const has = () => {
    try {
      git(mirror, ["cat-file", "-e", commit]);
      return true;
    } catch {
      return false;
    }
  };
  // A checkout sent again after its answer was lost: its pack went into the mirror already.
  if (pack !== undefined && !(!existsSync(pack) && has())) {
    if (!existsSync(pack)) throw refuse("the push's pack is missing", "run mac push again");
    const data = Bun.file(pack);
    const out = Bun.spawnSync(["git", "-C", mirror, "index-pack", "--stdin", "--fix-thin"], { stdin: data, stdout: "pipe", stderr: "pipe" });
    rmSync(pack, { force: true });
    if (out.exitCode !== 0) {
      throw new ToolError("failed", `the push's pack didn't index: ${out.stderr.toString().trim()}`, "run mac push again");
    }
  }
  if (!has()) throw refuse("the Mac doesn't have that snapshot", "run mac push again");
  git(mirror, ["update-ref", `refs/fleetd/${name}`, snapshot]);
  let fresh = !existsSync(join(repo, ".git"));
  if (!fresh) {
    try {
      git(repo, ["rev-parse", "--git-dir"]);
    } catch {
      fresh = true;
    }
  }
  if (fresh) {
    rmSync(repo, { recursive: true, force: true });
    try {
      git(mirror, ["worktree", "prune"]);
    } catch {
      // Nothing to prune.
    }
    git(mirror, ["worktree", "add", "--force", "--detach", repo, snapshot]);
  } else {
    git(repo, ["checkout", "--quiet", "--force", "--detach", snapshot]);
    git(repo, ["clean", "-fdq"]);
  }
  return { step: "checkout", folder: repo };
}

/** A path the agent named: inside its own folder only, relative ones from `repo/`. */
export function inside(dir: string, repo: string, path: string): string {
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
  if (real !== home && !real.startsWith(`${home}/`)) {
    throw refuse(`${path} is outside your folder on the Mac (${dir})`, "copy it into your folder with mac run first");
  }
  return real;
}

/** One piece of a file in the agent's folder, or of a folder packed as a tar.gz (the first piece packs it). */
export function get(dir: string, repo: string, path: string, offset: number, raw: boolean): [Done, Uint8Array] {
  const real = inside(dir, repo, path);
  const folder = statSync(real).isDirectory();
  let source = real;
  if (folder) {
    const tag = createHash("sha256").update(real).digest("hex").slice(0, 16);
    source = join(dir, "out", `pull-${tag}.tgz`);
    if (offset === 0) {
      // Links followed: what comes back holds files and folders only.
      const out = Bun.spawnSync(["tar", "-czhf", source, "-C", dirname(real), basename(real)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      if (out.exitCode !== 0) throw new ToolError("failed", `${path} wasn't packed: ${out.stderr.toString().trim()}`);
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
