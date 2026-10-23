// Shared plumbing for the lab scenarios (`npm run lab`): process control by captured PID, a real MCP client, the
// lab machines (each a `fleetd node` with its own HOME, so its own ~/.fleetd and Claude config dir), and helpers that
// wait on hub events instead of sleeping. Never used in CI.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../..");
const LAB_ROOT = process.env.FLEETD_LAB ?? path.join(os.homedir(), "src/fleetd-lab");
/**
 * FLEETD_LAB_SLOT=<n> (0-9, default 0) is an independent lab that can run beside the others. Slot 0 is the lab root
 * itself, slot n lives in <root>/slot-<n> (test repos, run dirs, machine homes, lock), and every lab port is the
 * slot-0 port + 20 * n. The slot-0 ports, 4781 (cmd check), 4782 (chat history), 4795 (hub) and 4796
 * (watchdog hub), all differ mod 20, so slots 0-9 never collide and stay within 4781-4976.
 */
export const SLOT = Number(process.env.FLEETD_LAB_SLOT ?? 0);
if (!Number.isInteger(SLOT) || SLOT < 0 || SLOT > 9) throw new Error(`FLEETD_LAB_SLOT must be 0-9, got ${process.env.FLEETD_LAB_SLOT}`);
export const LAB = SLOT === 0 ? LAB_ROOT : path.join(LAB_ROOT, `slot-${SLOT}`);
export const slotPort = (slot0Port: number) => slot0Port + 20 * SLOT;
export const HUB_PORT = Number(process.env.FLEETD_LAB_HUB_PORT ?? slotPort(4795));
export const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
/** Per hub port, so two runs on different ports never delete each other's state. */
export const RUN = process.env.FLEETD_LAB_RUN ?? path.join(LAB, `e2e-${HUB_PORT}`);
/** Cargo's release output, honouring CARGO_TARGET_DIR as cargo does. */
export const RELEASE = path.join(process.env.CARGO_TARGET_DIR ?? path.join(REPO, "target"), "release");
/** The release build of the binary (`cargo build --release -p fleetd`), so the lab exercises what ships. */
export const CLI = path.join(RELEASE, "fleetd");
/**
 * The command for one fleetd invocation. FLEETD_BIN (default the release build) is the fleetd under test; FLEETD_HUB_BIN,
 * FLEETD_NODE_BIN and FLEETD_CLI_BIN override it for `hub …`, `node …` and everything else, for mixed runs such as
 * two builds side by side. A .js/.mjs/.cjs/.ts bin runs under this node; any other bin is executed directly.
 */
export const fleetdCommand = (args: ReadonlyArray<string>): [string, Array<string>] => {
  const own = args[0] === "hub" ? process.env.FLEETD_HUB_BIN : args[0] === "node" ? process.env.FLEETD_NODE_BIN : process.env.FLEETD_CLI_BIN;
  const given = own ?? process.env.FLEETD_BIN ?? CLI;
  // Some callers spawn with another cwd, so a relative path is resolved here.
  const bin = given.includes("/") ? path.resolve(given) : given;
  return /\.[cm]?[jt]s$/u.test(bin) ? [process.execPath, [bin, ...args]] : [bin, [...args]];
};
export const MODEL = "claude-opus-5-5";
/** Mechanics scenarios' tasks run the medium profile: what they check doesn't depend on how well the model reasons. */
export const MECHANICS = "medium" as const;

// Texts the binary emits that scenarios match on; each mirrors a constant in crates/fleetd.

/** The hub's offline-queue TTL in lab runs, short enough for the expiry check to wait it out. */
export const QUEUE_TTL_SEC = 40;
/** The two standing lab machines, each with its own test repo (seeded on first use) as its project. */
export const MACHINES = [
  { id: "lab-a", repo: path.join(LAB, "repo-a") },
  { id: "lab-b", repo: path.join(LAB, "repo-b") },
] as const;
export type LabMachine = (typeof MACHINES)[number]["id"];

