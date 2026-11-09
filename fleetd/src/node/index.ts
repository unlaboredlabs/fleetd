// `fleetd node …`: the node's link to its hub, its sessions, the lead socket, cmd
// checks, sealed secrets, approved commands and node actions. A session's claude runs under a host of its own, this
// binary's `fleetd session-host` (./runner/host.ts), which outlives the node.
import { refreshOwnUnit } from "../cli/setup/units.ts";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CAP } from "./wire.ts";
import { runNodeAction } from "./actions/index.ts";
import { Node } from "./api.ts";
import { registerAreas, stopAreas } from "./areas.ts";
import { agentsMac, isAgentsMac, mayJoin } from "./agents_mac/index.ts";
import { helloCapabilities, refusedOnMac } from "./link/tool_only.ts";
import { current as currentScope } from "./runner/scope.ts";
import { runCmdCheck } from "./cmd/index.ts";
import { defaultNodeHome, isMachineId, readConfig, writeConfig, type NodeConfig } from "./config.ts";
import { GatedRuns } from "./gated/index.ts";
import { loadOrCreateBoxKey, loadOrCreateIdentity } from "./identity.ts";
import { LeadRelay, leadSocketPath, serveLeadSocket, type LeadResultFrame } from "./lead/index.ts";
import { runNode, type LinkContext } from "./link/index.ts";
import { read as readLoad } from "./load/index.ts";
import { runPower, Wakes } from "./power/index.ts";
import { pinSelf } from "./self_exe.ts";
import { deliverSecret, type SecretsContext } from "./secrets/index.ts";
import { configFor, runnerEnv, SessionService } from "./sessions/index.ts";
import { RealClaude, turnAutoupdaterOff } from "./runner/install.ts";
import { LOGINS } from "./runner/login.ts";
import { notRestarted, run as runUpdate, runFetch } from "./update/index.ts";
import { holdForScreens, ScreensRestart } from "./restart.ts";
import { apply as applyScreens } from "./screens/index.ts";
import { broker, screenHooks } from "./browser/index.ts";
import { router as screens } from "./device/router.ts";
import { router as sessionRoute } from "./session_route/index.ts";
import { ANSWER_WAIT_MS, HEALTH_WAIT_SECS, markAnswered, markUp } from "../update/finish.ts";
import { rmSync } from "node:fs";
import { configDir } from "./runner/claude.ts";
import { homeDir, selfArgv } from "./util.ts";
import type { CmdCheck, GatedResume, GatedRun, HubFrame, NodeAction, SecretDeliver } from "./wire.ts";
import { fleetdDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";
import { protect } from "./oom.ts";
import { uploads } from "./flush.ts";

export const NODE_USAGE = `  node join --hub <url> (--token <token> | --token-file <file|->) --machine <id>
            [--home <dir>] [--enroll-only] [--claude-config-dir <dir>]
             enroll this machine with the hub, then keep its link up (node home default ~/.fleetd/node);
             --token-file - reads the token from stdin; --enroll-only exits once the hub has accepted this
             node; sessions use your own claude setup (~/.claude) unless --claude-config-dir names a
             dedicated one
  node run [--home <dir>]
             keep the link up for a machine that has joined
`;

/** Every capability the Bun node lists in its hello: what its modules take. */
export const CAPABILITIES = [
  CAP.REPOS, CAP.DETACHED, CAP.PROJECT_SETTINGS, CAP.WORKTREE_SETUP, CAP.CLAUDE_INSTALL, CAP.CLAUDE_LOGIN, CAP.SELF_UPDATE, CAP.UPDATE_FETCH, CAP.SCREEN_SETTINGS, CAP.PROJECT_ENV_COPY, CAP.ORDER_ENV, CAP.ALLOWED_ONLY, CAP.UPDATE_HOLD,
  CAP.SESSION_SEAL, CAP.PROFILE_NAMES, CAP.SYSTEM_PROMPT, CAP.ASSISTANT, CAP.FOLDER_MAKE, CAP.ISOLATED, CAP.NAVI_ERASE,
  CAP.PROJECT_ERASE, CAP.ONE_LEAD_MODE, CAP.LINK_DEFLATE, CAP.GATED_RESUME, CAP.HAS_FILE,
  CAP.LANDED_LOG, CAP.MCP_SERVERS, CAP.SKILLS, CAP.NAVI_SIGNINS, CAP.CLAUDE_ACCOUNTS, CAP.CLAUDE_RESEAL, CAP.ONEPASSWORD,
  CAP.ONEPASSWORD_CARDS, CAP.CLAUDE_MODELS, CAP.BUILD_BUN,
];

/** A hash of the OS's id for this computer (fingerprint.rs): the hub never enrolls a second computer under one id. */
/** Ends the hold (node/hold.rs `clear`): every tool call waiting on it starts. */
function clearHold(home: string): void {
  for (const f of ["hold", "hold.screens", "hold.update", "held"]) rmSync(join(home, "update", f), { recursive: true, force: true });
}

/** What a stopped node left that nothing uses now: the remote-screen forwarders and folders of its sessions (their
 * screens went with it) and the Telegram state of an older node (D339). Stale pins are self_exe.ts's. */
export function startupCleanups(home: string): void {
  let sessions: string[] = [];
  try {
    sessions = readdirSync(join(home, "sessions"));
  } catch {}
  for (const id of sessions) for (const dir of ["device-remote", "device-work"]) rmSync(join(home, "sessions", id, dir), { recursive: true, force: true });
  rmSync(join(home, "telegram"), { recursive: true, force: true });
}

/** The node's own temp dir, for it and everything it starts, when its environment names none. Not under `tmp/`: that
 * is the sessions' scratch dirs, which the node prunes and whose processes it stops as a dead node's leftovers. */
export const ownTmp = (home: string) => join(home, "own-tmp");

type Exec = (file: string, args: string[], env: Record<string, string>) => void;
// Bun has Node's process.execve; its types don't yet.
const execve: Exec = (file, args, env) => (process as unknown as { execve: Exec }).execve(file, args, env);

/**
 * A node started without TMPDIR (a systemd unit, a lab's scrubbed environment) would leave its temp files and those
 * of everything it starts in /tmp, which may be held in memory: on Nov 8 throwaway lab nodes, each killed while it
 * downloaded Chrome, left 107 zips (4.2 GB) there. Such a node runs itself again at once (execve: the same pid, its
 * stdin unread) with TMPDIR on disk under its home, after pruning what earlier nodes left there (pruneOwnTmp). Setting
 * process.env would not do: Bun's spawns without an `env` take the environment the process started with. Returns when
 * TMPDIR is set, or when the exec failed (the node then runs on as it is).
 */
export function ownTmpOrExec(home: string = defaultNodeHome(), env: NodeJS.ProcessEnv = process.env, exec: Exec = execve): void {
  if (env.TMPDIR) return;
  const dir = ownTmp(home);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    pruneOwnTmp(dir);
    const self = selfArgv();
    const vars = Object.fromEntries(Object.entries(env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])));
    exec(self[0]!, [...self, ...process.argv.slice(2)], { ...vars, TMPDIR: dir, TMP: dir, TEMP: dir });
  } catch (error) {
    console.warn(`${new Date().toISOString()} WARN no temp dir of the node's own, so /tmp: ${(error as Error).message}`);
  }
}

