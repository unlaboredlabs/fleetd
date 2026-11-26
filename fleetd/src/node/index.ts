// `fleetd node …`: the node's link to its hub, its sessions, the lead socket, cmd
// checks, sealed secrets, approved commands and node actions. A session's claude runs under a host of its own, this
// binary's `fleetd session-host` (./runner/host.ts), which outlives the node.
import { refreshOwnUnit } from "../cli/setup/units.ts";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CAP } from "./wire.ts";
import { runNodeAction } from "./actions/index.ts";
import { ended as macEnded, host as macHost, isOwnMac } from "./mac_tool/index.ts";
import { Node } from "./api.ts";
import { registerAreas, stopAreas } from "./areas.ts";
import { agentsMac, isAgentsMac, mayJoin } from "./agents_mac/index.ts";
import { helloCapabilities, refusedOnMac } from "./link/tool_only.ts";
import { current as currentScope } from "./runner/scope.ts";
import { REFUSED, runCmdCheck } from "./cmd/index.ts";
import { notRunResult } from "./cmd/refusal.ts";
import { defaultNodeHome, isMachineId, readConfig, writeConfig, type NodeConfig } from "./config.ts";
import { enrolAt, movedConfig, readRejoin } from "./rejoin.ts";
import { GatedRuns } from "./gated/index.ts";
import { loadOrCreateBoxKey, loadOrCreateIdentity, type NodeBoxKey } from "./identity.ts";
import { LeadRelay, leadSocketPath, serveLeadSocket, type LeadResultFrame, type LeadSocketHooks } from "./lead/index.ts";
import { boxOf, inBox, runnerProvider, useRunner } from "./place/index.ts";
import { Images, useImages } from "./place/image.ts";
import { Boxes, boxes, setBoxes } from "./sandbox/remote/boxes.ts";
import { NodeTailnet, nodeTailnet, setNodeTailnet } from "./sandbox/tailnet.ts";
import { start as startMcpTailnet } from "./actions/mcp_tailnet.ts";
import { BOX_CLAUDE, boxWork, hasBox, HOSTED_NO_MAC, hostedBackend } from "./place/hosted.ts";
import { runNode, type LinkContext } from "./link/index.ts";
import { read as readLoad } from "./load/index.ts";
import { runPower, Wakes } from "./power/index.ts";
import { pinSelf } from "./self_exe.ts";
import { deliverSecret, type SecretsContext } from "./secrets/index.ts";
import { configFor, runnerEnv, SessionService } from "./sessions/index.ts";
import { RealClaude, turnAutoupdaterOff } from "./runner/install.ts";
import { AGY_LOGINS, LOGINS } from "./runner/login.ts";
import * as antigravity from "./runner/antigravity.ts";
import { notRestarted, run as runUpdate, runFetch } from "./update/index.ts";
import { emptyHeld } from "./hold.ts";
import { broker, screenHooks } from "./browser/index.ts";
import { router as screens } from "./device/router.ts";
import { sandboxesOf } from "./sandbox/hosted.ts";
import { keepTokens, useGithubTokens } from "./repos/github.ts";
import { CAP_RUNNER, RUNNER_NAME } from "../shared/sandbox.ts";
import { router as sessionRoute } from "./session_route/index.ts";
import { ANSWER_WAIT_MS, HEALTH_WAIT_SECS, markAnswered, markUp } from "../update/finish.ts";
import { rmSync } from "node:fs";
import { configDir } from "./runner/claude.ts";
import { homeDir, selfArgv } from "./util.ts";
import type { CmdCheck, GatedResume, GatedRun, HubFrame, NodeAction, SecretDeliver } from "./wire.ts";
import { fleetdDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";
import { protect } from "./oom.ts";
import { moveKeptProfiles } from "./own_homes.ts";
import { uploads } from "./uploads.ts";
import { settingsPath } from "../shared/settings_path.ts";

export const NODE_USAGE = `  node join --workspace <url> (--token <token> | --token-file <file|->) --machine <id>
            [--home <dir>] [--enroll-only] [--claude-config-dir <dir>]
             enroll this machine with the workspace, then keep its link up (node home default ~/.fleetd/node);
             --token-file - reads the token from stdin; --enroll-only exits once the workspace has accepted this
             node; sessions use your own claude setup (~/.claude) unless --claude-config-dir names a
             dedicated one
  node run [--home <dir>]
             keep the link up for a machine that has joined
`;

/** What the hub's runner answers a command the hub asks it to run on its machine. */
const runnerNoCommands = (): string =>
  `approved commands and checks run on a computer of the team's, and none runs this bot: its agents run in hosted sandboxes. Connect a computer (${settingsPath()} › Machines) to run them`;

/** What the hub's runner leaves out of the core's capabilities: installing, signing in to or updating a Claude Code or
 * fleetd of its machine's (its boxes have their own, and it updates with the hub that starts it). */
const NOT_ON_RUNNER: readonly string[] = [CAP.CLAUDE_INSTALL, CAP.CLAUDE_LOGIN, CAP.ANTIGRAVITY_LOGIN, CAP.SELF_UPDATE, CAP.UPDATE_FETCH, CAP.REJOIN];

/** Every capability the Bun node lists in its hello: what its modules take. */
export const CAPABILITIES = [
  CAP.REPOS, CAP.DETACHED, CAP.PROJECT_SETTINGS, CAP.WORKTREE_SETUP, CAP.COMPUTER_IMAGE, CAP.CLAUDE_INSTALL, CAP.CLAUDE_LOGIN, CAP.ANTIGRAVITY_LOGIN, CAP.SELF_UPDATE, CAP.UPDATE_FETCH, CAP.PROJECT_ENV_COPY, CAP.ORDER_ENV, CAP.ALLOWED_ONLY, CAP.UPDATE_HOLD, CAP.UPDATE_BUILD,
  CAP.SESSION_SEAL, CAP.PROFILE_NAMES, CAP.SYSTEM_PROMPT, CAP.ASSISTANT, CAP.FOLDER_MAKE, CAP.ISOLATED,
  CAP.PROJECT_ERASE, CAP.ONE_LEAD_MODE, CAP.LINK_DEFLATE, CAP.GATED_RESUME, CAP.HAS_FILE,
  CAP.LANDED_LOG, CAP.MCP_SERVERS, CAP.SKILLS, CAP.SIGNINS_FORGET, CAP.CLAUDE_ACCOUNTS, CAP.CLAUDE_RESEAL, CAP.CLAUDE_KEY_TRIAL, CAP.SECRET_RESEAL, CAP.GEMINI_KEY, CAP.ONEPASSWORD,
  CAP.ONEPASSWORD_CARDS, CAP.CLAUDE_MODELS, CAP.BUILD_BUN, CAP.VAULT, CAP.LAUNCH_AHEAD, CAP.REJOIN, CAP.MCP_TAILNET,
];

/** A hash of the OS's id for this computer (fingerprint.rs): the hub never enrolls a second computer under one id. */
/** Ends the hold (node/hold.rs `clear`): every tool call waiting on it starts. */
export function clearHold(home: string): void {
  for (const f of ["hold", "hold.screens", "hold.update"]) rmSync(join(home, "update", f), { force: true });
  emptyHeld(home);
}

/** What a stopped node left that nothing uses now: the remote-screen forwarders and folders of its sessions (their
 * screens went with it) and the Telegram state of an older node (D339); and kept browser profiles still where they
 * were before D310 move to where every project's are (own_homes.ts). Stale pins are self_exe.ts's. */
export function startupCleanups(home: string): void {
  let sessions: string[] = [];
  try {
    sessions = readdirSync(join(home, "sessions"));
  } catch {}
  for (const id of sessions) for (const dir of ["device-remote", "device-work"]) rmSync(join(home, "sessions", id, dir), { recursive: true, force: true });
  rmSync(join(home, "telegram"), { recursive: true, force: true });
  moveKeptProfiles(home);
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
      return fail("node join needs --workspace, --token (or --token-file) and --machine");
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
export type JoinArgs = { hub: string; token: string; machine: string; home?: string; enrollOnly?: boolean; claudeConfigDir?: string; mac?: boolean; runner?: boolean };

/** The config a node joins with, in `home`. The hub's runner keeps a Claude config dir of its own: no machine's
 * `~/.claude` is any of its sessions'. */
export function joinConfig(home: string, args: JoinArgs): NodeConfig {
  return {
    hub: args.hub,
    machineId: args.machine,
    name: args.machine,
    ...(args.claudeConfigDir ? { claudeConfigDir: args.claudeConfigDir } : {}),
    ...(args.mac ? { agentsMac: true } : {}),
    ...(args.runner ? { name: RUNNER_NAME, runner: true, claudeConfigDir: join(home, "claude") } : {}),
    enrolled: false,
  };
}

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
  const config = joinConfig(home, args);
  try {
    writeConfig(home, config);
  } catch {
    process.stderr.write(`fleetd: cannot write the node config in ${home}\n`);
    return 1;
  }
  return runNodeProcess(home, config, args.token, !!args.enrollOnly);
}

/** The hub removed this machine: node.json says so and isn't enrolled any more, so nothing dials the hub as that
 * machine again until it joins with a new code. False when it can't be written (the node exits as refused). */
export function markRemoved(home: string, deleted = false): boolean {
  try {
    const config = readConfig(home);
    if (config === undefined) return false;
    writeConfig(home, { ...config, enrolled: false, removed: true, ...(deleted ? { deleted: true } : {}) });
    return true;
  } catch (error) {
    console.warn(`cannot mark the node removed in its config: ${String(error)}`);
    return false;
  }
}

/** What a node whose workspace was deleted says, at the refusal and at each start after it. */
export const deletedLine = (hub: string) =>
  `${hub} was deleted, so fleetd stopped on this machine. Remove fleetd here with fleetd uninstall, or join another workspace with a new code (fleetd init --join).`;

/** Keeps the link up for a node that has joined. */
export async function run(args: { home?: string }): Promise<number> {
  const home = args.home ?? defaultNodeHome();
  // Run by hand, it says what's wrong at once; as a service it waits.
  const config = await enrolled(home, !process.stderr.isTTY);
  if (typeof config === "number") return config;
  // The hub's runner runs under the hub's unit, which is the hub's to keep.
  if (!config.runner) refreshOwnUnit();
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
    let said = false;
    for (let attempt = 0; ; attempt++) {
      let error: string;
      let removed = false;
      try {
        const config = readConfig(home);
        if (config?.enrolled) return config;
        // Removed, or its workspace deleted: said once, never tried again (a new join brings it back).
        removed = config?.removed === true || config?.deleted === true;
        error = config?.deleted
          ? deletedLine(config.hub)
          : config?.removed
            ? `${config.machineId} was removed from ${config.hub}, so this node stays stopped. To work for it again, join with a new code (fleetd init --join, or Set up this Mac in the app); to take fleetd off this machine, run fleetd uninstall`
          : `this node has not joined a workspace (no enrolled config in ${home}): run fleetd node join first`;
      } catch {
        error = `node config in ${home} is unreadable`;
      }
      if (!retry) {
        process.stderr.write(`fleetd: ${error}\n`);
        return 1;
      }
      const wait = enrolledRetry(attempt);
      // Removed, it waits for a new join without trying the workspace again: said once, not every few minutes.
      if (removed && !said) process.stderr.write(`fleetd: ${error}.\n`);
      else if (!removed) process.stderr.write(`fleetd: ${error}; trying again in ${wait / 1000} s\n`);
      said = removed;
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
export async function startNode(
  home: string,
  config: NodeConfig,
  enrollToken?: string,
  exitWhenEnrolled = false,
  /** Tests: the hosted boxes' maker, with stand-in providers. */
  o: { boxes?: (home: string, machineId: string, key: NodeBoxKey) => Boxes } = {},
): Promise<RunningNode> {
  // The hold the node before this one kept for its update ends with it: what it held goes on now.
  clearHold(home);
  startupCleanups(home);
  const identity = loadOrCreateIdentity(home);
  const boxKey = loadOrCreateBoxKey(home);
  console.log(`${new Date().toISOString()} INFO fleetd node starting {"machineId":"${config.machineId}","hub":"${config.hub}"}`);
  // Probed now rather than by the first spawn.
  void currentScope();
  // Before any session starts: they're hosted by, and start their fleetd tools from, the node's pinned copy.
  const fleetd = pinSelf(home);
  // The hub's runner reads no claude.env of the machine it runs on: its agents run on the team's Claude account.
  const sessionConfig = configFor(home, config.runner ? home : fleetdDir(), fleetd, boxKey);
  // Its sessions' claude is the one their boxes' template installs.
  if (config.runner) sessionConfig.claudeBin = BOX_CLAUDE.path;
  // Hosted boxes too: the sessions re-adopt theirs as they start (node/place/hosted.ts).
  if (process.platform === "linux" && !isAgentsMac(config)) {
    setBoxes(o.boxes?.(home, config.machineId, boxKey) ?? new Boxes(home, config.machineId, boxKey));
  }
  // The team's tailnet, through the hub's Tailscale route, for those boxes and for a tailnet MCP server when this
  // machine isn't on the tailnet itself (actions/mcp_tailnet.ts): off until the hub says it is on.
  setNodeTailnet(new NodeTailnet(config.hub, config.machineId, identity));
  await startMcpTailnet();
  const sessions = await SessionService.start(sessionConfig);
  // A hosted box whose work didn't come back: the server it links to (fleetd's cloud) tells the task's lead.
  boxWork.said = (e) => sessions.boxWork(e);
  // Its bots' computer images (place/image.ts): on the hub's runner, in the hosted provider's snapshots.
  useImages(
    new Images({
      home,
      backend: () => (config.runner ? hostedBackend(home, runnerProvider()) : undefined),
      root: (project) => sessions.projectRootOf(project),
      vars: (project) => sessions.imageVars(project),
      changed: (project, image) => sessions.imageChanged(project, image),
    }),
  );
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
  // The hub's own runner: every session in a box of the first connected provider the hub didn't place it elsewhere in.
  if (config.runner) {
    useRunner(() => sandboxesOf(node)?.forRunner());
    useGithubTokens(home);
  }
  // What the sessions tell the screens and ask of them (Rust's browser SessionHooks).
  sessions.screens = screenHooks(node, (thread) => screens(node).live(thread) || sessionRoute(node).remotes.has(thread));
  // Playwright's Chrome and agent-browser, installed in the background where they are missing (Rust Broker::start).
  // The hub's runner wants agent-browser for its agents and ffmpeg for their recordings too; it launches no Chrome.
  // No switch turns browsers off (an older node.json's `browser.enabled` is ignored).
  if (!isAgentsMac(config)) broker(node).prepare();
  // A hosted agent's browser runs in its box (place/box_screens.ts), on the box's network and files.
  broker(node).boxed = (thread) => {
    const b = boxOf(thread);
    if (b) return { box: b.box };
    return inBox(thread) ? "starting" : undefined;
  };
  // The agents' Mac is a tool, never a runner: no lead call leaves it, and its hello lists only a tool's calls.
  const mac = isAgentsMac(config) ? agentsMac(node) : undefined;
  relay.toolOnly = isAgentsMac(config);
  const link = node.area("link");
  const local = node.area("local");
  const leadHooks: LeadSocketHooks = {
    relay,
    identify: (pid: number) => sessions.peerSession(pid),
    maskFor: (session: string) => sessions.maskFor(session),
    ...(local.any ? { browser: (session: string, frame: Record<string, unknown>) => local.answer(session, frame) } : {}),
    ...(local.has("mac")
      ? {
          // The agents' Mac builds from the agent's files on this machine: a hosted agent's are in its box.
          mac: async (session: string, frame: Record<string, unknown>): Promise<Record<string, unknown>> =>
            hasBox(session)
              ? { error: { code: "invalid", message: HOSTED_NO_MAC, fix: "do without the agents' Mac and say so in your result" } }
              : local.answer(session, frame),
        }
      : {}),
  };
  const stopSocket = await serveLeadSocket(leadSocketPath(home), leadHooks);
  // A hosted box's node.sock calls are answered as this machine's own are, as the box's session.
  boxes()?.wire({ lead: leadHooks });
  // Where each live session runs: the hub's slot board counts hosted boxes, held or idle, by it.
  node.area("hb").contribute((hb) => {
    const places = sessions.places();
    if (hb.load && Object.keys(places).length > 0) hb.load.places = places;
  });
  const shutdown = new AbortController();
  const wakes = new Wakes();
  runPower({ running: () => sessions.running(), wakes, onWake: () => sessions.woke(), signal: shutdown.signal });
  const roots = config.cmdRoots ?? [homeDir()];
  const secretsCtx: SecretsContext = { machineId: config.machineId, roots, home, boxKey };
  const gated = new GatedRuns(home, config.machineId);
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));
  let enrolled: ((machineId: string) => void) | undefined;
  if (enrollToken)
    enrolled = (machineId) => {
      // A code minted for no machine enrolls the node under the id the hub settled on: its config takes it, and the
      // node ends so that it starts again as that machine (its service does that by itself).
      const renamed = machineId !== config.machineId && isMachineId(machineId);
      const name = renamed && config.name === config.machineId ? machineId : config.name;
      try {
        writeConfig(home, { ...config, ...(renamed ? { machineId, name } : {}), enrolled: true });
      } catch (error) {
        console.warn(`cannot mark the node enrolled in its config: ${String(error)}`);
      }
      const as = renamed ? ` as ${machineId}` : "";
      console.log(`${new Date().toISOString()} INFO enrolled with the workspace${as}; later starts use \`fleetd node run\``);
      if (exitWhenEnrolled || renamed) resolveDone(0);
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
        // The hub's runner runs nothing on the machine it is on: commands go to a computer of the team's.
        if (config.runner) return ctx.send({ t: "cmd_result", ...notRunResult(String(frame.id ?? ""), `${REFUSED}${runnerNoCommands()}`) });
        void runCmdCheck(frame as unknown as CmdCheck, roots, home, ctx.signal).then((r) => ctx.send({ t: "cmd_result", ...r }), logFailed("cmd_check"));
        return;
      case "secret_deliver": {
        const deliver = frame as unknown as SecretDeliver;
        // A lead's secure input: opened here and typed into its browser session's field by the broker.
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
        if (config.runner) return ctx.send({ t: "gated_result", id: String(frame.id ?? ""), exitCode: null, outputTail: "", timedOut: false, error: runnerNoCommands() });
        // Not the link's: an approved command runs to its end when the link drops, and the hub asks for its result.
        void gated.run(frame as unknown as GatedRun, ctx.hubId, secretsCtx).then((r) => link.send({ t: "gated_result", ...r }), logFailed("gated_run"));
        return;
      case "gated_resume":
        void gated.resume(frame as unknown as GatedResume, ctx.hubId).then((r) => ctx.send({ t: "gated_result", ...r }), logFailed("gated_resume"));
        return;
      case "node_action":
        if (frame.action === "update" || frame.action === "fetch") return void nodeUpdate(frame as unknown as NodeAction, ctx).catch(logFailed("node_action"));
        if (frame.action === "rejoin" && !config.runner) return void nodeRejoin(frame as unknown as NodeAction, ctx).catch(logFailed("node_action"));
        // The hub's runner: the hub's GitHub tokens for its own clones and fetches.
        if (frame.action === "github_tokens" && config.runner) {
          const kept = keepTokens(home, (frame as unknown as NodeAction).tokens ?? {}, boxKey);
          return void ctx.send({ t: "node_action_result", id: String(frame.id ?? ""), ok: true, message: `${kept} GitHub tokens kept` });
        }
        // The team's Tailscale gateway, on or off, for this node's hosted boxes.
        if (frame.action === "tailnet" && nodeTailnet()) {
          nodeTailnet()!.set((frame as unknown as NodeAction).tailnet);
          // The hub's runner says again whether its Claude endpoint is reached.
          if (config.runner) void sessions.reprobe().catch(() => {});
          return void ctx.send({ t: "node_action_result", id: String(frame.id ?? ""), ok: true, message: `the tailnet is ${nodeTailnet()!.on ? "on" : "off"} here` });
        }
        // The agents' Mac, or a Mac that runs agents: the folders of tasks that ended go.
        if (frame.action === "mac_ended" && (isAgentsMac(config) || isOwnMac(node))) {
          return void macEnded(node, frame as unknown as NodeAction).then((r) => ctx.send({ t: "node_action_result", ...r }), logFailed("node_action"));
        }
        // A Mac that lends iOS simulators: how many it runs at once, at once.
        if (frame.action === "mac_sims" && (isAgentsMac(config) || isOwnMac(node))) {
          const sims = (frame as unknown as NodeAction).sims;
          macHost(node).setSims(typeof sims === "number" && Number.isInteger(sims) && sims > 0 ? sims : null);
          return void ctx.send({ t: "node_action_result", id: String(frame.id ?? ""), ok: true, message: `${sims ?? "the default number of"} simulators at once` });
        }
        // A node where agents never run in sandboxes (macOS, the agents' Mac) answers below that it doesn't know them.
        if (frame.action === "sandbox_check" || frame.action === "sandbox_limits") {
          const sandboxes = sandboxesOf(node);
          if (sandboxes && frame.action === "sandbox_limits") return void ctx.send({ t: "node_action_result", ...sandboxes.setLimits(frame as unknown as NodeAction) });
          if (sandboxes) return void sandboxes.check(frame as unknown as NodeAction).then((r) => ctx.send({ t: "node_action_result", ...r }), logFailed("node_action"));
        }
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
          antigravity: { binary: () => antigravity.ensure(), found: () => antigravity.found(), env: () => runnerEnv(sessions.config), logins: AGY_LOGINS },
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

  /** `rejoin` (rejoin.ts): enrolled at the new hub, node.json names it and the node ends, its service starting it there. */
  const nodeRejoin = async (frame: NodeAction, ctx: LinkContext) => {
    const answer = (ok: boolean, message: string) => ctx.send({ t: "node_action_result", id: frame.id, ok, message: message.slice(0, 500) });
    const ask = readRejoin(frame.rejoin, config.hub);
    if (typeof ask === "string") return answer(false, ask);
    const enrolled = await enrolAt(ask, { config, identity, boxPubKey: boxKey.publicKey(), machineFingerprint: machineFingerprint(), nodeVersion: VERSION });
    if (!enrolled.ok) return answer(false, enrolled.message);
    try {
      writeConfig(home, movedConfig(config, ask.hub));
    } catch (error) {
      return answer(false, `enrolled at the new workspace, but node.json couldn't be written: ${String((error as Error).message)}`);
    }
    console.log(`${new Date().toISOString()} INFO enrolled with ${ask.hub}; starting again there`);
    answer(true, `enrolled with ${ask.hub}`);
    await Promise.race([ctx.flush(), Bun.sleep(ANSWER_WAIT_MS)]);
    resolveDone(0);
  };

  /** `update` and `fetch`: answered before the restart, which waits for the answer to be on the link. */
  const nodeUpdate = async (frame: NodeAction, ctx: LinkContext) => {
    const failed = (f: Error & { stage?: string }) =>
      ({ t: "node_action_result", id: frame.id, ok: false, message: f.message.slice(0, 500), stage: f.stage ?? "install" }) as const;
    if (!frame.update) return ctx.send(failed(Object.assign(new Error(`the workspace named no build to ${frame.action === "fetch" ? "fetch" : "update to"}`), { stage: "download" })));
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

  const hb = node.area("hb");
  const own = config.runner ? [...CAPABILITIES.filter((c) => !NOT_ON_RUNNER.includes(c)), CAP_RUNNER] : CAPABILITIES;
  // What the last hello listed: an area's capabilities that changed since go to the hub in a new hello.
  let hello: string[] = [];
  node.area("caps").onChanged(() => {
    const now = helloCapabilities(own, node.area("caps").list(), mac);
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
    capabilities: () => (hello = helloCapabilities(own, node.area("caps").list(), mac)),
    heartbeat: async () => {
      const parts = { load: readLoad(sessions.loginLimits() as never, home), steps: [] as unknown[], busy: { threads: sessions.running(), screens: 0, uploads: uploads(home), hosted: 0 } };
      await hb.fill(parts);
      return { ...(parts.load ? { load: parts.load } : {}), ...(parts.steps.length ? { steps: parts.steps } : {}), busy: parts.busy };
    },
    attach: (ctx) => {
      link.linked(ctx);
      mac?.link("linked");
      // For the watcher of an update's restart: this build came up and its hub took it.
      markUp(home, VERSION);
      for (const slept of wakes.take()) ctx.send({ t: "slept", ...slept });
      const detachLead = relay.attach(ctx.send, ctx.hubCaps);
      const detachSessions = sessions.attach(ctx.send);
      return () => {
        link.linked(undefined);
        mac?.link("down");
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
        // Setup on the Mac shows the hub's words, not a wait for checks that never come.
        mac?.link("refused", refused.reason);
        // Removed: the node stops as that machine. Its service starts it again, to wait for a new join (`enrolled`).
        // The agents' Mac its hub holds no key for is the same: only a new code joins it again, and until then it
        // waits rather than dial and be refused every few seconds.
        if ((refused.removed || (mac !== undefined && refused.unknown)) && markRemoved(home)) return resolveDone(0);
        // Its workspace was deleted: nothing is there to dial again, so the node stops for good, and says what to do.
        if (refused.deleted && markRemoved(home, true)) {
          process.stderr.write(`fleetd: ${deletedLine(config.hub)}\n`);
          return resolveDone(0);
        }
        resolveDone(1);
      } else resolveDone(0);
    },
    (error) => {
      process.stderr.write(`fleetd: the link to the workspace failed: ${String((error as Error)?.message ?? error)}\n`);
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