if (path.resolve(LAB).startsWith(path.join(os.homedir(), ".t3"))) throw new Error("refusing: lab dir is inside ~/.t3");
if (path.resolve(LAB).startsWith(path.join(os.homedir(), ".fleetd"))) throw new Error("refusing: lab dir is inside ~/.fleetd");

export type Body = Record<string, any>;

/** Children get HOME, PATH, USER and LANG only: never this session's CLAUDE* variables. */
export const scrubbedEnv = () =>
  Object.fromEntries(["HOME", "PATH", "USER", "LANG"].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));

const userClaudeSettings = (): { env?: Record<string, unknown>; apiKeyHelper?: unknown } => {
  const file = path.join(os.homedir(), ".claude/settings.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { env?: Record<string, unknown> }) : {};
};

/**
 * The user's own `claude` login variables from ~/.claude/settings.json (a gateway's base URL and token, or a token
 * or key). Read only: nothing is ever written under ~/.claude.
 */
export const claudeLoginEnv = (): Record<string, string> => {
  const settings = userClaudeSettings();
  return Object.fromEntries(
    ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].flatMap((k) =>
      typeof settings.env?.[k] === "string" && settings.env[k] !== "" ? [[k, settings.env[k] as string]] : [],
    ),
  );
};

// A lab machine is a `fleetd node` whose HOME is RUN/home-<id>, so everything the node derives from HOME is the
// machine's own: ~/.fleetd/node (node home and socket) and ~/.claude, the user's claude setup that sessions use, as on
// a real machine. The real ~/.fleetd and ~/.claude are never touched.
export const machineHome = (id: string) => path.join(RUN, `home-${id}`);
export const nodeHome = (id: string) => path.join(machineHome(id), ".fleetd/node");
export const nodeSock = (id: string) => path.join(nodeHome(id), "node.sock");
export const claudeConfigDir = (id: string) => path.join(machineHome(id), ".claude");
/** The files a machine's ~/.claude gets from the user's: the login material, never their hooks or plugins. */
const LOGIN_FILES = ["settings.json", ".credentials.json"];

/** The git identity the lab's agents commit with: the user's own (a GitHub noreply address), as on a real machine. */
const gitIdentity = (): Record<string, string> => {
  const get = (key: string, fallback: string) => {
    try {
      return execFileSync("git", ["config", "--global", key], { encoding: "utf8" }).trim() || fallback;
    } catch {
      return fallback;
    }
  };
  const name = get("user.name", "fleetd lab");
  const email = get("user.email", "lab@localhost");
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
};

export interface MachineHomeOptions {
  /** False: an empty ~/.claude, nobody logged in. */
  readonly login?: boolean;
  /** The machine user's ~/.claude/settings.json instead of the copied login (e.g. one pointing at a stub proxy). */
  readonly claudeSettings?: Readonly<Record<string, unknown>>;
}

/**
 * Lays out a machine's HOME before its node starts. `login: true` gives its ~/.claude the user's login material, read
 * from the real ~/.claude and copied (0600, inside the run dir, removed by `cleanupMachineHomes`): a settings.json with
 * only the login variables and `apiKeyHelper` of theirs, and their `.credentials.json` if they have one. `login:
 * false` leaves ~/.claude empty, a machine nobody has logged in on. Agents push to GitHub with the user's
 * `gh` login, copied in (never linked: nothing flows back) along with a .gitconfig that uses it.
 */