/** How long an entry of the node's own temp dir stays after its last change, unless a live process holds it. */
export const OWN_TMP_KEEP_MS = 6 * 3_600_000;

/**
 * Removes what earlier nodes and their children left in the node's own temp dir: each entry nothing has changed for
 * OWN_TMP_KEEP_MS and no live process holds (an open file or its cwd under it; Linux only, elsewhere age alone). Never
 * the whole dir: what the node started (session hosts, builds, Monitors) runs on through its restarts, and automatic
 * updates restart it often. How many it removed.
 */
export function pruneOwnTmp(dir: string, now = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const old = names.filter((name) => now - newestChange(join(dir, name)) > OWN_TMP_KEEP_MS);
  if (!old.length) return 0;
  const held = heldUnder(dir);
  let removed = 0;
  for (const name of old) {
    if (held.has(name)) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
}

/** The latest write to `path` or anything below it (mtime), in ms. */
function newestChange(path: string): number {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  let newest = stat.mtimeMs;
  if (stat.isDirectory()) {
    let children: string[] = [];
    try {
      children = readdirSync(path);
    } catch {}
    for (const child of children) newest = Math.max(newest, newestChange(join(path, child)));
  }
  return newest;
}

/** The entries of `dir` a live process has an open file or its cwd under (Linux's /proc; elsewhere none). */
function heldUnder(dir: string): Set<string> {
  const held = new Set<string>();
  if (process.platform !== "linux") return held;
  const prefix = `${dir}/`;
  const note = (target: string) => {
    if (target.startsWith(prefix)) held.add(target.slice(prefix.length).split("/")[0]!);
  };
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name));
  } catch {}
  for (const pid of pids) {
    try {
      note(readlinkSync(`/proc/${pid}/cwd`));
    } catch {}
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {}
    for (const fd of fds) {
      try {
        note(readlinkSync(`/proc/${pid}/fd/${fd}`));
      } catch {}
    }
  }
  return held;
}

