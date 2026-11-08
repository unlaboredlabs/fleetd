// `fleetd node …` (crates/fleetd/src/node/mod.rs): the node's link to its hub, its sessions, the lead socket, cmd
// checks, sealed secrets, approved commands and node actions. A session's claude runs under the Rust binary's
// `fleetd session-host` (FLEETD_NATIVE_BIN, else `fleetd` on PATH), which outlives the node.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CAP } from "./wire.ts";
import { runNodeAction } from "./actions/index.ts";
import { Node } from "./api.ts";
import { registerAreas, stopAreas } from "./areas.ts";
import { runCmdCheck } from "./cmd/index.ts";
import { defaultNodeHome, isMachineId, readConfig, writeConfig, type NodeConfig } from "./config.ts";
import { GatedRuns } from "./gated/index.ts";
import { loadOrCreateBoxKey, loadOrCreateIdentity } from "./identity.ts";
import { LeadRelay, leadSocketPath, serveLeadSocket, type LeadResultFrame } from "./lead/index.ts";
import { runNode, type LinkContext } from "./link/index.ts";
import { read as readLoad } from "./load/index.ts";
import { runPower, Wakes } from "./power/index.ts";
import { deliverSecret, type SecretsContext } from "./secrets/index.ts";
import { configFor, SessionService } from "./sessions/index.ts";
import { homeDir } from "./util.ts";
import type { CmdCheck, GatedResume, GatedRun, HubFrame, NodeAction, SecretDeliver } from "./wire.ts";
import { fleetdDir } from "../shared/home.ts";
import { VERSION } from "../shared/version.ts";

export const NODE_USAGE = `  node join --hub <url> (--token <token> | --token-file <file|->) --machine <id>
            [--home <dir>] [--enroll-only] [--claude-config-dir <dir>]
             enroll this machine with the hub, then keep its link up (node home default ~/.fleetd/node);
             --token-file - reads the token from stdin; --enroll-only exits once the hub has accepted this
             node; sessions use your own claude setup (~/.claude) unless --claude-config-dir names a
             dedicated one
  node run [--home <dir>]
             keep the link up for a machine that has joined
`;

/** Every capability the Bun node lists in its hello: what its modules take. Self-update, Claude Code's install and
 * login and screens aren't ported, so their capabilities aren't listed. */
export const CAPABILITIES = [
  CAP.REPOS, CAP.DETACHED, CAP.PROJECT_SETTINGS, CAP.WORKTREE_SETUP, CAP.PROJECT_ENV_COPY, CAP.ORDER_ENV, CAP.ALLOWED_ONLY, CAP.UPDATE_HOLD,
  CAP.SESSION_SEAL, CAP.PROFILE_NAMES, CAP.SYSTEM_PROMPT, CAP.ASSISTANT, CAP.FOLDER_MAKE, CAP.ISOLATED, CAP.NAVI_ERASE,
  CAP.PROJECT_ERASE, CAP.ONE_LEAD_MODE, CAP.LINK_DEFLATE, CAP.GATED_RESUME, CAP.HAS_FILE,
  CAP.LANDED_LOG, CAP.MCP_SERVERS, CAP.SKILLS, CAP.NAVI_SIGNINS, CAP.CLAUDE_ACCOUNTS, CAP.CLAUDE_RESEAL, CAP.ONEPASSWORD,
  CAP.ONEPASSWORD_CARDS, CAP.CLAUDE_MODELS,
];

/** A hash of the OS's id for this computer (fingerprint.rs): the hub never enrolls a second computer under one id. */
export function machineFingerprint(): string | undefined {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = readFileSync(file, "utf8").trim();
      if (id) return createHash("sha256").update(`fleetd machine ${id}`).digest("hex");
    } catch {}
  }
  return undefined;
}

/** The Rust fleetd binary that hosts sessions and runs agent-mcp: FLEETD_NATIVE_BIN, else `fleetd` on PATH. */
export function nativeBin(): string {
  if (process.env.FLEETD_NATIVE_BIN) return process.env.FLEETD_NATIVE_BIN;
  const own = (() => {
    try {
      return realpathSync(process.execPath);
    } catch {
      return process.execPath;
    }
  })();
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const bin = join(dir, "fleetd");
    try {
      if (dir && existsSync(bin) && realpathSync(bin) !== own) return bin;
    } catch {}
  }
  return "fleetd";
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
    });
  }
  if (sub === "run") {
    const flags = parseFlags(rest, new Set(["home"]));
    if (typeof flags === "string") return fail(flags);
    return run({ home: typeof flags.home === "string" ? flags.home : undefined });
  }
  return fail(`unknown command 'node ${sub ?? ""}'.\nusage:\n${NODE_USAGE}`);
}

export type JoinArgs = { hub: string; token: string; machine: string; home?: string; enrollOnly?: boolean; claudeConfigDir?: string };