export const prepareMachineHome = (id: string, opts: MachineHomeOptions = {}) => {
  const home = machineHome(id);
  for (const dir of [nodeHome(id), claudeConfigDir(id)]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of LOGIN_FILES) fs.rmSync(path.join(claudeConfigDir(id), file), { force: true });
  if (opts.claudeSettings !== undefined) {
    fs.writeFileSync(path.join(claudeConfigDir(id), "settings.json"), `${JSON.stringify(opts.claudeSettings, null, 2)}\n`, { mode: 0o600 });
  } else if (opts.login !== false) {
    const helper = userClaudeSettings().apiKeyHelper;
    const settings = { env: claudeLoginEnv(), ...(typeof helper === "string" ? { apiKeyHelper: helper } : {}) };
    fs.writeFileSync(path.join(claudeConfigDir(id), "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    const credentials = path.join(os.homedir(), ".claude/.credentials.json");
    if (fs.existsSync(credentials)) {
      fs.copyFileSync(credentials, path.join(claudeConfigDir(id), ".credentials.json"));
      fs.chmodSync(path.join(claudeConfigDir(id), ".credentials.json"), 0o600);
    }
  }
  const identity = gitIdentity();
  const ghDir = path.join(os.homedir(), ".config/gh");
  const hasGh = fs.existsSync(path.join(ghDir, "hosts.yml"));
  if (hasGh) {
    fs.mkdirSync(path.join(home, ".config/gh"), { recursive: true, mode: 0o700 });
    for (const file of ["hosts.yml", "config.yml"].filter((f) => fs.existsSync(path.join(ghDir, f)))) {
      fs.copyFileSync(path.join(ghDir, file), path.join(home, ".config/gh", file));
      fs.chmodSync(path.join(home, ".config/gh", file), 0o600);
    }
  }
  const gh = hasGh ? (execFileSync("sh", ["-c", "command -v gh"], { encoding: "utf8" }).trim() || "gh") : "";
  fs.writeFileSync(
    path.join(home, ".gitconfig"),
    `[user]\n\tname = ${identity.GIT_AUTHOR_NAME}\n\temail = ${identity.GIT_AUTHOR_EMAIL}\n[init]\n\tdefaultBranch = main\n` +
      (hasGh ? `[credential "https://github.com"]\n\thelper = \n\thelper = !${gh} auth git-credential\n` : ""),
  );
};

/** Scenarios that push to GitHub as the user: their agents need the user's `gh` login, copied into each machine's HOME. */
export const requireGhLogin = () => {
  if (!fs.existsSync(path.join(os.homedir(), ".config/gh/hosts.yml"))) {
    throw new Error("this scenario pushes to the GitHub lab repo with your gh login, and ~/.config/gh/hosts.yml is missing: run gh auth login");
  }
};

/** Deletes every machine's copied claude login and gh copy: the login stays only as long as the run needs it. */
export const cleanupMachineHomes = () => {
  if (!fs.existsSync(RUN)) return;
  for (const entry of fs.readdirSync(RUN).filter((e) => e.startsWith("home-"))) {
    for (const file of LOGIN_FILES) fs.rmSync(path.join(RUN, entry, ".claude", file), { force: true });
    fs.rmSync(path.join(RUN, entry, ".config/gh"), { recursive: true, force: true });
  }
};

/** A machine's test repo: a git repo on main with one commit, created on first use and kept across runs. */
export const seedRepo = (dir: string, title: string) => {
  if (fs.existsSync(path.join(dir, ".git"))) return;
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: dir, stdio: "ignore", env: { ...scrubbedEnv(), ...gitIdentity() } });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "README.md"), `# ${title} test repo\n`);
  git("add", ".");
  git("commit", "-q", "-m", "init");
};

/** Options for one node process. */
export interface NodeOptions {
  /** Added to the node's environment (e.g. FLEETD_NODE_IDLE_REAP_SEC, FLEETD_NODE_RETRY_SCHEDULE_MS). */
  readonly env?: Readonly<Record<string, string>>;
  /** Directories put first on the node's PATH, which its claude children inherit (e.g. a lab-only claude shim). */
  readonly pathPrefix?: ReadonlyArray<string>;
  /** Replaces the node's PATH (before `pathPrefix`); e.g. a PATH without claude on it. */
  readonly path?: string;
}

/**
 * The node's environment: the scrubbed one with the machine's HOME, `fleetd` (the build under test) first on PATH
 * for the agents' shells, and the user's git identity, which the node passes to its agents as `machine add` would.
 */