export function machineFingerprint(): string | undefined {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = readFileSync(file, "utf8").trim();
      if (id) return createHash("sha256").update(`fleetd machine ${id}`).digest("hex");
    } catch {}
  }
  return undefined;
}

type Flags = Record<string, string | true>;
function parseFlags(argv: string[], known: Set<string>): Flags | string {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) return `unexpected argument '${arg}'`;
    const name = arg.slice(2);
    if (!known.has(name)) return `unknown option '${arg}'`;
    if (["enroll-only", "mac"].includes(name)) flags[name] = true;
    else {
      const value = argv[++i];
      if (value === undefined) return `option '${arg} <value>' argument missing`;
      flags[name] = value;
    }
  }
  return flags;
}

export async function nodeCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const fail = (message: string) => (process.stderr.write(`fleetd: ${message}\n`), 1);
  if (sub === "join") {
    const flags = parseFlags(rest, new Set(["hub", "token", "token-file", "machine", "home", "enroll-only", "claude-config-dir", "mac"]));
    if (typeof flags === "string") return fail(flags);
    let token = typeof flags.token === "string" ? flags.token : undefined;
    if (typeof flags["token-file"] === "string")
      token = (flags["token-file"] === "-" ? await new Response(Bun.stdin.stream()).text() : readFileSync(flags["token-file"], "utf8")).trim();
    if (typeof flags.hub !== "string" || !token || typeof flags.machine !== "string")
      return fail("node join needs --hub, --token (or --token-file) and --machine");
    return join_({
      hub: flags.hub,
      token,
      machine: flags.machine,
      home: typeof flags.home === "string" ? flags.home : undefined,
      enrollOnly: flags["enroll-only"] === true,
      claudeConfigDir: typeof flags["claude-config-dir"] === "string" ? flags["claude-config-dir"] : undefined,
      mac: flags.mac === true,
    });
  }
  if (sub === "run") {
    const flags = parseFlags(rest, new Set(["home"]));
    if (typeof flags === "string") return fail(flags);
    return run({ home: typeof flags.home === "string" ? flags.home : undefined });
  }
  return fail(`unknown command 'node ${sub ?? ""}'.\nusage:\n${NODE_USAGE}`);
}

/** `mac`: `--mac`, the agents' Mac (agents_mac), its own screen on. */
export type JoinArgs = { hub: string; token: string; machine: string; home?: string; enrollOnly?: boolean; claudeConfigDir?: string; mac?: boolean };

/** Creates the node key and config, enrolls with the one-time token, then keeps the link up. */
export async function join_(args: JoinArgs): Promise<number> {
  if (!isMachineId(args.machine)) {
    process.stderr.write(`fleetd: machine id '${args.machine}' must match [a-z0-9-]{1,32}\n`);
    return 1;
  }
  const refused = args.mac ? mayJoin() : undefined;
  if (refused) {
    process.stderr.write(`fleetd: ${refused}\n`);
    return 1;
  }
  const home = args.home ?? defaultNodeHome();
  const config: NodeConfig = {
    hub: args.hub,
    machineId: args.machine,
    name: args.machine,
    ...(args.claudeConfigDir ? { claudeConfigDir: args.claudeConfigDir } : {}),
    ...(args.mac ? { mac: { enabled: true }, agentsMac: true } : {}),
    enrolled: false,
  };
  try {
    writeConfig(home, config);
  } catch {
    process.stderr.write(`fleetd: cannot write the node config in ${home}\n`);
    return 1;
  }
  return runNodeProcess(home, config, args.token, !!args.enrollOnly);
}