/** Creates the node key and config, enrolls with the one-time token, then keeps the link up. */
export async function join_(args: JoinArgs): Promise<number> {
  if (!isMachineId(args.machine)) {
    process.stderr.write(`fleetd: machine id '${args.machine}' must match [a-z0-9-]{1,32}\n`);
    return 1;
  }
  const home = args.home ?? defaultNodeHome();
  const config: NodeConfig = {
    hub: args.hub,
    machineId: args.machine,
    name: args.machine,
    ...(args.claudeConfigDir ? { claudeConfigDir: args.claudeConfigDir } : {}),
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
  let config: NodeConfig | undefined;
  try {
    config = readConfig(home);
  } catch {
    process.stderr.write(`fleetd: node config in ${home} is unreadable\n`);
    return 1;
  }
  if (!config?.enrolled) {
    process.stderr.write(`fleetd: this node has not joined a hub (no enrolled config in ${home}): run fleetd node join first\n`);
    return 1;
  }
  return runNodeProcess(home, config, undefined, false);
}

/** A running node, for tests and the CLI: its parts, and `stop()`, which lets go of its sessions' hosts. */
export type RunningNode = { node: Node; sessions: SessionService; stop: () => Promise<void>; done: Promise<number> };

/** Starts the node: its sessions, its lead socket and its link. */
export async function startNode(home: string, config: NodeConfig, enrollToken?: string, exitWhenEnrolled = false): Promise<RunningNode> {
  const identity = loadOrCreateIdentity(home);
  const boxKey = loadOrCreateBoxKey(home);
  console.log(`${new Date().toISOString()} INFO fleetd node starting {"machineId":"${config.machineId}","hub":"${config.hub}"}`);
  const sessions = await SessionService.start(configFor(home, fleetdDir(), nativeBin(), boxKey));
  const relay = new LeadRelay();
  relay.hold = () => sessions.hold();
  const node = new Node(home, config, relay);
  sessions.onItemEnded = (session, item) => node.area("items").ended(session, item);
  registerAreas(node);
  const link = node.area("link");
  const local = node.area("local");
  const stopSocket = await serveLeadSocket(leadSocketPath(home), {
    relay,
    identify: (pid) => sessions.peerSession(pid),
    maskFor: (session) => sessions.maskFor(session),
    ...(local.any ? { browser: (session: string, frame: Record<string, unknown>) => local.answer(session, frame) } : {}),
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

  const handle = (frame: HubFrame, ctx: LinkContext) => {
    const own = link.handler(frame.t);
    if (own) return own(frame, ctx);
    switch (frame.t) {
      case "lead_result":
        return relay.resolve(frame as unknown as LeadResultFrame);
      case "cmd_check":
        void runCmdCheck(frame as unknown as CmdCheck, roots, home, ctx.signal).then((r) => ctx.send({ t: "cmd_result", ...r }));
        return;
      case "secret_deliver":
        return ctx.send({ t: "secret_result", ...deliverSecret(frame as unknown as SecretDeliver, secretsCtx) });
      case "gated_run":
        // Not the link's: an approved command runs to its end when the link drops, and the hub asks for its result.
        void gated.run(frame as unknown as GatedRun, ctx.hubId, secretsCtx).then((r) => link.send({ t: "gated_result", ...r }));
        return;
      case "gated_resume":
        void gated.resume(frame as unknown as GatedResume, ctx.hubId).then((r) => ctx.send({ t: "gated_result", ...r }));
        return;
      case "node_action":
        void runNodeAction(frame as unknown as NodeAction, { hold: () => sessions.hold() }).then((r) => ctx.send({ t: "node_action_result", ...r }));
        return;
      case "session_call":
        // Not the link's: a call that started finishes even if the link drops, and only its reply is lost.
        void sessions.handle(frame as never).then((reply) => link.send({ t: "session_reply", ...reply }));
        return;
      case "spans_ack":
        return sessions.spansAcked(Number(frame.upto), frame.rewind === true);
      default:
        // Screens' frames (browser_*, session_host, relay_dial, session_step, session_end, mac_call) go to the areas
        // that take them; without one they are dropped, as a node without the capability never gets them.
        return;
    }
  };

  const hb = node.area("hb");
  const fatal = runNode({
    settings: { hub: config.hub, machineId: config.machineId, name: config.name, nodeVersion: VERSION },
    identity,
    boxPubKey: boxKey.publicKey(),
    machineFingerprint: machineFingerprint(),
    ...(enrollToken ? { enrollToken } : {}),
    ...(enrolled ? { onEnrolled: enrolled } : {}),
    capabilities: () => CAPABILITIES,
    heartbeat: async () => {
      const parts = { load: readLoad(sessions.loginLimits() as never, home), steps: [] as unknown[], busy: { threads: sessions.running(), screens: 0, uploads: 0, hosted: 0 } };
      await hb.fill(parts);
      return { ...(parts.load ? { load: parts.load } : {}), ...(parts.steps.length ? { steps: parts.steps } : {}), busy: parts.busy };
    },
    attach: (ctx) => {
      link.linked(ctx);
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
  void fatal.then((refused) => {
    if (refused) {
      process.stderr.write(`fleetd: ${refused.message}\n`);
      resolveDone(1);
    } else resolveDone(0);
  });
  const stop = async () => {
    shutdown.abort();
    stopSocket();
    await stopAreas(node);
    await sessions.shutdown();
  };
  return { node, sessions, stop, done };
}

async function runNodeProcess(home: string, config: NodeConfig, enrollToken: string | undefined, exitWhenEnrolled: boolean): Promise<number> {
  let running: RunningNode;
  try {
    running = await startNode(home, config, enrollToken, exitWhenEnrolled);
  } catch (error) {
    process.stderr.write(`fleetd: ${(error as Error).message}\n`);
    return 1;
  }
  const signalled = new Promise<number>((resolve) => {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => resolve(0));
  });
  const code = await Promise.race([running.done, signalled]);
  await running.stop();
  return code;
}