export const nodeEnv = (id: string, opts: NodeOptions = {}): Record<string, string> => {
  const base = scrubbedEnv();
  const rest = opts.path ?? base.PATH ?? "";
  return {
    ...base,
    HOME: machineHome(id),
    PATH: [...(opts.pathPrefix ?? []), path.join(RUN, "bin"), rest].filter(Boolean).join(":"),
    // On macOS claude keys its Keychain login to CLAUDE_CONFIG_DIR only when the variable is set; without it a
    // machine's claude would find, and refresh, the user's own login there instead of its copied one.
    ...(process.platform === "darwin" ? { CLAUDE_CONFIG_DIR: claudeConfigDir(id) } : {}),
    ...gitIdentity(),
    ...opts.env,
  };
};

/** `fleetd` on the agents' PATH: a wrapper that runs the fleetd under test. */
export const writeFleetdWrapper = () => {
  fs.mkdirSync(path.join(RUN, "bin"), { recursive: true });
  const [bin, prefix] = fleetdCommand([]);
  const exec = [bin, ...prefix].map((a) => `'${a}'`).join(" ");
  fs.writeFileSync(path.join(RUN, "bin", "fleetd"), `#!/bin/sh\nexec ${exec} "$@"\n`, { mode: 0o755 });
};

/** PATH without the directory that holds `claude`, for a machine whose claude is missing. */
export const pathWithoutClaude = () => {
  const real = execFileSync("sh", ["-c", "command -v claude"], { env: scrubbedEnv(), encoding: "utf8" }).trim();
  return (process.env.PATH ?? "").split(":").filter((d) => d !== "" && path.resolve(d) !== path.dirname(real)).join(":");
};

/** The real claude binary on the user's PATH (for shims that hand over to it). */
export const realClaude = () => execFileSync("sh", ["-c", "command -v claude"], { env: scrubbedEnv(), encoding: "utf8" }).trim();

/** A process from /proc: its start time (clock ticks since boot) tells a live pid from a reused one. */
export interface ProcInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly cmdline: ReadonlyArray<string>;
}

export const procInfo = (pid: number): ProcInfo | undefined => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may hold spaces and parentheses; the rest follows the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return undefined;
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), startTime: fields[19]!, cmdline };
  } catch {
    return undefined;
  }
};

/** Every live descendant of `pid`, by walking /proc ppid links (read only). */
export const descendants = (pid: number): Array<ProcInfo> => {
  const all = fs.readdirSync("/proc").filter((d) => /^\d+$/u.test(d)).flatMap((d) => procInfo(Number(d)) ?? []);
  const out: Array<ProcInfo> = [];
  const frontier = [pid];
  while (frontier.length > 0) {
    const parent = frontier.pop()!;
    for (const p of all.filter((x) => x.ppid === parent)) {
      out.push(p);
      frontier.push(p.pid);
    }
  }
  return out;
};

/** True while a recorded process still runs: same pid and same start time. */
export const stillRuns = (p: Pick<ProcInfo, "pid" | "startTime">) => procInfo(p.pid)?.startTime === p.startTime;

/**
 * A thread's raw record on its machine, for checks the MCP tools cut short: the node's transcript of claude's stdout
 * (init tool lists, results) plus claude's own session file (every user message in full). Both JSON lines, so a
 * newline in a message reads as \n.
 */
export const sessionText = (machineId: string, threadId: string): string => {
  const parts: Array<string> = [];
  const transcript = path.join(nodeHome(machineId), "transcripts", `${threadId}.jsonl`);
  if (fs.existsSync(transcript)) parts.push(fs.readFileSync(transcript, "utf8"));
  const projects = path.join(claudeConfigDir(machineId), "projects");
  if (fs.existsSync(projects)) {
    for (const dir of fs.readdirSync(projects)) {
      const file = path.join(projects, dir, `${threadId}.jsonl`);
      if (fs.existsSync(file)) parts.push(fs.readFileSync(file, "utf8"));
    }
  }
  return parts.join("\n");
};