/** Keeps the link up for a node that has joined. */
export async function run(args: { home?: string }): Promise<number> {
  const home = args.home ?? defaultNodeHome();
  // Run by hand, it says what's wrong at once; as a service it waits.
  const config = await enrolled(home, !process.stderr.isTTY);
  if (typeof config === "number") return config;
  refreshOwnUnit();
  return runNodeProcess(home, config, undefined, false);
}

/** The node's enrolled config, or the exit code without one. A service that finds none (a boot that reads the home
 * before it is all there, a join still writing it) tries again after enrolledRetry's wait rather than exiting: systemd
 * gives up on a unit that exits five times in five minutes, and the node then stayed down until someone started it.
 * SIGINT or SIGTERM ends the wait. */
export async function enrolled(home: string, retry: boolean, signal?: AbortSignal): Promise<NodeConfig | number> {
  const stop = new AbortController();
  const end = () => stop.abort();
  signal?.addEventListener("abort", end);
  process.once("SIGINT", end);
  process.once("SIGTERM", end);
  try {
    for (let attempt = 0; ; attempt++) {
      let error: string;
      try {
        const config = readConfig(home);
        if (config?.enrolled) return config;
        error = `this node has not joined a hub (no enrolled config in ${home}): run fleetd node join first`;
      } catch {
        error = `node config in ${home} is unreadable`;
      }
      if (!retry) {
        process.stderr.write(`fleetd: ${error}\n`);
        return 1;
      }
      const wait = enrolledRetry(attempt);
      process.stderr.write(`fleetd: ${error}; trying again in ${wait / 1000} s\n`);
      const slept = await new Promise<boolean>((resolve) => {
        if (stop.signal.aborted) return resolve(false);
        const t = setTimeout(() => resolve(true), wait);
        stop.signal.addEventListener("abort", () => (clearTimeout(t), resolve(false)), { once: true });
      });
      if (!slept) return 0;
    }
  } finally {
    signal?.removeEventListener("abort", end);
    process.off("SIGINT", end);
    process.off("SIGTERM", end);
  }
}

/** The wait in ms before attempt `attempt + 1` of reading the config: 5 s, doubling up to 5 minutes. */
export const enrolledRetry = (attempt: number) => Math.min(5_000 * 2 ** Math.min(attempt, 6), 300_000);

/** A running node, for tests and the CLI: its parts, and `stop()`, which lets go of its sessions' hosts. */
export type RunningNode = { node: Node; sessions: SessionService; stop: () => Promise<void>; done: Promise<number> };

/** Starts the node: its sessions, its lead socket and its link. */
export async function startNode(home: string, config: NodeConfig, enrollToken?: string, exitWhenEnrolled = false): Promise<RunningNode> {
  // The hold the node before this one kept for its update ends with it: what it held goes on now.
  clearHold(home);
  startupCleanups(home);
  const identity = loadOrCreateIdentity(home);
  const boxKey = loadOrCreateBoxKey(home);
  console.log(`${new Date().toISOString()} INFO fleetd node starting {"machineId":"${config.machineId}","hub":"${config.hub}"}`);
  // Probed now rather than by the first spawn.
  void currentScope();
  // Before any session starts: they're hosted by, and start their fleetd tools from, the node's pinned copy.
  const sessions = await SessionService.start(configFor(home, fleetdDir(), pinSelf(home), boxKey));
  // Claude Code changes only when fleetd brings it to a version: its own background update goes off, for a person's
  // claude on this machine too.
  const settings = join(configDir(runnerEnv(sessions.config)), "settings.json");
  try {
    if (turnAutoupdaterOff(settings)) console.log(`${new Date().toISOString()} INFO turned Claude Code's own update off {"settings":"${settings}"}`);
  } catch (error) {
    console.warn(`${new Date().toISOString()} WARN couldn't turn Claude Code's own update off: ${(error as Error).message}`);
  }
  const relay = new LeadRelay();
  relay.hold = () => sessions.hold();
  const node = new Node(home, config, relay);
  sessions.onItemEnded = (session, item) => node.area("items").ended(session, item);
  sessions.launch = node.area("launch");
  node.area("sessions", () => ({
    maskFor: (thread: string) => sessions.maskFor(thread),
    sessionCwd: (thread: string) => sessions.sessionCwd(thread),
    secretsFor: (thread: string) => sessions.secretsFor(thread),
    hasProject: (projectId: string) => sessions.store.project(projectId) !== undefined,
  }));
  registerAreas(node);
  // What the sessions tell the screens and ask of them (Rust's browser SessionHooks).
  sessions.screens = screenHooks(node, (thread) => screens(node).live(thread) || sessionRoute(node).remotes.has(thread));
  // Playwright's Chrome and agent-browser, installed in the background where they are missing (Rust Broker::start).
  if (config.browser?.enabled !== false && !isAgentsMac(config)) broker(node).prepare();
  // The agents' Mac is a tool, never a runner: no lead call leaves it, and its hello lists only a tool's calls.
  const mac = isAgentsMac(config) ? agentsMac(node) : undefined;
  relay.toolOnly = isAgentsMac(config);
  const link = node.area("link");
  const local = node.area("local");
  const stopSocket = await serveLeadSocket(leadSocketPath(home), {
    relay,
    identify: (pid) => sessions.peerSession(pid),
    maskFor: (session) => sessions.maskFor(session),
    ...(local.any ? { browser: (session: string, frame: Record<string, unknown>) => local.answer(session, frame) } : {}),
    ...(local.has("mac") ? { mac: (session: string, frame: Record<string, unknown>) => local.answer(session, frame) } : {}),
  });
  const shutdown = new AbortController();
  const wakes = new Wakes();
  runPower({ running: () => sessions.running(), wakes, onWake: () => sessions.woke(), signal: shutdown.signal });
  const roots = config.cmdRoots ?? [homeDir()];
  const secretsCtx: SecretsContext = { machineId: config.machineId, roots, home, boxKey };
  const gated = new GatedRuns(home, config.machineId);
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));
  let enrolled: (() => void) | undefined;
  const screensRestart = new ScreensRestart(home, {
    live: () => broker(node).count(),
    hold: () => {
      holdForScreens(home);
      return sessions.midStep();
    },
    // A screen setting changed: the node stops as for SIGTERM, and its service manager starts it again.
    restart: () => resolveDone(0),
  });
  if (enrollToken)
    enrolled = () => {
      try {
        writeConfig(home, { ...config, enrolled: true });
      } catch (error) {
        console.warn(`cannot mark the node enrolled in its config: ${String(error)}`);
      }
      console.log(`${new Date().toISOString()} INFO enrolled with the hub; later starts use \`fleetd node run\``);
      if (exitWhenEnrolled) resolveDone(0);
    };

  /** A frame's work that failed past its own handling: logged, and the node carries on. */
  const logFailed = (what: string) => (error: unknown) => console.warn(`${new Date().toISOString()} WARN ${what} failed: ${String((error as Error)?.message ?? error)}`);

  const handle = (frame: HubFrame, ctx: LinkContext) => {
    const refused = relay.toolOnly ? refusedOnMac(frame) : undefined;
    if (refused) return ctx.send(refused);
    const own = link.handler(frame.t);
    if (own) return own(frame, ctx);
    switch (frame.t) {
      case "lead_result":
        return relay.resolve(frame as unknown as LeadResultFrame);
      case "cmd_check":
        void runCmdCheck(frame as unknown as CmdCheck, roots, home, ctx.signal).then((r) => ctx.send({ t: "cmd_result", ...r }), logFailed("cmd_check"));
        return;
      case "secret_deliver": {
        const deliver = frame as unknown as SecretDeliver;
        // A Navi's secure input: opened here and typed into its browser session's field by the broker.
        if (deliver.sink.startsWith("fill:")) {
          // A delivery that fails is answered as one, never left as an unhandled rejection.
          void broker(node)
            .deliver(deliver, boxKey, config.machineId)
            .catch((error: unknown) => ({ id: deliver.id, error: [...`not filled: ${(error as Error).message}`].slice(0, 500).join("") }))
            .then((r) => link.send({ t: "secret_result", ...r }));
          return;
        }
        return ctx.send({ t: "secret_result", ...deliverSecret(deliver, secretsCtx) });
      }
      case "gated_run":
        // Not the link's: an approved command runs to its end when the link drops, and the hub asks for its result.
        void gated.run(frame as unknown as GatedRun, ctx.hubId, secretsCtx).then((r) => link.send({ t: "gated_result", ...r }), logFailed("gated_run"));
        return;
      case "gated_resume":
        void gated.resume(frame as unknown as GatedResume, ctx.hubId).then((r) => ctx.send({ t: "gated_result", ...r }), logFailed("gated_resume"));
        return;
      case "node_action":
        if (frame.action === "update" || frame.action === "fetch") return void nodeUpdate(frame as unknown as NodeAction, ctx).catch(logFailed("node_action"));
        if (frame.action === "screens") return void screensAction(frame as unknown as NodeAction, ctx).catch(logFailed("node_action"));
        void runNodeAction(frame as unknown as NodeAction, {
          hold: () => sessions.hold(),
          unhostedMidStep: () => sessions.unhostedMidStep(),
          scoped: async () => (await currentScope()) !== undefined,
          claude: {
            installer: new RealClaude(sessions.config.claudeBin, runnerEnv(sessions.config)),
            binary: sessions.config.claudeBin,
            env: () => runnerEnv(sessions.config),
            logins: LOGINS,
            reprobe: () => sessions.reprobe(),
          },
        }).then((r) => ctx.send({ t: "node_action_result", ...r }), logFailed("node_action"));
        return;
      case "session_call":
        // Not the link's: a call that started finishes even if the link drops, and only its reply is lost.
        void sessions.handle(frame as never).then((reply) => link.send({ t: "session_reply", ...reply }), logFailed("session_call"));
        return;
      case "spans_ack":
        return sessions.spansAcked(Number(frame.upto), frame.rewind === true);
      default:
        // Screens' frames (browser_*, session_host, relay_dial, session_step, session_end, mac_call) go to the areas
        // that take them; without one they are dropped, as a node without the capability never gets them.
        return;
    }
  };

  /** `update` and `fetch`: answered before the restart, which waits for the answer to be on the link. */
  const nodeUpdate = async (frame: NodeAction, ctx: LinkContext) => {
    const failed = (f: Error & { stage?: string }) =>
      ({ t: "node_action_result", id: frame.id, ok: false, message: f.message.slice(0, 500), stage: f.stage ?? "install" }) as const;
    if (!frame.update) return ctx.send(failed(Object.assign(new Error(`the hub named no build to ${frame.action === "fetch" ? "fetch" : "update to"}`), { stage: "download" })));
    if (frame.action === "fetch") {
      ctx.send({ t: "node_action_result", id: frame.id, ok: true, message: "fetching" });
      return void runFetch(frame.update, home).catch(logFailed("fetch"));
    }
    let answer: Awaited<ReturnType<typeof runUpdate>>;
    try {
      answer = await runUpdate(frame.update, home);
    } catch (error) {
      // No restart follows: what the hold stopped goes on now.
      clearHold(home);
      return ctx.send(failed(error as Error));
    }
    ctx.send({ t: "node_action_result", id: frame.id, ok: true, message: answer.message });
    if (!answer.watch) return;
    // The answer is on the link: the watcher restarts this node now.
    await Promise.race([ctx.flush(), Bun.sleep(ANSWER_WAIT_MS)]);
    markAnswered(answer.watch.answered);
    // Still running once the watcher decided: the restart was refused, and the hub hears so now.
    const refused = await notRestarted(answer.watch.verdict, (HEALTH_WAIT_SECS + 10) * 1000);
    if (refused) ctx.send(failed(refused));
  };

  /** `screens`: written into node.json, and the node restarts to apply it once no screen is live here. Answered at
   * once; the restart waits for the answer to be on the link. */
  const screensAction = async (frame: NodeAction, ctx: LinkContext) => {
    const answered = screensRestart.ask();
    try {
      if (!frame.screens) throw new Error("the hub named no screen settings");
      applyScreens(home, frame.screens as never);
      ctx.send({ t: "node_action_result", id: frame.id, ok: true, message: screensRestart.schedule() });
    } catch (error) {
      ctx.send({ t: "node_action_result", id: frame.id, ok: false, message: (error as Error).message.slice(0, 500) });
    }
    await Promise.race([ctx.flush(), Bun.sleep(ANSWER_WAIT_MS)]);
    answered();
  };

  const hb = node.area("hb");
  // What the last hello listed: an area's capabilities that changed since go to the hub in a new hello.
  let hello: string[] = [];
  node.area("caps").onChanged(() => {
    const now = helloCapabilities(CAPABILITIES, node.area("caps").list(), mac);
    const current = link.current;
    if (current && JSON.stringify(now) !== JSON.stringify(hello)) current.relink("this machine's capabilities changed");
  });
  const fatal = runNode({
    settings: { hub: config.hub, machineId: config.machineId, name: config.name, nodeVersion: VERSION },
    identity,
    boxPubKey: boxKey.publicKey(),
    machineFingerprint: machineFingerprint(),
    ...(enrollToken ? { enrollToken } : {}),
    ...(enrolled ? { onEnrolled: enrolled } : {}),
    capabilities: () => (hello = helloCapabilities(CAPABILITIES, node.area("caps").list(), mac)),
    heartbeat: async () => {
      const parts = { load: readLoad(sessions.loginLimits() as never, home), steps: [] as unknown[], busy: { threads: sessions.running(), screens: 0, uploads: uploads(home), hosted: 0 } };
      await hb.fill(parts);
      return { ...(parts.load ? { load: parts.load } : {}), ...(parts.steps.length ? { steps: parts.steps } : {}), busy: parts.busy };
    },
    attach: (ctx) => {
      link.linked(ctx);
      // For the watcher of an update's restart: this build came up and its hub took it.
      markUp(home, VERSION);
      for (const slept of wakes.take()) ctx.send({ t: "slept", ...slept });
      const detachLead = relay.attach(ctx.send, ctx.hubCaps);
      const detachSessions = sessions.attach(ctx.send);
      return () => {
        link.linked(undefined);
        detachLead();
        detachSessions();
      };
    },
    handle,
    woke: (signal) => wakes.next(signal),
    signal: shutdown.signal,
  });
  void fatal.then(
    (refused) => {
      if (refused) {
        process.stderr.write(`fleetd: ${refused.message}\n`);
        resolveDone(1);
      } else resolveDone(0);
    },
    (error) => {
      process.stderr.write(`fleetd: the link to the hub failed: ${String((error as Error)?.message ?? error)}\n`);
      resolveDone(1);
    },
  );
  const stop = async () => {
    shutdown.abort();
    stopSocket();
    await stopAreas(node);
    await sessions.shutdown();
  };
  return { node, sessions, stop, done };
}

/** From here on one task's failure never takes the node down, as a tokio task's panic doesn't end the Rust node: it is
 * logged and the node carries on. With every session's host under the node's unit, a node that exited would take each
 * agent on the machine with it. */
export function guard(): void {
  process.on("unhandledRejection", (reason) => console.error("fleetd node: a task failed:", reason));
  process.on("uncaughtException", (error) => console.error("fleetd node: a task failed:", error));
}

async function runNodeProcess(home: string, config: NodeConfig, enrollToken: string | undefined, exitWhenEnrolled: boolean): Promise<number> {
  // The last process the kernel kills when memory runs out.
  protect("node");
  guard();
  // Listening before the node starts anything: a SIGTERM while it starts up stops it once it is up, rather than
  // killing it outright.
  const signalled = new Promise<number>((resolve) => {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => resolve(0));
  });
  let running: RunningNode;
  try {
    running = await startNode(home, config, enrollToken, exitWhenEnrolled);
  } catch (error) {
    process.stderr.write(`fleetd: ${(error as Error).message}\n`);
    return 1;
  }
  const code = await Promise.race([running.done, signalled]);
  await running.stop();
  return code;
}