/**
 * The user messages claude recorded for a thread, in full and in order, from its own session file
 * (`~/.claude/projects/<cwd>/<session>.jsonl`). Tool results, which claude files as user turns too, are left out.
 */
export const userMessages = (machineId: string, threadId: string): Array<string> => {
  const projects = path.join(claudeConfigDir(machineId), "projects");
  if (!fs.existsSync(projects)) return [];
  const out: Array<string> = [];
  for (const dir of fs.readdirSync(projects)) {
    const file = path.join(projects, dir, `${threadId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      const entry = JSON.parse(line) as Body;
      if (entry.type !== "user" || entry.isMeta === true) continue;
      const content = entry.message?.content as string | Array<Body> | undefined;
      const text = typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text as string).join("\n");
      if (text !== "") out.push(text);
    }
  }
  return out;
};

/** The tools claude reported at session start (`system/init`) for a thread, from its transcript. */
export const initTools = (machineId: string, threadId: string): ReadonlyArray<string> | undefined => {
  const tools = /"subtype":\s*"init".*?"tools":\s*(\[[^\]]*\])/u.exec(sessionText(machineId, threadId))?.[1];
  return tools === undefined ? undefined : (JSON.parse(tools) as Array<string>);
};

const t0 = Date.now();
export const log = (line: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}\n`);
export const ok = (line: string) => log(`ok  ${line}`);
export const check = (cond: unknown, what: string): void => {
  if (!cond) throw new Error(`check failed: ${what}`);
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries `probe` until it returns a value. Probes long-poll events_wait, so this does not spin. */
export async function until<A>(what: string, ms: number, probe: () => Promise<A | undefined>): Promise<A> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out after ${ms / 1000}s: ${what}`);
}

export const cli = (...args: Array<string>) =>
  execFileSync(...fleetdCommand(args), { env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const LOCK = path.join(LAB, "test-lab.lock");

/** Whether a process exists (signal 0); no /proc, so it works on macOS too. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** One lab run per slot at a time (test:lab, site-capture): they share the slot's test repos and run dir. */
export const takeLabLock = () => {
  fs.mkdirSync(LAB, { recursive: true });
  try {
    const holder = Number(fs.readFileSync(LOCK, "utf8").trim());
    if (holder > 0 && alive(holder)) throw new Error(`another lab run (pid ${holder}) holds ${LOCK}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.writeFileSync(LOCK, `${process.pid}\n`);
  process.once("exit", () => fs.rmSync(LOCK, { force: true }));
};

const started: Array<{ name: string; child: ChildProcess }> = [];

let interruptible = false;
let interrupt: (error: Error) => void = () => undefined;
/** Rejects on the first SIGINT, SIGTERM or SIGHUP once `handleInterrupts` is on; never resolves. */
export const interrupted = new Promise<never>((_, reject) => {
  interrupt = reject;
});
interrupted.catch(() => undefined);

/**
 * For a driver that stops what it started itself: a signal rejects `interrupted` instead of killing this process,
 * and children start in their own process group, so the terminal's Ctrl-C reaches only this process and the lab's
 * processes are stopped by their PIDs, after the cleanups (`onCleanup`).
 */
export const handleInterrupts = () => {
  interruptible = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      log(`${signal}: stopping what this run started`);
      interrupt(new Error(`interrupted by ${signal}`));
    });
  }
};

const cleanups: Array<() => Promise<void>> = [];
/** Registers `fn` to run once: when the returned function is called, or by `runCleanups` before the lab stops. */
export const onCleanup = (fn: () => Promise<void>) => {
  let ran = false;
  const once = async () => {
    if (ran) return;
    ran = true;
    await fn();
  };
  cleanups.push(once);
  return once;
};
export const runCleanups = async () => {
  for (const fn of cleanups.splice(0).toReversed()) await fn().catch((error: unknown) => log(`cleanup failed: ${String(error)}`));
};

/**
 * Every process the lab starts, as `<pid> <binary>` in RUN/pids: scripts/demo-mac.sh stops whatever is still running
 * from it if this driver itself was killed.
 */
export const recordPid = (pid: number | undefined, bin: string) => {
  if (pid === undefined) return;
  fs.mkdirSync(RUN, { recursive: true });
  fs.appendFileSync(path.join(RUN, "pids"), `${pid} ${bin}\n`);
};

/** Spawn options for a lab process: its own process group while interrupts are handled (see `handleInterrupts`). */
export const detached = () => ({ detached: interruptible });

/** Starts `fleetd <args>` with `env` (default: the scrubbed environment), logging to RUN/logs/<name>.log. */
export const startCli = (name: string, args: Array<string>, env: Record<string, string> = {}, fullEnv?: Record<string, string>) => {
  fs.mkdirSync(path.join(RUN, "logs"), { recursive: true });
  const out = fs.openSync(path.join(RUN, "logs", `${name}.log`), "a");
  const [bin, argv] = fleetdCommand(args);
  const child = spawn(bin, argv, { env: fullEnv ?? { ...scrubbedEnv(), ...env }, stdio: ["ignore", out, out], ...detached() });
  started.push({ name, child });
  recordPid(child.pid, bin);
  log(`started ${name} pid=${child.pid}`);
  return child;
};

/** The PID of the newest live process started under `name`. */
export const pidOf = (name: string): number | undefined => {
  const entry = started.findLast((s) => s.name === name);
  return entry !== undefined && entry.child.exitCode === null && entry.child.signalCode === null ? entry.child.pid : undefined;
};

/** Stops the newest process started under `name`, by the PID captured at spawn: SIGTERM, then SIGKILL after 10 s. */
export const stopCli = async (name: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
  const entry = started.findLast((s) => s.name === name);
  if (!entry || entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  const exited = new Promise((r) => entry.child.once("exit", r));
  const startedMs = Date.now();
  entry.child.kill(signal);
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    entry.child.kill("SIGKILL");
  }, 10_000);
  await exited;
  clearTimeout(timer);
  log(`stopped ${name} pid=${entry.child.pid} (${killed ? "SIGKILL after 10 s" : `${signal}, exited in ${Date.now() - startedMs} ms`})`);
};

export const isRunning = (name: string) => pidOf(name) !== undefined;

export const stopAll = async () => {
  for (const name of [...new Set(started.map((s) => s.name))].toReversed()) await stopCli(name);
};

/** `node join` for a machine on `hubHome`'s hub: an enrollment token, the machine's HOME, then the node itself. */
const joinArgs = (hubUrl: string, hubHome: string, id: string, opts: MachineHomeOptions) => {
  prepareMachineHome(id, opts);
  const token = /^\S{16,}$/mu.exec(cli("hub", "token", "create", "--home", hubHome, "--machine", id))?.[0];
  if (token === undefined) throw new Error(`no enrollment token for ${id}`);
  return ["node", "join", "--hub", hubUrl, "--token", token, "--machine", id, "--home", nodeHome(id)];
};

export const joinNode = (hubUrl: string, hubHome: string, id: string, opts: NodeOptions & MachineHomeOptions = {}) =>
  startCli(`node-${id}`, joinArgs(hubUrl, hubHome, id, opts), {}, nodeEnv(id, opts));

/** `node join --enroll-only`: the machine's home and key, enrolled, and no node left running. */
export const enrollNode = (hubUrl: string, hubHome: string, id: string, opts: NodeOptions & MachineHomeOptions = {}) =>
  void execFileSync(...fleetdCommand([...joinArgs(hubUrl, hubHome, id, opts), "--enroll-only"]), { env: nodeEnv(id, opts), stdio: "ignore", timeout: 60_000 });

/**
 * Lets the node run the hub's `cmd` checks under `roots`. A node defaults to its HOME, which in the lab is the
 * machine's own home under the run dir, not where the test repos live. Takes effect at the node's next start.
 */
export const setCmdRoots = (id: string, roots: ReadonlyArray<string>) => {
  const file = path.join(nodeHome(id), "node.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as Body;
  fs.writeFileSync(file, `${JSON.stringify({ ...config, cmdRoots: roots }, null, 2)}\n`);
};

/** Everything a scenario gets. It also satisfies the narrower contexts the scenario files declare. */
export interface Lab {
  readonly hubUrl: string;
  readonly hubHome: string;
  /** An operate key on every machine. */
  readonly key: string;
  /** Calls with a person's key, as the desktop app pairs one: chat_send and the other human-only tools. */
  readonly humanCall: (name: string, args?: Record<string, unknown>) => Promise<{ readonly isError: boolean; readonly body: Body }>;
  /** Scratch directory for one scenario; it may not exist yet. */
  readonly dir: string;
  readonly callTool: (name: string, args?: Record<string, unknown>) => Promise<{ readonly isError: boolean; readonly body: Body }>;
  readonly log: typeof log;
  readonly ok: typeof ok;
  readonly check: typeof check;
  readonly until: typeof until;
  readonly startCli: typeof startCli;
  readonly stopCli: typeof stopCli;
  /** Stops the machine's node by its PID (SIGTERM, a graceful stop; SIGKILL, a crash). */
  readonly stopNode: (machineId: string, signal?: "SIGTERM" | "SIGKILL") => Promise<void>;
  /** Starts the machine's node again (`node run`, since it has joined), with `opts` for this process only. */
  readonly startNode: (machineId: string, opts?: NodeOptions) => void;
  /** The live node's PID, captured at spawn. */
  readonly nodePid: (machineId: string) => number | undefined;
  /** Joins a new machine to the hub (its own HOME under the run dir) and starts its node. */
  readonly joinNode: (machineId: string, opts?: NodeOptions & MachineHomeOptions) => Promise<void>;
  /** Registers a directory as a project on a machine with `project_add`; returns its project id once listed. */
  readonly addProject: (machineId: string, dir: string, title: string) => Promise<string>;
  /** (Re)starts the hub on the same home and port with `env` added, waits for /healthz and reconnects the MCP client. */
  readonly startHub: (env?: Readonly<Record<string, string>>) => Promise<void>;
  /** Stops the hub by its PID, leaving the nodes and their sessions running. */
  readonly stopHub: () => Promise<void>;
  readonly machines: typeof MACHINES;
  /** Waits for the first event after `cursor` that matches, long-polling events_wait. */
  readonly waitEvent: (
    what: string,
    ms: number,
    filter: { readonly cursor: number; readonly types?: ReadonlyArray<string>; readonly machineId?: string; readonly match?: (e: Body) => boolean },
  ) => Promise<{ readonly event: Body; readonly cursor: number }>;
  /** Waits until the machine is online with a live session link (its project reads are not stale). */
  readonly waitLive: (machineId: string) => Promise<void>;
  /** The project lead's thread on the machine, once its run has finished; starts the lead if there is none. */
  readonly idleThread: (machineId: string) => Promise<{ readonly threadId: string; readonly projectId: string }>;
  /** The hub's current event cursor. */
  readonly cursor: () => Promise<number>;
}

export const callToolWith =
  (client: () => Client): Lab["callTool"] =>
  async (name, args = {}) => {
    const send = () => client().callTool({ name, arguments: args }, undefined, { timeout: 70_000 });
    const result = await send()
      // After a few idle seconds the hub's HTTP server may close the kept-alive socket just as the next request goes
      // out on it; that request never reached the hub, so it is sent once more.
      .catch((error: unknown) => (/other side closed/u.test(String((error as Error).cause)) ? send() : Promise.reject(error)))
      .catch((error: unknown) => {
        // The SDK's "fetch failed" names neither the tool nor why.
        const cause = error instanceof Error && error.cause !== undefined ? ` (${String(error.cause)})` : "";
        throw new Error(`MCP ${name} failed: ${error instanceof Error ? error.message : String(error)}${cause}`);
      });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    return { isError: result.isError === true, body: JSON.parse(text) as Body };
  };

export const waitEventWith =
  (callTool: Lab["callTool"]): Lab["waitEvent"] =>
  async (what, ms, filter) => {
    let cursor = filter.cursor;
    const event = await until(what, ms, async () => {
      const page = (
        await callTool("events_wait", {
          cursor,
          timeoutSec: 50,
          ...(filter.types === undefined ? {} : { types: filter.types }),
          ...(filter.machineId === undefined ? {} : { machineId: filter.machineId }),
        })
      ).body;
      const found = (page.events as Array<Body>).find((e) => filter.match?.(e) ?? true);
      cursor = found === undefined ? page.cursor : found.seq;
      return found;
    });
    return { event, cursor };
  };

/**
 * An order as a person gives one: a chat message to the project's lead (chat_send, a person's key), which opens the
 * order's workstream with workstream_open. Resolves with that workstream, the chat_send result, and the event cursor
 * from before the message.
 */
export const chatOrder = async (
  lab: Pick<Lab, "humanCall" | "check" | "waitEvent" | "cursor">,
  projectRef: { readonly machineId: string; readonly projectId: string },
  text: string,
  ms = 240_000,
) => {
  const cursor = await lab.cursor();
  const sent = await lab.humanCall("chat_send", { projectRef, text, clientRequestId: randomUUID() });
  lab.check(!sent.isError, `chat_send: ${JSON.stringify(sent.body)}`);
  const { event } = await lab.waitEvent("the lead opens the order's workstream (workstream.created)", ms, {
    cursor,
    types: ["workstream.created"],
    match: (e) => e.machineId === projectRef.machineId && e.projectId === projectRef.projectId,
  });
  const workstreamId = (event.data?.workstreamId as string | undefined) ?? /\bW\d+\b/u.exec(String(event.summary))?.[0];
  lab.check(workstreamId, `workstream.created names its workstream: ${JSON.stringify(event)}`);
  return { workstreamId: workstreamId!, sent: sent.body, cursor };
};

/**
 * A workstream opened from the project's shell as its lead would (`fleetd workstream open`), for an order whose brief
 * and agents the harness sets up itself. No lead turn: the opener already knows.
 */
export const openWorkstream = (
  check: Lab["check"],
  fleetd: (...args: Array<string>) => { readonly code: number | null; readonly stdout: string; readonly stderr: string },
  text: string,
) => {
  const out = fleetd("workstream", "open", "--text", text);
  const w = /\bOpened (W\d+)/u.exec(out.stdout)?.[1];
  check(out.code === 0 && w, `fleetd workstream open: ${JSON.stringify(out)}`);
  return w!;
};

/**
 * Runs `prompt` in a fresh session of the project's lead, the way any session starts (there is no raw launch): the lead
 * (re)starts (a lead always runs high), its first turn (lead.start) ends, then `prompt` goes in as a person's chat message.
 * Resolves with the lead's thread and the event cursor from just before the message.
 */
export const leadRun = async (
  lab: Pick<Lab, "callTool" | "humanCall" | "check" | "waitEvent" | "cursor">,
  machineId: string,
  projectId: string,
  prompt: string,
) => {
  const ref = { machineId, projectId };
  const from = await lab.cursor();
  let started = await lab.callTool("lead_restart", ref);
  if (started.isError && started.body.code === "not_found") started = await lab.callTool("lead_start", ref);
  lab.check(!started.isError, `lead (re)start on ${machineId}: ${JSON.stringify(started.body)}`);
  const threadId = started.body.threadId as string;
  await lab.waitEvent(`the lead's first turn on ${machineId} to end`, 240_000, {
    cursor: from,
    machineId,
    types: ["thread.completed", "thread.failed", "thread.interrupted"],
    match: (e) => e.threadId === threadId,
  });
  const cursor = await lab.cursor();
  const sent = await lab.humanCall("chat_send", { projectRef: ref, text: prompt, clientRequestId: randomUUID() });
  lab.check(!sent.isError && sent.body.leadWaiting === undefined, `chat_send on ${machineId}: ${JSON.stringify(sent.body)}`);
  return { threadId, cursor };
};
