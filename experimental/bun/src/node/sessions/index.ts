// The node's session service (crates/fleetd/src/node/sessions/mod.rs): it answers the hub's `session_call`s, starts
// each session's claude under a host of its own (the Rust `fleetd session-host`, ../runner/host.ts), applies the
// host's events to `sessions.sqlite` (./store.ts), and streams what changed: the machine stream (projects and session
// summaries, numbered by `seq` for replay) and the thread stream (messages, items, runs and live text) of the
// sessions the hub follows.
//
// Ported: projects, launch (root, worktree, detached and isolated workspaces), send, interrupt, stop, answer,
// withdraw, the streams, windows and item reads, files and attachments, default branch, changes and the runner probe;
// a session that ran on through a node restart is re-adopted from its host; a session's MCP servers, skills, Claude
// account and 1Password token (../actions/). The calls outside sessions are ../actions/calls.ts's. Not ported (each
// answers with a plain refusal, PORT_MAP.md): worktree setup commands, warm builds, steer receipts, the node's own run
// retries and model fallback.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mkdirPrivate, readConfig } from "../config.ts";
import type { ClaudeAccount } from "../../shared/contracts.ts";
import type { McpSessionConfig, SkillBundle } from "../../shared/sessions.ts";
import type { NodeBoxKey } from "../identity.ts";
import { leadSocketPath } from "../lead/index.ts";
import { peerSession, type PeerSession } from "../lead/peer.ts";
import { Masker } from "../mask.ts";
import * as claude from "../runner/claude.ts";
import { HostLink, LaunchError, launch as launchHost, marker, shutdown, startOf, stop as stopHost, sweep, type SessionCommand } from "../runner/host.ts";
import { applyProjectEnv, copyProjectEnv, forgetOrderVars, forgetProjectEnv, orderEnvFile, orderVarsForSpawn, projectSecrets, projectVars } from "../secrets/env.ts";
import { writeAtomic } from "../secrets/files.ts";
import { headUtf16, homeDir, nowIso, tailUtf16, type Env } from "../util.ts";
import type { NodeFrame } from "../wire.ts";
import * as worktree from "../worktree/index.ts";
import { gitFiles, hasFile, putFile, rank, readProjectFile } from "./files.ts";
import { inspect, projectsRoot, scan } from "../repos/index.ts";
import { accountSecrets, envFor, putOn } from "../actions/accounts.ts";
import { handles, nodeCall, type CallContext } from "../actions/calls.ts";
import * as mcp from "../actions/mcp.ts";
import { fallback as onepasswordFallback } from "../actions/onepassword.ts";
import { CallRefusal } from "../actions/refusal.ts";
import { forgetSignins, signinsKept } from "../actions/signins.ts";
import * as skills from "../actions/skills.ts";
import * as state from "./state.ts";
import { Steers } from "./steers.ts";
import { tilde } from "../runner/claude/setup.ts";
import { HELPER, NO_HELPER } from "../runner/helper.ts";
import * as setup from "../worktree/setup.ts";
import * as hooks from "../worktree/hooks.ts";
import type { LaunchArea } from "../api.ts";
import * as warm from "../worktree/warm.ts";
import { gitCommandEnv } from "../util.ts";
import type { WorktreeSetup } from "../../shared/contracts.ts";
import { NodeStore, type SessionLocal, type SessionRow } from "./store.ts";
import {
  FOLDER_NOT_EMPTY,
  FOLDER_TAKEN,
  isActive,
  type MachineEventFrame,
  type PendingPermission,
  type RunInfo,
  type RunnerInfo,
  type SessionCallFrame,
  type SessionError,
  type SessionErrorCode,
  type SessionLaunch,
  type SessionOutput,
  type SessionReplyFrame,
  type SessionRole,
  type ThreadEvent,
  type ThreadItem,
  type ThreadMessage,
  type FailureClass,
} from "./types.ts";

const SNAPSHOT_WINDOW = 200;
const DELTA_EVERY_MS = 100;
const FILES_FOR_MS = 30_000;
const INTERRUPT_GRACE_MS = 5_000;
const STOP_GRACE_MS = 5_000;
const EXIT_WAIT_MS = 20_000;
const PROGRESS_EVERY_MS = 10_000;
const SPANS_PER_FRAME = 256;
const WITHDRAW_WAIT_MS = 3_000;
/** How long a mode-`now` send waits for claude's answer to its stop before replying without it. */
const SEND_NOW_WAIT_MS = 2_000;
/** After a wake, how long a run's claude may say nothing before the node takes its stream as lost with the network. */
const WAKE_GRACE_MS = 60_000;
const REAP_GRACE_MS = 10_000;
/** A Monitor's deadline when its call names none, and the longest claude gives one; it may fire a minute past it. */
const MONITOR_DEFAULT_MS = 5 * 60_000;
const MONITOR_MAX_MS = 30 * 60_000;
const MONITOR_GRACE_MS = 60_000;

/** What the agent is told when the Monitors it waited on were lost `when` its claude went. */
export function monitorsLost(lost: { description?: string }[], when: string): string {
  const named = lost.flatMap((m) => (m.description ? [`"${m.description}"`] : []));
  const [what, were] = lost.length === 1 ? ["Your Monitor", "was"] : ["Your Monitors", "were"];
  return `${named.length ? `${what} ${named.join(", ")}` : what} ${were} lost when ${when}. Check what you were waiting for again.`;
}

const exitWords = (exit: state.ExitInfo) =>
  exit.signal !== null
    ? `your claude process was killed (signal ${exit.signal})`
    : exit.code !== null
      ? `your claude process exited (code ${exit.code})`
      : "your claude process exited";

class Refusal extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
  }
  toError(): SessionError {
    return { code: this.code, message: headUtf16(this.message, 2000) || "failed", ...(this.fix ? { fix: this.fix } : {}) };
  }
}
const invalid = (m: string) => new Refusal("invalid", m);
const notFound = (m: string) => new Refusal("not_found", m);
const notPorted = (op: string) =>
  new Refusal("runner_unavailable", `${op} is not ported to the Bun node yet`, "run this machine's node on the Rust fleetd for it");

export const noProject = (projectId: string) => `no project ${projectId} on this machine`;
/** An id that names a file: nothing but letters, digits, `-` and `_`. */
export const pathSafe = (id: string) => /^[A-Za-z0-9_-]+$/.test(id);
const permissionItemId = (requestId: string) => `perm-${requestId}`;

/** HOME, PATH, USER, LANG and the git identity: nothing else of the node's environment reaches claude. */
export function sessionEnv(from: NodeJS.ProcessEnv = process.env): Env {
  const keys = ["HOME", "PATH", "USER", "LANG", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
  return Object.fromEntries(keys.flatMap((k) => (from[k] === undefined ? [] : [[k, from[k]!]])));
}

/** `KEY=VALUE` lines; blank lines, `#` comments, an `export ` prefix and one pair of quotes allowed. */
export function parseEnvFile(text: string): [string, string][] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .flatMap((l) => {
      const line = l.startsWith("export ") ? l.slice(7) : l;
      const eq = line.indexOf("=");
      if (eq < 0) return [];
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      const m = /^"(.*)"$|^'(.*)'$/.exec(value);
      if (m) value = m[1] ?? m[2] ?? "";
      return key ? [[key, value] as [string, string]] : [];
    });
}

export type SessionConfig = {
  /** The node home: `worktrees/`, `sessions/<id>/` and `hosts/<id>/` live here. */
  home: string;
  /** A dedicated `CLAUDE_CONFIG_DIR` for every session; undefined: the user's own claude setup. */
  configDir?: string;
  /** Optional `KEY=VALUE` lines added to every session's environment, re-read per spawn. */
  claudeEnv: string;
  baseEnv: Env;
  /** claude. */
  claudeBin: string;
  /** The Rust fleetd binary: it runs each session's host, and fleetd's MCP server and hold hook inside sessions. */
  nativeBin: string | undefined;
  boxKey?: NodeBoxKey;
  /** The node's own retries of a run that failed Overloaded or Network, after claude's: 1, 4 and 15 min, ±10%. */
  retryScheduleMs?: number[];
  /** Idle processes cost RAM: one without an active run this long is closed; the next send resumes it. */
  idleReapMs?: number;
};

/** What a node retry sends, with `--resume`, so claude picks the turn back up. */
export const RETRY_MESSAGE = "Continue where you left off.";
export const MAX_RUN_RETRIES = 3;

/** The delay before retry `attempt` (1-based): 1, 4 and 15 minutes, each ±10% by `unit` in [0, 1), whole seconds. */
export function retryDelayMs(attempt: number, unit = Math.random()): number | undefined {
  if (attempt < 1 || attempt > MAX_RUN_RETRIES) return undefined;
  const base = Math.min(60_000 * 4 ** (attempt - 1), 15 * 60_000);
  return Math.round((base * (0.9 + 0.2 * Math.min(1, Math.max(0, unit)))) / 1000) * 1000;
}

const retryable = (cls: FailureClass) => cls === "overloaded" || cls === "network";

const expandHome = (dir: string) => (dir === "~" ? homeDir() : dir.startsWith("~/") ? join(homeDir(), dir.slice(2)) : dir);

/** The node's session config, as the Rust node's `SessionConfig::for_node`. */
export function configFor(home: string, fleetdDirPath: string, nativeBin: string | undefined, boxKey?: NodeBoxKey): SessionConfig {
  let configured: string | undefined;
  try {
    configured = readConfig(home)?.claudeConfigDir;
  } catch {}
  const fromEnv = process.env.CLAUDE_CONFIG_DIR && expandHome(process.env.CLAUDE_CONFIG_DIR) !== join(fleetdDirPath, "claude") ? process.env.CLAUDE_CONFIG_DIR : undefined;
  const dir = (configured ?? fromEnv)?.trim();
  return {
    home,
    ...(dir ? { configDir: expandHome(dir) } : {}),
    claudeEnv: join(fleetdDirPath, "claude.env"),
    baseEnv: sessionEnv(),
    claudeBin: claude.claudeBinary(),
    nativeBin,
    retryScheduleMs: [1, 2, 3].map((a) => retryDelayMs(a)!),
    idleReapMs: 600_000,
    ...(boxKey ? { boxKey } : {}),
  };
}

/** What every claude the node starts gets: the base environment, `claude.env`, defaults, fleetd's own values. */
export function runnerEnv(config: SessionConfig): Env {
  const env: Env = { ...config.baseEnv };
  try {
    const extra = parseEnvFile(readFileSync(config.claudeEnv, "utf8"));
    if (extra.some(([k]) => k === "ANTHROPIC_BASE_URL")) env[claude.FLEETD_ENV_SOURCE] = tilde(config.claudeEnv);
    for (const [k, v] of extra) env[k] = v;
  } catch {}
  for (const [k, v] of claude.DEFAULT_ENV) if (!(k in env)) env[k] = v;
  if (config.configDir) env.CLAUDE_CONFIG_DIR = config.configDir;
  for (const [k, v] of claude.SESSION_ENV) env[k] = v;
  return env;
}

/** fleetd's settings overlay (`--settings`), which claude ranks above the user's own settings. */
export function settingsOverlay(
  extraEnv: Env,
  skillOverrides: Record<string, string>,
  helperModel: string,
  ask: string[],
  fast: boolean,
  heavyLsp: boolean,
  holdHook: string,
): string {
  const env: Record<string, string> = { ...claude.subagentsOffSettingsEnv(), ...extraEnv };
  env.DISABLE_AUTOUPDATER = "1";
  env[claude.HELPER_MODEL_ENV] = helperModel;
  env[claude.AUTO_MEMORY_OFF_ENV[0]] = claude.AUTO_MEMORY_OFF_ENV[1];
  const overlay: Record<string, unknown> = {
    env,
    permissions: { deny: claude.ALWAYS_DISALLOWED, ...(ask.length ? { ask } : {}) },
    autoMemoryEnabled: false,
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: holdHook, timeout: 6 * 3600 }] }] },
  };
  if (Object.keys(skillOverrides).length) overlay.skillOverrides = skillOverrides;
  if (fast) overlay.fastMode = true;
  if (!heavyLsp) overlay.enabledPlugins = Object.fromEntries(claude.HEAVY_LSP_PLUGINS.map((p) => [p, false]));
  return `${JSON.stringify(overlay)}\n`;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
/** The PreToolUse hook: free while there is no hold, `fleetd update-hold` while there is one (node/hold.rs). */
export const holdHook = (exe: string, home: string) => {
  const hold = quote(join(home, "update", "hold"));
  return `test -e ${hold} || exit 0; exec ${quote(exe)} update-hold ${hold}`;
};

/** The session's `--mcp-config` entry for fleetd's own MCP server; none for a plain thread. */
function fleetdServer(exe: string, role: SessionRole, sock: string, sessionId: string): Record<string, unknown> | undefined {
  const arg = role === "lead" || role === "assistant" ? "lead" : role === "worker" ? "worker" : undefined;
  if (!arg) return undefined;
  return { type: "stdio", command: exe, args: ["agent-mcp", "--role", arg], alwaysLoad: true, env: { FLEETD_NODE_SOCK: sock, FLEETD_THREAD_ID: sessionId } };
}

const scratchName = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
/** The session whose scratch dir `row` uses: the one it took over (`scratchOf`), else its own. */
const scratchOwner = (row: SessionRow) => row.local.scratchOf ?? row.summary.sessionId;

/** One live session's process, through its host. */
type Live = {
  generation: number;
  pid: number;
  link: HostLink;
  lastActive: number;
  /** Someone asked the process's run to end: an exit then interrupts rather than fails the run. */
  ending?: state.EndCause;
  /** A shutdown was sent: a new command waits for the exit and respawns. */
  closing: boolean;
  exited: Promise<void>;
  markExited: () => void;
  secrets: [string, string][];
  /** claude's user-message uuid → fleetd run id, for node retries sent under a fresh uuid. */
  aliases: Map<string, string>;
  /** The run the node interrupted because claude said nothing after the machine woke: it ends as a network failure,
   * so the node's retry resumes it. */
  slept?: string;
  /** Its tool calls running now, by tool_use id: while there is one, it is mid-step. */
  tools: Set<string>;
  /** Until when each Monitor it armed may still fire (epoch ms): it isn't reaped before the last of them. */
  watching: Map<string, number>;
};

type Change = {
  row: SessionRow;
  runs: RunInfo[];
  events: ThreadEvent[];
  at: string;
  announce: boolean;
};

export class SessionService {
  readonly store: NodeStore;
  readonly config: SessionConfig;
  #outlet: ((frame: NodeFrame) => void) | undefined;
  #subscribed = false;
  #followed = new Set<string>();
  #live = new Map<string, Live>();
  #generation = 0;
  #stopping = false;
  #active = new Set<string>();
  #announced = new Map<string, number>();
  #spawning = new Map<string, Promise<unknown>>();
  #files = new Map<string, { at: number; paths: string[] }>();
  #runner: RunnerInfo | undefined;
  #limits = new Map<string, { limitType: string; utilization?: number; resetsAt?: string; status: string; observedAt: string }>();
  #spans = { enabled: false, sent: 0 };
  #onRunning: ((n: number) => void)[] = [];
  #reaper: ReturnType<typeof setInterval> | undefined;
  #warmPruner: ReturnType<typeof setInterval> | undefined;
  /** Called for each step stored as completed or failed (node.area("items")). */
  onItemEnded: ((sessionId: string, item: ThreadItem) => void) | undefined;
  /** What the node's areas add to a lead's or a worker's launch (node.area("launch")). */
  launch: Pick<LaunchArea, "env" | "pluginDirs"> | undefined;
  /** Sessions whose worktree setup still runs: a send waits for it; true once the brief went to claude. */
  #settingUp = new Map<string, Promise<boolean>>();
  /** Ends a session's running setup (its command killed), and the run it is for: only that run's interrupt ends it. */
  #setupCancel = new Map<string, { runId: string; abort: AbortController }>();
  /** Node retries done per run; a run in here outlives an exit nobody asked for. */
  #retries = new Map<string, number>();
  /** This node's claude refused `--append-system-prompt-file`: until the node restarts, every start passes a session's
   * standing rules at the head of the message it starts with instead. */
  #noPromptFile = false;
  /** Tagged sends (steers), until their receipt is final; each receipt goes on the machine stream. */
  readonly #steers = new Steers((receipt) => this.#machine(this.store.appendEvent({ type: "steer", ...receipt })));
  /** Mode-`now` sends waiting on claude's answer to their stop, by run id. */
  #sendNowWaiters = new Map<string, (outcome: string) => void>();
  /** Withdraws waiting on claude's answer, by run id. */
  #withdrawWaiters = new Map<string, (cancelled: boolean) => void>();

  private constructor(store: NodeStore, config: SessionConfig) {
    this.store = store;
    this.config = config;
  }

  /** Opens the service over `<home>/sessions.sqlite`, settling what a previous node left: sessions whose host still
   * runs are re-adopted; the active runs of the rest close as interrupted. */
  static async start(config: SessionConfig): Promise<SessionService> {
    mkdirPrivate(config.home);
    const service = new SessionService(new NodeStore(join(config.home, "sessions.sqlite")), config);
    const hosts = join(config.home, "hosts");
    const adopted = new Set<string>();
    // Sessions whose claude went with the last node while a Monitor of theirs could still fire: woken once the sweep
    // below is done, or it would stop the host each wake starts.
    const lost: [string, { description?: string }[]][] = [];
    for (const row of service.store.sessions()) {
      const id = row.summary.sessionId;
      if (row.local.pid) {
        const dir = join(hosts, id);
        try {
          const link = await HostLink.connect(dir);
          if (link.pid === row.local.pid && existsSync(row.local.cwd)) {
            service.#adopt(row, link);
            adopted.add(id);
            console.log(`${nowIso()} INFO re-adopted a session that ran on through the restart {"sessionId":"${id}","pid":${link.pid}}`);
            continue;
          }
          await link.detach();
          await stopHost(dir);
        } catch {
          if (existsSync(dir)) await stopHost(dir);
        }
      }
      if (row.local.pid || row.summary.activeRunId || row.summary.pendingPermission) service.#settleRestarted(id);
      // Idle, waiting on a Monitor that went with the last node's claude: nothing else would wake it.
      const armed = (row.local.monitors ?? []).filter((m) => m.untilMs > Date.now());
      if (row.local.monitors?.length) service.update(id, (c) => void delete c.row.local.monitors);
      if (armed.length && !row.summary.activeRunId) lost.push([id, armed]);
    }
    await sweep(hosts, adopted);
    // A killed node's scratch dirs: each session's own TMPDIR stays while its worktree or its process does.
    const keep = new Set([...service.store.sessions().filter((r) => r.local.baseRef && r.summary.worktreePath).map(scratchOwner), ...adopted].map(scratchName));
    let swept = 0;
    for (const name of existsSync(join(config.home, "tmp")) ? readdirSync(join(config.home, "tmp")) : []) {
      if (keep.has(name)) continue;
      try {
        rmSync(join(config.home, "tmp", name), { recursive: true, force: true });
        swept++;
      } catch {}
    }
    if (swept) console.log(`${nowIso()} INFO removed scratch dirs a previous node left {"swept":${swept}}`);
    service.#reaper = setInterval(() => service.#reap(), Math.min(60_000, Math.max(1_000, service.#idleReapMs / 4)));
    // Once a day every checkout's warm builds are pruned to node.json's `warmBuilds`.
    service.#warmPruner = setInterval(() => warm.prune(config.home, warm.keep(config.home)), warm.PRUNE_EVERY_MS);
    for (const [id, armed] of lost) service.#wakeLost(id, armed, "this machine's fleetd node restarted");
    return service;
  }

  #adopt(row: SessionRow, link: HostLink): void {
    const id = row.summary.sessionId;
    const live = this.#newLive(link, this.#secrets(row));
    // Its Monitors run on with it, and hold it from the reaper as before.
    for (const m of row.local.monitors ?? []) live.watching.set(m.id, m.untilMs);
    this.#live.set(id, live);
    void this.#pump(id, live, row.summary.activeRunId);
    this.update(id, () => {});
  }

  #settleRestarted(id: string): void {
    this.update(id, (c) => {
      state.closeOut(c.runs, { kind: "node_restarted" }, c.at);
      this.#cancelPending(c);
      delete c.row.local.pid;
      delete c.row.local.pidStart;
    });
  }

  #newLive(link: HostLink, secrets: [string, string][]): Live {
    let markExited!: () => void;
    const exited = new Promise<void>((r) => (markExited = r));
    return { generation: ++this.#generation, pid: link.pid, link, lastActive: Date.now(), closing: false, exited, markExited, secrets, aliases: new Map(), tools: new Set(), watching: new Map() };
  }

  /** The node's retry delays: the config's, else 1, 4 and 15 min, each drawn with its jitter. */
  get #retrySchedule(): number[] {
    return this.config.retryScheduleMs ?? [1, 2, 3].map((a) => retryDelayMs(a)!);
  }

  get #idleReapMs(): number {
    return this.config.idleReapMs ?? 600_000;
  }

  get home(): string {
    return this.config.home;
  }

  /** What the calls outside sessions (../actions/calls.ts) need of the service. */
  get #calls(): CallContext {
    return {
      home: this.home,
      ...(this.config.boxKey ? { boxKey: this.config.boxKey } : {}),
      claudeBin: this.config.claudeBin,
      projectRoot: (projectId) => this.#projectRoot(projectId),
      sessionCwd: (sessionId) => this.sessionCwd(sessionId),
      runnerEnv: () => runnerEnv(this.config),
      send: (frame) => this.#outlet?.(frame),
    };
  }

  /** How many sessions have an active run (the sleep inhibitor, the heartbeat's busy). */
  running(): number {
    return this.#active.size;
  }

  onRunning(fn: (n: number) => void): void {
    this.#onRunning.push(fn);
  }

  /** The claude.ai usage windows sessions last saw, for the heartbeat. */
  loginLimits() {
    return [...this.#limits.values()];
  }

  /** Which session a process calling the node's socket runs in. */
  peerSession(pid: number): PeerSession {
    const roots = new Map<number, string>();
    for (const [id, live] of this.#live) roots.set(live.pid, id);
    return peerSession(pid, roots);
  }

  /** The masker for a session's calls: its project's secrets and its order's. */
  maskFor(sessionId: string): Masker {
    const row = this.store.session(sessionId);
    if (!row) return new Masker();
    return new Masker(this.#secrets(row));
  }

  #secrets(row: SessionRow): [string, string][] {
    const project = projectVars(this.home, row.summary.projectId);
    const secretValues = new Set(projectSecrets(this.home, row.summary.projectId));
    const out: [string, string][] = project.filter(([, v]) => secretValues.has(v));
    if (row.local.orderId) out.push(...orderVarsForSpawn(this.home, row.summary.projectId, row.local.orderId).vars);
    out.push(...mcp.sessionSecrets(this.home, join(this.home, "sessions", row.summary.sessionId)));
    const account = row.local.claudeAccount as ClaudeAccount | undefined;
    if (account) {
      try {
        out.push(...accountSecrets(this.home, account));
      } catch {}
    }
    try {
      out.push(...onepasswordFallback(this.home, row.local.onepassword as string | undefined, out));
    } catch {}
    return out;
  }

  /** A welcomed link: the streams go through `send` until the returned function detaches it. */
  attach(send: (frame: NodeFrame) => void): () => void {
    this.#outlet = send;
    return () => {
      if (this.#outlet !== send) return;
      this.#outlet = undefined;
      this.#subscribed = false;
      this.#followed.clear();
      this.#spans.enabled = false;
    };
  }

  #machine(frame: MachineEventFrame): void {
    if (frame.event.type === "session_updated") this.#announced.set(frame.event.sessionId, Date.now());
    if (this.#subscribed) this.#outlet?.({ t: "machine_event", ...frame });
  }

  #thread(sessionId: string, event: ThreadEvent): void {
    if (this.#followed.has(sessionId)) this.#outlet?.({ t: "thread_event", sessionId, at: nowIso(), event });
  }

  #session(id: string): SessionRow {
    const row = this.store.session(id);
    if (!row) throw notFound(`no session ${id} on this machine`);
    return row;
  }

  #projectRoot(projectId: string): string {
    const project = this.store.project(projectId);
    if (!project) throw notFound(noProject(projectId));
    return project.workspaceRoot;
  }

  /** The working directory this node started a session in. */
  sessionCwd(id: string): string | undefined {
    return this.store.session(id)?.local.cwd;
  }

  /** Loads a session and its runs, applies `f`, settles the summary and commits, then sends what changed. */
  update<R>(id: string, f: (c: Change) => R): R {
    const row = this.#session(id);
    const runs = this.store.runs(id);
    const before = { summary: JSON.stringify({ ...row.summary, updatedAt: "" }), runs: runs.map((r) => JSON.stringify(r)), updatedAt: row.summary.updatedAt };
    const c: Change = { row, runs, events: [], at: nowIso(), announce: false };
    const out = f(c);
    state.settle(c.row.summary, c.runs, c.at);
    if (!c.row.summary.pendingPermission) delete c.row.local.queuedPrompts;
    const changed = c.runs.filter((r, i) => before.runs[i] !== JSON.stringify(r));
    const sameSummary = JSON.stringify({ ...c.row.summary, updatedAt: "" }) === before.summary;
    const progress = !c.announce && changed.length === 0 && sameSummary;
    const quiet = progress && c.events.length === 0;
    if (quiet) c.row.summary.updatedAt = before.updatedAt;
    // Progress alone, soon after the last summary went out: stored now, its summary sent with the next change.
    const held = progress && !quiet && Date.now() - (this.#announced.get(id) ?? 0) < PROGRESS_EVERY_MS;
    const frame = this.store.commit(c.row, changed, !quiet && !held);
    for (const e of c.events) this.#thread(id, e);
    for (const r of changed) this.#thread(id, { type: "run", ...r });
    if (frame) this.#machine(frame);
    const wasActive = this.#active.size;
    if (c.row.summary.activeRunId) this.#active.add(id);
    else this.#active.delete(id);
    if (this.#active.size !== wasActive) for (const fn of this.#onRunning) fn(this.#active.size);
    return out;
  }

  #putItem(c: Change, item: ThreadItem): void {
    this.store.putItem(c.row.summary.sessionId, item);
    c.events.push({ type: "item", ...state.bounded(item) });
  }

  #putMessage(c: Change, message: ThreadMessage): void {
    this.store.putMessage(c.row.summary.sessionId, message);
    c.events.push({ type: "message", ...message });
  }

  #cancelPrompt(c: Change, requestId: string): void {
    const item = this.store.item(c.row.summary.sessionId, permissionItemId(requestId));
    if (item?.status === "running") this.#putItem(c, { ...item, status: "cancelled", completedAt: c.at, updatedAt: c.at });
  }

  #cancelPending(c: Change): void {
    const pending = c.row.summary.pendingPermission;
    if (pending) {
      delete c.row.summary.pendingPermission;
      this.#cancelPrompt(c, pending.requestId);
    }
    for (const q of c.row.local.queuedPrompts ?? []) this.#cancelPrompt(c, q.requestId);
    delete c.row.local.queuedPrompts;
  }

  #nextPrompt(c: Change): void {
    const queued = c.row.local.queuedPrompts ?? [];
    const next = queued.shift();
    if (next) c.row.summary.pendingPermission = next;
    else delete c.row.summary.pendingPermission;
    if (!queued.length) delete c.row.local.queuedPrompts;
    if (next) return;
    for (const r of c.runs) if (r.status === "waiting") r.status = "running";
  }

  /** Answers one `session_call`. */
  async handle(frame: SessionCallFrame): Promise<SessionReplyFrame> {
    try {
      return { id: frame.id, result: { ok: await this.#call(frame.call) } };
    } catch (error) {
      const refusal =
        error instanceof Refusal
          ? error
          : error instanceof CallRefusal
            ? new Refusal(error.code, error.message, error.fix)
            : error instanceof worktree.GitError
            ? new Refusal("git", error.message)
            : new Refusal("internal", (error as Error).message ?? String(error));
      return { id: frame.id, result: { err: refusal.toError() } };
    }
  }

  async #call(call: SessionCallFrame["call"]): Promise<SessionOutput> {
    const c = call as Record<string, any>;
    switch (call.op) {
      case "project_upsert":
        return this.#projectUpsert(c.projectId, c.title, c.workspaceRoot);
      case "project_remove":
        return this.#projectRemove(c.projectId, !!c.removeWorktrees, !!c.erase, !!c.removeFolder);
      case "project_env": {
        this.#projectRoot(c.projectId);
        try {
          return { kind: "project_env", secrets: applyProjectEnv(this.home, c.projectId, c.set ?? [], c.remove ?? [], this.config.boxKey) };
        } catch (error) {
          throw invalid((error as Error).message);
        }
      }
      case "project_env_copy":
        this.#projectRoot(c.from);
        this.#projectRoot(c.to);
        try {
          copyProjectEnv(this.home, c.from, c.to);
        } catch (error) {
          throw invalid((error as Error).message);
        }
        return { kind: "done" };
      case "order_env_drop":
        try {
          forgetOrderVars(this.home, c.projectId, c.orderId, c.name, c.fingerprint);
        } catch (error) {
          throw invalid((error as Error).message);
        }
        return { kind: "done" };
      case "project_worktrees":
        return this.#projectWorktrees(c.projectId);
      case "launch":
        return this.#launch(c as unknown as SessionLaunch);
      case "send": {
        if (c.mcp) this.#refreshMcp(c.sessionId, c.mcp);
        if (c.skills) this.#refreshSkills(c.sessionId, c.skills);
        const mode = c.mode ?? "plain";
        const answered = mode === "now" ? new Promise<string>((resolve) => this.#sendNowWaiters.set(c.runId, resolve)) : undefined;
        try {
          const queued = await this.#beginRun(c.sessionId, c.runId, c.text, mode, c.steer);
          const sendNow = answered && queued ? await Promise.race([answered, Bun.sleep(SEND_NOW_WAIT_MS).then(() => undefined)]) : undefined;
          return { kind: "sent", runId: c.runId, queued, ...(sendNow ? { sendNow } : {}) } as SessionOutput;
        } finally {
          this.#sendNowWaiters.delete(c.runId);
        }
      }
      case "withdraw":
        return this.#withdraw(c.sessionId, c.runId);
      case "interrupt":
        return this.#interrupt(c.sessionId, c.runId, c.reason);
      case "stop":
        return this.#stop(c.sessionId, !!c.removeWorktree);
      case "answer":
        return this.#answer(c.sessionId, c.requestId, c.decision, c.by);
      case "subscribe":
        return this.#subscribe(c.after, c.spansAfter, !!c.caughtUp);
      case "follow": {
        const snapshot = this.#snapshot(c.sessionId);
        this.#followed.add(c.sessionId);
        this.#thread(c.sessionId, { type: "snapshot", ...snapshot });
        return { kind: "done" };
      }
      case "release":
        this.#followed.delete(c.sessionId);
        return { kind: "done" };
      case "window": {
        const [entries, focus] = this.store.window(c.sessionId, c.itemId, c.before, c.after);
        return { kind: "window", entries, ...(focus === undefined ? {} : { focus }) };
      }
      case "read_item": {
        const item = this.store.item(c.sessionId, c.itemId);
        if (!item) throw notFound(`no item ${c.itemId} in session ${c.sessionId}`);
        return { kind: "item", item };
      }
      case "read_file": {
        const root = this.#projectRoot(c.projectId);
        try {
          const contents = readProjectFile(root, c.path);
          return { kind: "file", ...(contents === undefined ? {} : { contents }) };
        } catch (error) {
          throw (error as { code?: string }).code === "invalid" ? invalid((error as Error).message) : new Refusal("internal", (error as Error).message);
        }
      }
      case "default_branch": {
        const root = this.#projectRoot(c.projectId);
        const branch = worktree.hasCommit(root) ? await worktree.defaultBranch(root) : undefined;
        return { kind: "default_branch", ...(branch ? { branch } : {}) };
      }
      case "changes": {
        const row = this.#session(c.sessionId);
        let paths: string[] = [];
        if (existsSync(row.local.cwd)) {
          const base = row.local.baseRef ? worktree.changesBase(row.local.workspaceRoot, row.local.baseRef) : undefined;
          paths = worktree.changes(row.local.cwd, base);
        }
        return {
          kind: "changes",
          ...(row.summary.branch ? { branch: row.summary.branch } : {}),
          ...(row.summary.worktreePath ? { worktreePath: row.summary.worktreePath } : {}),
          paths,
        };
      }
      case "runner_info":
        return { kind: "runner_info", ...(await this.runnerInfo()) };
      case "list_files": {
        const all = this.#projectFiles(c.projectId);
        const [paths, truncated] = rank(all, c.query ?? "", c.limit);
        return { kind: "files", paths, truncated };
      }
      case "put_file": {
        const root = this.#projectRoot(c.projectId);
        try {
          putFile(root, c.relPath, Buffer.from(c.dataB64, "base64"));
        } catch (error) {
          throw invalid((error as Error).message);
        }
        return { kind: "done" };
      }
      case "has_file":
        return { kind: "has_file", has: hasFile(this.#projectRoot(c.projectId), c.relPath, c.sha256) };
      case "folder_make":
        return this.#folderMake(c.path, !!c.gitInit, !!c.dryRun);
      case "repo_inspect":
        return { kind: "repo_facts", ...(await inspect(c.path)) };
      case "repo_scan": {
        const { cloneRoot, repos } = scan(homeDir());
        return { kind: "repos", cloneRoot, repos, projectsRoot: projectsRoot(homeDir()) };
      }
      default:
        if (handles(call.op)) return nodeCall(this.#calls, call as Parameters<typeof nodeCall>[1]);
        throw notPorted(call.op);
    }
  }

  #projectFiles(projectId: string): string[] {
    const cached = this.#files.get(projectId);
    if (cached && Date.now() - cached.at < FILES_FOR_MS) return cached.paths;
    const root = this.#projectRoot(projectId);
    let paths: string[];
    try {
      paths = gitFiles(root);
    } catch (error) {
      throw new Refusal("git", (error as Error).message);
    }
    this.#files.set(projectId, { at: Date.now(), paths });
    return paths;
  }

  #projectUpsert(projectId: string, title: string, root: string): SessionOutput {
    if (!pathSafe(projectId)) throw invalid(`project id ${projectId} has characters a path can't hold`);
    // A relative root is a folder of the node's own, made when missing (a Navi's).
    const folder = !isAbsolute(root) && !root.startsWith("~") && pathSafe(root.replaceAll("/", "_")) ? join(this.home, root) : undefined;
    let workspaceRoot = root;
    if (folder) {
      const ours = this.store.project(projectId)?.workspaceRoot === folder;
      try {
        mkdirSync(join(folder, ".."), { recursive: true });
        mkdirSync(folder);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "EEXIST") throw invalid(`${folder} was not made: ${(error as Error).message}`);
        if (!ours) throw invalid(`${FOLDER_TAKEN}${folder}`);
      }
      workspaceRoot = folder;
    }
    if (!isAbsolute(workspaceRoot) || !existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory())
      throw invalid(`${workspaceRoot} is not a directory on this machine`);
    this.#machine(this.store.upsertProject({ projectId, title, workspaceRoot, updatedAt: nowIso() }));
    return folder ? { kind: "folder", path: workspaceRoot } : { kind: "done" };
  }

  #worktreesDir(projectId: string): string {
    return join(this.home, "worktrees", projectId);
  }

  async #projectWorktrees(projectId: string): Promise<SessionOutput> {
    const root = this.#projectRoot(projectId);
    const worktrees = this.store
      .sessions()
      .filter((r) => r.summary.projectId === projectId && r.local.baseRef && r.summary.worktreePath && existsSync(r.local.cwd))
      .map((r) => {
        let dirty = true;
        try {
          dirty = worktree.uncommitted(r.local.cwd);
        } catch {}
        return { sessionId: r.summary.sessionId, path: r.local.cwd, ...(r.local.branch ? { branch: r.local.branch } : {}), uncommitted: dirty };
      });
    const baseBranch = worktree.hasCommit(root) ? (await worktree.defaultBranch(root)) : undefined;
    return { kind: "project_worktrees", dir: this.#worktreesDir(projectId), ...(baseBranch ? { baseBranch } : {}), worktrees, signinsKept: signinsKept(this.home, projectId) };
  }

  async #projectRemove(projectId: string, removeWorktrees: boolean, erase: boolean, removeFolder: boolean): Promise<SessionOutput> {
    const project = this.store.project(projectId);
    const ids = this.store.sessions().filter((r) => r.summary.projectId === projectId);
    for (const row of ids) if (this.#live.has(row.summary.sessionId)) await this.#stop(row.summary.sessionId, false, "the project was removed");
    if (removeWorktrees && project) {
      try {
        worktree.removeAll(project.workspaceRoot, this.#worktreesDir(projectId));
      } catch {}
      rmSync(this.#worktreesDir(projectId), { recursive: true, force: true });
      warm.dropPool(this.home, project.workspaceRoot);
    }
    if (erase) {
      this.store.forgetSessions(projectId);
      if (removeFolder && project) rmSync(project.workspaceRoot, { recursive: true, force: true });
    }
    // A Navi's kept browser profile goes with it, before the project does.
    try {
      forgetSignins(this.home, projectId);
    } catch (error) {
      throw invalid((error as Error).message);
    }
    forgetProjectEnv(this.home, projectId);
    mcp.forgetSecrets(this.home, projectId);
    const frame = this.store.removeProject(projectId);
    if (frame) this.#machine(frame);
    return { kind: "done" };
  }

  #folderMake(path: string, gitInit: boolean, dryRun: boolean): SessionOutput {
    const dir = expandHome(path);
    if (!isAbsolute(dir) || dir.split("/").some((p) => p === "." || p === "..")) throw invalid(`${path} is not a full path: start it with / or ~/`);
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) throw invalid(`${dir} is a file`);
      if (readdirSync(dir).length) throw invalid(`${FOLDER_NOT_EMPTY}${dir}`);
    }
    if (!dryRun) {
      mkdirSync(dir, { recursive: true });
      if (gitInit) worktree.git(dir, ["init"]);
    }
    return { kind: "folder", path: dir };
  }

  /** Keeps a session's MCP servers in its directory for its next start. */
  #keepMcp(id: string, kept: mcp.Kept): void {
    try {
      mcp.keep(join(this.home, "sessions", id), kept);
    } catch (error) {
      console.log(`${nowIso()} WARN the session's MCP servers were not kept: ${(error as Error).message} {"session":"${id}"}`);
    }
  }

  /** The hub's MCP servers for a session changed: kept for its next start (a running claude keeps the servers it
   * started with). A session from before MCP servers takes its role from what it is; a plain thread gets none. */
  #refreshMcp(id: string, config: McpSessionConfig): void {
    const row = this.store.session(id);
    if (!row) return;
    const role = mcp.kept(join(this.home, "sessions", id))?.role ?? mcp.roleOf(row.local.role, row.local.branch);
    if (role) this.#keepMcp(id, { role, config });
  }

  /** The hub's skills for a session changed: kept for its next start, and its skills folder written again now, so a
   * running session reads a new one there (FLEETD_SKILLS_DIR) before its next start lists it. */
  #refreshSkills(id: string, bundles: SkillBundle[]): void {
    const row = this.store.session(id);
    if (!row) return;
    const dir = join(this.home, "sessions", id);
    try {
      skills.keepSkills(dir, bundles);
      skills.prepare(dir, row.local.cwd);
    } catch (error) {
      console.log(`${nowIso()} WARN the session's skills were not refreshed: ${(error as Error).message} {"session":"${id}"}`);
    }
  }

  async #launch(launch: SessionLaunch): Promise<SessionOutput> {
    const id = launch.sessionId;
    const existing = this.store.session(id);
    if (existing) return { kind: "launched", summary: existing.summary };
    if (!pathSafe(id)) throw invalid(`session id ${id} has characters a path can't hold`);
    const root = this.#projectRoot(launch.projectId);
    const ws = launch.workspace;
    // A session taking over an earlier one of the same branch (a task restarted fresh) works in that one's worktree as
    // it was left, uncommitted changes included, with its scratch dir; a worktree that is gone comes back first.
    const earlier = ws.type === "worktree" && ws.fromSession ? this.store.session(ws.fromSession) : undefined;
    const taken = earlier?.local.baseRef && ws.type === "worktree" && earlier.local.branch === ws.branch ? earlier : undefined;
    let base: worktree.Base | undefined;
    if (ws.type !== "root" && !taken) base = await worktree.freshBase(root, ws.baseRef);
    // A retry that arrived while this one fetched.
    const raced = this.store.session(id);
    if (raced) return { kind: "launched", summary: raced.summary };
    const path = join(this.#worktreesDir(launch.projectId), id);
    let prompt = launch.prompt;
    let readerPlan: WorktreeSetup | undefined;
    let cwd = root;
    let addDirs: string[] = [];
    let baseRef: string | undefined;
    let branch: string | undefined;
    let recreatedFrom: worktree.Source["kind"] | undefined;
    if (taken) {
      const lost = await this.#lostWorktree(taken);
      if (lost && taken.local.branch) {
        worktree.restore(taken.local.workspaceRoot, taken.local.cwd, taken.local.branch, lost);
        console.log(`${nowIso()} INFO recreated a lost worktree to take over {"sessionId":"${id}","from":"${lost.kind}"}`);
        recreatedFrom = lost.kind;
        // Rebuilt, it has none of what setup made there before.
        setup.record(taken.local.cwd, undefined);
        prompt = `${worktree.sourceNote(lost, taken.local.branch)}\n\n${prompt}`;
      }
      [cwd, addDirs, baseRef, branch] = [taken.local.cwd, taken.local.addDirs, taken.local.baseRef, taken.local.branch];
    } else if (ws.type === "worktree" && base) {
      worktree.ensure(root, path, ws.branch, base.sha);
      [cwd, addDirs, baseRef, branch] = [path, [root], base.baseRef, ws.branch];
    } else if (ws.type === "detached" && base) {
      const sha = (ws.head && worktree.knownCommit(root, ws.head)) || base.sha;
      worktree.ensureDetached(root, path, sha);
      [cwd, addDirs, baseRef] = [path, [root], sha];
      // A reader's setup: its project's, time-boxed and never stopping it, else installs for the apps it touches.
      readerPlan = warm.readerSetup(launch.setup, path, base.sha);
      if (warm.take(this.home, root, path)) prompt = `${prompt.trimEnd()}\n\n${warm.WARM_NOTE}`;
    } else if (launch.isolated) {
      cwd = join(this.home, "isolated");
      mkdirPrivate(cwd);
    }
    const at = nowIso();
    const profile = launch.profile ?? claude.profileOf(launch.model ?? "", launch.effort ?? "high");
    const own = claude.profileModel(profile);
    const model = launch.profile ? (launch.model ?? own.model) : own.model;
    const effort = launch.profile ? (launch.effort ?? own.effort) : own.effort;
    const title = launch.title ?? [...(launch.prompt.split("\n")[0] ?? "")].slice(0, 80).join("");
    const row: SessionRow = {
      summary: {
        sessionId: id,
        projectId: launch.projectId,
        title,
        status: "idle",
        model,
        effort,
        runtimeMode: launch.runtimeMode,
        ...(branch ? { branch } : {}),
        ...(baseRef ? { worktreePath: cwd } : {}),
        ...(recreatedFrom ? { recreatedFrom, recreatedAt: at } : {}),
        createdAt: at,
        updatedAt: at,
      },
      local: {
        cwd,
        addDirs,
        configDir: claude.configDir(runnerEnv(this.config)),
        workspaceRoot: root,
        ...(baseRef ? { baseRef } : {}),
        ...(branch ? { branch } : {}),
        started: false,
        allowedTools: launch.allowedTools ?? [],
        disallowedTools: launch.disallowedTools ?? [],
        ...(launch.allowedOnly ? { allowedOnly: true } : {}),
        role: launch.role ?? "plain",
        ...(launch.orderId ? { orderId: launch.orderId } : {}),
        profile,
        ...(launch.fast ? { fast: true } : {}),
        ...(launch.helperModel ? { helperModel: launch.helperModel } : {}),
        ...(launch.systemPrompt ? { systemPrompt: launch.systemPrompt } : {}),
        ...(launch.claudeAccount ? { claudeAccount: launch.claudeAccount } : {}),
        ...(launch.onepassword ? { onepassword: launch.onepassword } : {}),
        ...(taken ? { scratchOf: scratchOwner(taken) } : {}),
      },
    };
    // Setup applies to a session in a worktree of its own.
    const chosen = readerPlan ?? launch.setup;
    const plan = chosen && (chosen.commands ?? []).length && baseRef ? chosen : undefined;
    if (plan) {
      row.local.setup = plan;
      row.local.setupPending = true;
    }
    this.store.commit(row, [], false);
    const dir = join(this.home, "sessions", id);
    if (launch.mcpRole && launch.mcp) this.#keepMcp(id, { role: launch.mcpRole, config: launch.mcp });
    try {
      skills.keepSkills(dir, launch.skills ?? []);
    } catch (error) {
      throw new Refusal("internal", `cannot keep the session's skills: ${(error as Error).message}`);
    }
    // A new worktree is set up first, while the run shows as starting; the brief goes to claude once it is done.
    if (plan) {
      if (this.#recordRun(id, launch.runId, prompt)) this.#setUpThenSend(id, launch.runId, prompt, "plain", plan);
    } else await this.#beginRun(id, launch.runId, prompt, "plain");
    const reported = base && { ref: base.baseRef, sha: base.sha, ...(base.fetchedAt ? { fetchedAt: base.fetchedAt } : {}), ...(base.error ? { error: base.error } : {}) };
    return { kind: "launched", summary: this.#session(id).summary, ...(reported ? { base: reported } : {}) };
  }

  /** Records a run and its user message, then hands it to the session's process. Whether it waits behind an active
   * run. Idempotent on `runId`. */
  /** Records a run and its user message; false when it was recorded before (a retry). */
  #recordRun(id: string, runId: string, text: string): boolean {
    return this.update(id, (c) => {
      if (c.runs.some((r) => r.id === runId)) return false;
      const queued = c.runs.some((r) => isActive(r.status));
      c.runs.push({ id: runId, status: queued ? "queued" : "starting", ordinal: c.runs.length + 1, queuedAt: c.at });
      this.#putMessage(c, { id: runId, runId, role: "user", text, createdAt: c.at });
      return true;
    });
  }

  async #beginRun(id: string, runId: string, text: string, mode: "plain" | "boundary" | "now", steer?: { id: string; riders?: string[] }): Promise<boolean> {
    const recorded = this.update(id, (c): { again: boolean } | { queued: boolean } => {
      const known = c.runs.find((r) => r.id === runId);
      if (known) return { again: known.status === "queued" };
      const queued = c.runs.some((r) => isActive(r.status));
      c.runs.push({ id: runId, status: queued ? "queued" : "starting", ordinal: c.runs.length + 1, queuedAt: c.at });
      this.#putMessage(c, { id: runId, runId, role: "user", text, createdAt: c.at });
      return { queued };
    });
    if ("again" in recorded) return recorded.again;
    if (steer) for (const steerId of [...(steer.riders ?? []), steer.id]) this.#steers.track(id, runId, steerId, recorded.queued);
    // The worktree is still being set up: the message goes once that has ended and the brief has gone.
    const settingUp = this.#settingUp.get(id);
    if (settingUp) {
      void settingUp.then(async (started) => {
        if (started) await this.#dispatch(id, { Send: { run_id: runId, text, mode } }).catch((e) => this.#failRun(id, runId, "other", (e as Error).message));
        else {
          const why = "the session did not start: its worktree setup failed or was stopped";
          this.#failRun(id, runId, "other", why);
          this.#steers.failed(runId, why);
        }
      });
      return recorded.queued;
    }
    // Setup is due (the node stopped before it ended): it runs again first, and the message goes once it has ended.
    const due = this.#setupDue(id);
    if (!recorded.queued && due) {
      this.#setUpThenSend(id, runId, text, mode, due);
      return recorded.queued;
    }
    try {
      await this.#dispatch(id, { Send: { run_id: runId, text, mode } });
    } catch (error) {
      const message = error instanceof Refusal ? error.message : (error as Error).message;
      this.#failRun(id, runId, "other", message);
      this.#steers.failed(runId, message);
      throw error;
    }
    return recorded.queued;
  }

  #failRun(id: string, runId: string, cls: FailureClass, message: string): void {
    try {
      this.update(id, (c) => {
        const run = c.runs.find((r) => r.id === runId && isActive(r.status));
        if (!run) return;
        run.status = "failed";
        run.endedAt = c.at;
        run.failure = { class: cls, message: headUtf16(message, 4000) || "failed", retries: 0 };
        run.end = state.failureEnd(run.failure);
      });
    } catch {}
  }

  async #dispatch(id: string, command: SessionCommand, alias?: [uuid: string, runId: string]): Promise<void> {
    const [live, note] = await this.#ensureLive(id);
    live.lastActive = Date.now();
    if (alias) live.aliases.set(alias[0], alias[1]);
    // A claude without the system prompt file gets the rules with the message its start sends.
    const sent = note && typeof command === "object" && "Send" in command ? { Send: { ...command.Send, text: `${note}\n\n${command.Send.text}` } } : command;
    if (!live.link.send(sent)) throw new Refusal("internal", "the session's claude process ended");
  }

  /** The fleetd run id of claude's user-message uuid. */
  #resolve(live: Live, uuid: string): string {
    return live.aliases.get(uuid) ?? uuid;
  }

  /** The live process, spawning (first start) or resuming the session when there is none. One spawn per session at a
   * time, so two sends never start two processes. */
  #ensureLive(id: string): Promise<[Live, string | undefined]> {
    const prior = this.#spawning.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.#spawn(id));
    this.#spawning.set(id, next);
    return next;
  }

  async #spawn(id: string): Promise<[Live, string | undefined]> {
    const current = this.#live.get(id);
    if (current && !current.closing) return [current, undefined];
    if (current) await Promise.race([current.exited, Bun.sleep(EXIT_WAIT_MS)]);
    if (this.#stopping) throw new Refusal("runner_unavailable", "the node is stopping");
    if (!this.config.nativeBin) throw new Refusal("runner_unavailable", NO_HELPER);
    const row = this.#session(id);
    const env = runnerEnv(this.config);
    let resume: boolean;
    try {
      resume = state.startMode(row.local, claude.configDir(env), id);
    } catch (error) {
      throw new Refusal("runner_unavailable", (error as Error).message);
    }
    // A worktree that is gone (a crash, a stop that removed it, a person) comes back first, at the same path.
    const [recreated, rebuilt] = await this.#restoreWorktree(id, row);
    if (recreated) {
      const frame = this.store.commit(row, [], true);
      if (frame) this.#machine(frame);
    }
    if (!existsSync(row.local.cwd)) throw invalid(`the session's workspace ${row.local.cwd} is missing`);
    const spec = this.#spec(row, resume, env);
    // The agent hears that its worktree was rebuilt before anything else, so it checks what is left; and a claude
    // without the system prompt file, its rules.
    let note = rebuilt;
    if (this.#noPromptFile && row.local.systemPrompt) {
      delete spec.systemPrompt;
      note = note ? `${row.local.systemPrompt.trimEnd()}\n\n${note}` : row.local.systemPrompt.trimEnd();
    }
    const file = claude.sessionFile(claude.configDir(spec.env), spec.cwd, id);
    if (file) spec.resume = existsSync(file);
    const mark = marker(id);
    let link: HostLink;
    try {
      link = await launchHost({
        exe: this.config.nativeBin!,
        dir: spec.hostDir!,
        sessionId: id,
        program: this.config.claudeBin,
        args: claude.args(spec),
        cwd: spec.cwd,
        env: { ...claude.spawnEnv(spec, mark) },
      });
    } catch (error) {
      if (error instanceof LaunchError && error.refused?.missing && !existsSync(this.config.claudeBin))
        throw new Refusal("runner_unavailable", `${this.config.claudeBin} was not found on PATH`, `install Claude Code: curl -fsSL https://claude.ai/install.sh | bash`);
      throw new Refusal("runner_unavailable", `could not start ${this.config.claudeBin}: ${(error as Error).message} (cwd ${spec.cwd})`);
    }
    row.local.started = true;
    row.local.pid = link.pid;
    const start = startOf(link.pid);
    if (start !== undefined) row.local.pidStart = String(start);
    this.store.commit(row, [], false);
    const live = this.#newLive(link, this.#secrets(row));
    this.#live.set(id, live);
    void this.#pump(id, live, undefined);
    return [live, note];
  }

  /** Writes the session's files and builds its spec (sessions/mod.rs `spec`): MCP config, settings overlay, system
   * prompt, and the environment. */
  #spec(row: SessionRow, resume: boolean, base: Env): claude.SessionSpec {
    const id = row.summary.sessionId;
    const dir = join(this.home, "sessions", id);
    mkdirPrivate(dir);
    const sock = leadSocketPath(this.home);
    const role = row.local.role ?? "plain";
    // The configured servers of the session's role, their secrets resolved here, then fleetd's own. The file holds
    // secrets, so it is written as the node's secret files are (0600).
    const sessionMcp = mcp.sessionConfig(this.home, mcp.kept(dir), fleetdServer(this.config.nativeBin ?? HELPER, role, sock, id), id);
    const mcpConfig = join(dir, "mcp.json");
    writeAtomic(mcpConfig, sessionMcp.json);
    const env: Env = { ...base };
    // The session's Claude account in place of the machine's own login and gateway, read at each start. One the node
    // no longer holds fails the start: it never runs on the machine's login instead.
    const account = row.local.claudeAccount as ClaudeAccount | undefined;
    if (account) {
      try {
        putOn(env, envFor(this.home, account).vars);
      } catch (error) {
        throw new Refusal("runner_unavailable", (error as Error).message);
      }
    }
    // The project's own variables, then its order's in place of the project's of the same name. What the node already
    // gives claude keeps the node's value; the 1Password token is the node's alone.
    const order = row.local.orderId ? orderVarsForSpawn(this.home, row.summary.projectId, row.local.orderId).vars : [];
    const project = projectVars(this.home, row.summary.projectId).filter(([n]) => !order.some(([o]) => o === n));
    for (const [k, v] of [...project, ...order]) if (!(k in env) && k !== "OP_SERVICE_ACCOUNT_TOKEN") env[k] = v;
    const roleVars: Env = {};
    for (const v of claude.PROMPT_CACHE_TTL_VARS) roleVars[v] = env[v] ?? claude.defaultCacheTtl(role);
    Object.assign(roleVars, claude.roleEnv(role, env));
    Object.assign(env, roleVars);
    let systemPrompt: string | undefined;
    if (row.local.systemPrompt) {
      systemPrompt = join(dir, "system-prompt.md");
      writeAtomic(systemPrompt, row.local.systemPrompt);
    }
    const prepared = skills.prepare(dir, row.local.cwd);
    env[skills.DIR_ENV] = skills.skillsDir(dir);
    const settings = join(dir, "settings.json");
    const helperModel = row.local.helperModel ?? claude.MODEL;
    const ask = row.local.allowedOnly ? [] : claude.roleAsk(role, row.summary.runtimeMode);
    writeAtomic(settings, settingsOverlay(roleVars, skills.overrides(prepared), helperModel, ask, !!row.local.fast, claude.heavyLspOn(env), holdHook(this.config.nativeBin ?? HELPER, this.home)));
    env.FLEETD_NODE_SOCK = sock;
    env.FLEETD_THREAD_ID = id;
    env.FLEETD_PROJECT_ID = row.summary.projectId;
    delete env[claude.ORDER_ENV_FILE_ENV];
    const sourced = row.local.orderId ? orderEnvFile(this.home, row.summary.projectId, row.local.orderId) : undefined;
    if (sourced) {
      const at = join(dir, "order-env.sh");
      writeFileSync(at, sourced);
      env[claude.ORDER_ENV_FILE_ENV] = at;
    }
    env[claude.AUTO_MEMORY_OFF_ENV[0]] = claude.AUTO_MEMORY_OFF_ENV[1];
    // A writer's commits name its task, so its work merged by hand is found from git alone, and it pushes only a tree
    // its repo's pre-push check passed on.
    const task = row.local.branch ? hooks.branchTask(row.local.branch) : undefined;
    if (task && existsSync(row.local.cwd)) {
      try {
        hooks.trailerHooks(row.local.cwd, task);
      } catch (error) {
        console.warn(`${nowIso()} WARN commits won't name their task {"sessionId":"${id}","error":${JSON.stringify(String(error))}}`);
      }
      try {
        hooks.gate(row.local.cwd, env);
      } catch (error) {
        console.warn(`${nowIso()} WARN pushes won't wait for the repo's pre-push check {"sessionId":"${id}","error":${JSON.stringify(String(error))}}`);
      }
    }
    const scratch = join(this.home, "tmp", scratchName(scratchOwner(row)));
    mkdirPrivate(scratch);
    for (const k of ["TMPDIR", "TMP", "TEMP", "CLAUDE_CODE_TMPDIR"]) env[k] = scratch;
    // The screens' areas: an agent's session gets their tools' variables and skills (Rust's browser SessionHooks).
    const pluginDirs = prepared.pluginDir ? [prepared.pluginDir] : [];
    if (this.launch && role !== "plain") {
      for (const [k, v] of this.launch.env(id, env.PATH)) env[k] = v;
      for (const d of this.launch.pluginDirs()) if (!pluginDirs.includes(d)) pluginDirs.push(d);
    }
    const allowed = [...(row.local.allowedTools ?? [])];
    for (const t of claude.roleAllowed(role, row.summary.runtimeMode)) if (!allowed.includes(t)) allowed.push(t);
    return {
      sessionId: id,
      resume,
      mustResume: false,
      cwd: row.local.cwd,
      addDirs: row.local.addDirs ?? [],
      model: row.summary.model,
      effort: row.summary.effort,
      helperModel,
      runtimeMode: row.summary.runtimeMode,
      allowedTools: allowed,
      allowedOnly: !!row.local.allowedOnly,
      ...(systemPrompt ? { systemPrompt } : {}),
      disallowedTools: [...claude.ALWAYS_DISALLOWED, ...claude.roleDisallowed(role), ...(row.local.disallowedTools ?? [])],
      mcpConfig,
      strictMcp: sessionMcp.strict,
      settings,
      pluginDirs,
      env,
      hostDir: join(this.home, "hosts", id),
      isolated: row.local.cwd === join(this.home, "isolated"),
    };
  }

  /** Applies one process's events in order until it exits. Text deltas go only to followers, at most one frame per
   * DELTA_EVERY_MS. */
  async #pump(id: string, live: Live, startRun: string | undefined): Promise<void> {
    let runId = startRun;
    let delta: { messageId: string; text: string } | undefined;
    let deltaTimer: ReturnType<typeof setTimeout> | undefined;
    let masker = new Masker(live.secrets);
    const flushDelta = (hold: boolean) => {
      if (!delta) return;
      const keep = hold ? masker.held(delta.text) : 0;
      const out = delta.text.slice(0, delta.text.length - keep);
      const kept = delta.text.slice(delta.text.length - keep);
      const messageId = delta.messageId;
      delta = keep ? { messageId, text: kept } : undefined;
      if (out) this.#thread(id, { type: "delta", messageId, ...(runId ? { runId } : {}), append: masker.text(out) });
    };
    for (;;) {
      const raw = await live.link.next();
      if (raw === undefined) {
        if (live.link.detached) break;
        this.#exited(id, live, { code: null, signal: null, stderr_tail: "the runner stopped reporting on claude" });
        break;
      }
      const event = masker.empty ? raw : masker.value(raw);
      live.lastActive = Date.now();
      try {
        if (typeof event === "string") continue;
        const [kind, body] = Object.entries(event)[0] as [string, any];
        switch (kind) {
          case "Delta":
            if (!this.#followed.has(id)) break;
            if (delta && delta.messageId !== body.message_id) flushDelta(false);
            delta = delta ? { messageId: delta.messageId, text: delta.text + body.append } : { messageId: body.message_id, text: body.append };
            if (!deltaTimer)
              deltaTimer = setTimeout(() => {
                deltaTimer = undefined;
                flushDelta(true);
              }, DELTA_EVERY_MS);
            break;
          case "Exited":
            clearTimeout(deltaTimer);
            this.#exited(id, live, body);
            live.link.applied++;
            live.markExited();
            return;
          case "RunStarted": {
            const started = this.#resolve(live, body.run_id);
            runId = started;
            masker = new Masker(this.#secrets(this.#session(id)));
            this.#steers.delivered(started, false);
            this.update(id, (c) => {
              let run = c.runs.find((r) => r.id === started);
              // A turn claude started by itself (a Monitor's notice): a run of the session's from here.
              if (!run) {
                run = { id: started, status: "running", ordinal: c.runs.length + 1, startedAt: c.at };
                c.runs.push(run);
              }
              if (run.status === "queued" || run.status === "starting") {
                run.status = "running";
                run.startedAt ??= c.at;
              }
            });
            break;
          }
          case "Joined":
            this.update(id, (c) => {
              const joined = this.#resolve(live, body.run_id);
              const run = c.runs.find((r) => r.id === joined);
              if (run && (run.status === "queued" || run.status === "starting")) {
                run.status = "running";
                run.startedAt ??= c.at;
              }
            });
            this.#steers.delivered(this.#resolve(live, body.run_id), true);
            break;
          case "AssistantText":
            if (delta?.messageId === body.message_id) delta = undefined;
            this.#steers.text(id, body.message_id, body.text);
            this.update(id, (c) => {
              const prior = this.store.message(id, body.message_id);
              const message: ThreadMessage = prior
                ? { ...prior, text: `${prior.text}\n\n${body.text}` }
                : { id: body.message_id, ...(runId ? { runId } : {}), role: "assistant", text: body.text, createdAt: c.at };
              c.row.summary.latestAssistantTail = tailUtf16(message.text, state.ASSISTANT_TAIL);
              this.#putMessage(c, message);
            });
            break;
          case "Item": {
            const item = body as ThreadItem;
            if (item.kind.type === "permission") {
              const requestId = item.kind.requestId;
              this.update(id, (c) => {
                this.#cancelPrompt(c, requestId);
                c.row.local.queuedPrompts = (c.row.local.queuedPrompts ?? []).filter((p) => p.requestId !== requestId);
                if (c.row.summary.pendingPermission?.requestId === requestId) this.#nextPrompt(c);
              });
            } else {
              this.#step(live, item);
              this.#watching(id, live, item);
              this.update(id, (c) => this.#putItem(c, item));
              if (item.status === "completed" || item.status === "failed") this.onItemEnded?.(id, item);
            }
            break;
          }
          case "WatchEnded":
            // Its notice has come, so nothing more of it can wake the session.
            live.watching.delete(body.tool_use_id);
            this.update(id, (c) => {
              c.row.local.monitors = (c.row.local.monitors ?? []).filter((m) => m.id !== body.tool_use_id);
              if (!c.row.local.monitors.length) delete c.row.local.monitors;
            });
            break;
          case "Compacting":
            this.update(id, (c) => void (c.announce = true));
            break;
          case "PermissionRequest":
            this.#permission(id, live, body.request_id, body.tool_name, body.input, body.summary, runId);
            break;
          case "RunEnded": {
            const ended = this.#resolve(live, body.run_id);
            // A call cut off with its run never reports its end.
            live.tools.clear();
            this.#runEnded(id, live, ended, body.outcome, body.usage);
            // A run the node retries stays active: its steers wait for the retry.
            if (!this.store.runs(id).some((r) => r.id === ended && isActive(r.status)))
              this.#steers.ended(ended, typeof body.outcome === "object" && "Failed" in body.outcome ? body.outcome.Failed.message : undefined);
            break;
          }
          case "Seen":
            this.#steers.seen((body.run_ids as string[]).map((r) => this.#resolve(live, r)));
            break;
          case "SendNow": {
            const run = this.#resolve(live, body.run_id);
            this.#sendNowWaiters.get(run)?.(body.outcome);
            this.#sendNowWaiters.delete(run);
            this.#steers.sendNow(run, body.outcome, body.stopped_tool ?? undefined);
            break;
          }
          case "Usage":
            if (this.#followed.has(id)) this.#thread(id, { type: "usage", runId: this.#resolve(live, body.run_id), usage: body.usage });
            break;
          case "RateLimit":
            if (body.limit_type)
              this.#limits.set(body.limit_type, {
                limitType: body.limit_type,
                status: body.status,
                observedAt: nowIso(),
                ...(body.utilization === null || body.utilization === undefined ? {} : { utilization: body.utilization }),
                ...(body.resets_at ? { resetsAt: new Date(body.resets_at * 1000).toISOString() } : {}),
              });
            break;
          case "Spans":
            this.store.putSpans((body as { sessionId: string; endMs: number }[]).map((s) => ({ ...s, sessionId: s.sessionId ?? id })));
            this.#flushSpans();
            break;
          case "Withdrawn": {
            const run = this.#resolve(live, body.run_id);
            this.#withdrawWaiters.get(run)?.(!!body.cancelled);
            this.#withdrawWaiters.delete(run);
            this.#steers.withdrawn(run, !!body.cancelled, !!body.by_stop);
            break;
          }
          default:
            // Init, Queued: nothing to apply.
            break;
        }
      } catch (error) {
        console.warn(`${nowIso()} WARN session event not applied {"sessionId":"${id}","error":${JSON.stringify(String(error))}}`);
      } finally {
        live.link.applied++;
      }
    }
    clearTimeout(deltaTimer);
    live.markExited();
  }

  #permission(id: string, live: Live, requestId: string, toolName: string, input: unknown, summary: string, runId: string | undefined): void {
    const decision = this.update(id, (c) => {
      const decision = state.autoAnswer(c.row.summary.runtimeMode, !!c.row.local.allowedOnly, toolName, input);
      this.#putItem(c, {
        id: permissionItemId(requestId),
        ...(runId ? { runId } : {}),
        status: decision ? "completed" : "running",
        title: `Permission: ${toolName}`,
        startedAt: c.at,
        ...(decision ? { completedAt: c.at } : {}),
        updatedAt: c.at,
        kind: { type: "permission", requestId, toolName, summary, ...(decision ? { decision } : {}) },
      });
      if (!decision) {
        const prompt: PendingPermission = {
          requestId: requestId || "?",
          toolName: toolName || "?",
          summary: tailUtf16(summary, 2000),
          ...(JSON.stringify(input).length <= 64 * 1024 ? { input } : {}),
        };
        if (c.row.summary.pendingPermission) (c.row.local.queuedPrompts ??= []).push(prompt);
        else c.row.summary.pendingPermission = prompt;
        const active = c.runs.find((r) => isActive(r.status));
        if (active) active.status = "waiting";
      }
      return decision;
    });
    if (decision) live.link.send({ Answer: { request_id: requestId, decision, by: "policy" } });
  }

  #runEnded(id: string, live: Live, runId: string, outcome: state.RunOutcome, usage: unknown): void {
    // The node cut it after the machine woke: a network failure, which the node's retry resumes.
    if (live.slept === runId) {
      live.slept = undefined;
      live.ending = undefined;
      if (outcome === "Interrupted" || (typeof outcome === "object" && "Failed" in outcome))
        outcome = { Failed: { class: "network", message: "the machine slept, and claude's stream did not come back after it woke", retries: 0 } };
    }
    let retries = 0;
    if (typeof outcome === "object" && "Failed" in outcome) {
      const failure = outcome.Failed;
      // claude never said `started` and no API call answered: it never took the message in, so a retry sends the
      // message itself.
      const unread = failure.apiStatus === undefined && this.store.runs(id).some((r) => r.id === runId && r.status === "starting");
      if (unread && claude.sessionInUse(failure.message) && this.#resendRefused(id, live, runId)) return;
      // A claude older than the flag: the start goes again, the rules in the message.
      if (unread && claude.promptFileUnknown(failure.message)) {
        this.#noPromptFile = true;
        if (this.#resendRefused(id, live, runId)) return;
      }
      if (this.#fallBack(id, live, runId, failure, unread)) return;
      if (retryable(failure.class)) {
        const attempt = (this.#retries.get(runId) ?? 0) + 1;
        this.#retries.set(runId, attempt);
        const delay = this.#retrySchedule[attempt - 1];
        if (delay !== undefined) {
          this.#scheduleRetry(id, runId, attempt, delay, failure, unread);
          return;
        }
        retries = attempt - 1;
      }
    }
    this.#retries.delete(runId);
    const cause = live.ending ?? (this.#stopping ? ({ kind: "node_stopping" } as const) : undefined);
    live.ending = undefined;
    const end = state.runEnd(outcome, cause, false);
    const endedBy = cause && state.causeEndedBy(cause);
    this.update(id, (c) => {
      const at = state.ending(c.runs, runId);
      if (at !== undefined) {
        const run = c.runs[at]!;
        delete run.failure;
        if (typeof outcome === "object" && "Completed" in outcome) run.status = "completed";
        else if (outcome === "Interrupted") {
          run.status = "interrupted";
          if (cause) run.failure = state.endedBy(state.causeMessage(cause));
        } else if (typeof outcome === "object" && "Superseded" in outcome) {
          run.status = "interrupted";
          run.supersededBy = outcome.Superseded.by;
        } else {
          run.status = "failed";
          run.failure = { ...(outcome as { Failed: NonNullable<RunInfo["failure"]> }).Failed, retries };
        }
        run.endedAt = c.at;
        if (usage) run.usage = usage as RunInfo["usage"];
        run.end = end;
        if (endedBy && end === "requested") run.endedBy = endedBy;
        else delete run.endedBy;
      }
      if (!c.runs.some((r) => isActive(r.status))) this.#cancelPending(c);
    });
  }

  #exited(id: string, live: Live, exit: state.ExitInfo): void {
    if (this.#live.get(id) !== live) return;
    this.#live.delete(id);
    this.#steers.exited(id, exit.code, (run) => this.#retries.has(run));
    const cause: state.EndCause = live.ending ?? (this.#stopping ? { kind: "node_stopping" } : { kind: "exited", exit });
    // A run the node is retrying outlives an exit nobody asked for: the retry resumes the session.
    const requested = state.asked(cause);
    let closed: string[] = [];
    let lost: { id: string; description?: string; untilMs: number }[] = [];
    try {
      this.update(id, (c) => {
        // The node stopping keeps them for the next node, which wakes the session if one could still fire then.
        if (cause.kind !== "node_stopping") {
          const armed = c.row.local.monitors ?? [];
          delete c.row.local.monitors;
          if (cause.kind === "exited" && !c.runs.some((r) => isActive(r.status)))
            lost = armed.filter((m) => (live.watching.get(m.id) ?? 0) > Date.now());
        }
        const retried = c.runs.some((r) => isActive(r.status) && this.#retries.has(r.id));
        if (requested || !retried) closed = state.closeOut(c.runs, cause, c.at).map((i) => c.runs[i]!.id);
        this.#cancelPending(c);
        if (c.row.local.pid === live.pid) {
          delete c.row.local.pid;
          delete c.row.local.pidStart;
        }
      });
    } catch {}
    for (const run of closed) this.#retries.delete(run);
    live.markExited();
    if (cause.kind === "exited" && lost.length) this.#wakeLost(id, lost, exitWords(cause.exit));
  }

  /** Keeps Live.tools as the session's tool calls start and end. */
  #step(live: Live, item: ThreadItem): void {
    if (item.kind.type !== "command" && item.kind.type !== "file_change" && item.kind.type !== "tool") return;
    if (item.status === "running") live.tools.add(item.id);
    else live.tools.delete(item.id);
  }

  /** A Monitor the agent armed keeps its claude up until its own deadline, and is kept on the session's row, so a
   * claude lost before then wakes the session to say so. */
  #watching(id: string, live: Live, item: ThreadItem): void {
    if (item.kind.type !== "tool" || item.kind.toolName !== "Monitor" || item.status !== "completed") return;
    const input = (item.kind.input ?? {}) as { timeout_ms?: unknown; description?: unknown };
    const ms = typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms) && input.timeout_ms >= 0 ? Math.round(input.timeout_ms) : MONITOR_DEFAULT_MS;
    const untilMs = Date.now() + Math.min(ms, MONITOR_MAX_MS) + MONITOR_GRACE_MS;
    live.watching.set(item.id, untilMs);
    const armed = { id: item.id, ...(typeof input.description === "string" ? { description: input.description } : {}), untilMs };
    this.update(id, (c) => {
      c.row.local.monitors = [...(c.row.local.monitors ?? []).filter((m) => m.id !== armed.id), armed];
    });
  }

  /** Wakes a session whose Monitors were lost with its claude, once, with a message as a lead's goes. */
  #wakeLost(id: string, lost: { description?: string }[], when: string): void {
    console.log(`${nowIso()} INFO a Monitor was lost when ${when}: waking the session {"sessionId":"${id}"}`);
    const runId = `${id}-monitor-lost-${Date.now()}`;
    void this.#beginRun(id, runId, monitorsLost(lost, when), "plain").catch((error) =>
      console.warn(`${nowIso()} WARN cannot wake a session whose Monitor was lost {"sessionId":"${id}","error":${JSON.stringify(String(error))}}`),
    );
  }

  /** Closes the processes idle for idleReapMs; one with a Monitor that may still fire waits for its deadline. */
  #reap(): void {
    const now = Date.now();
    for (const [id, live] of this.#live) {
      if (live.closing || now - live.lastActive < this.#idleReapMs) continue;
      if ([...live.watching.values()].some((until) => until > now)) continue;
      if (this.store.session(id)?.summary.activeRunId) continue;
      console.log(`${nowIso()} INFO reaping an idle claude process {"sessionId":"${id}"}`);
      live.closing = true;
      live.link.send(shutdown(REAP_GRACE_MS));
    }
  }

  /** The setup due before the session's claude next starts: one the node stopped in the middle of, or that failed. */
  #setupDue(id: string): WorktreeSetup | undefined {
    const row = this.store.session(id);
    const lost = !!row?.local.baseRef && !existsSync(row.local.cwd);
    return row && (row.local.setupPending || lost) ? row.local.setup : undefined;
  }

  /** Where a writer's worktree that is gone comes back from; undefined while it is there, or for a session in the
   * root. */
  async #lostWorktree(row: SessionRow): Promise<worktree.Source | undefined> {
    const { baseRef, branch, cwd, workspaceRoot } = row.local;
    if (!baseRef || !branch || existsSync(cwd)) return undefined;
    return worktree.source(workspaceRoot, branch, baseRef);
  }

  /** Brings back a session's worktree that is gone, at the same path, so the session still resumes from what is left
   * of its branch; a reader's detached one at the same commit. Whether it did, and what the agent is told. A rebuilt
   * worktree has none of what setup made: setup runs again before its agent goes on. */
  async #restoreWorktree(id: string, row: SessionRow): Promise<[boolean, string | undefined]> {
    let recreated = false;
    let note: string | undefined;
    const from = await this.#lostWorktree(row);
    if (from && row.local.branch) {
      worktree.restore(row.local.workspaceRoot, row.local.cwd, row.local.branch, from);
      console.log(`${nowIso()} INFO recreated a lost worktree {"sessionId":"${id}","from":"${from.kind}"}`);
      note = worktree.sourceNote(from, row.local.branch);
      row.summary.recreatedFrom = from.kind;
      row.summary.recreatedAt = nowIso();
      row.summary.worktreePath = row.local.cwd;
      row.summary.branch = row.local.branch;
      recreated = true;
    }
    if (row.local.baseRef && !row.local.branch && !existsSync(row.local.cwd)) {
      worktree.ensureDetached(row.local.workspaceRoot, row.local.cwd, row.local.baseRef);
      if (warm.take(this.home, row.local.workspaceRoot, row.local.cwd)) note = warm.WARM_NOTE;
      row.summary.worktreePath = row.local.cwd;
      recreated = true;
    }
    if (recreated) {
      setup.record(row.local.cwd, undefined);
      if (row.local.setup) row.local.setupPending = true;
    }
    return [recreated, note];
  }

  /** Ends the session's running setup (only `runId`'s, when given); what to wait on for it to have ended. */
  #cancelSetup(id: string, runId?: string): Promise<boolean> | undefined {
    const running = this.#setupCancel.get(id);
    if (!running || (runId && runId !== running.runId)) return undefined;
    running.abort.abort();
    return this.#settingUp.get(id);
  }

  /** Runs setup in the background, then sends the recorded run's message; sends that come meanwhile wait for it. */
  #setUpThenSend(id: string, runId: string, text: string, mode: "plain" | "boundary" | "now", plan: WorktreeSetup): void {
    const abort = new AbortController();
    this.#setupCancel.set(id, { runId, abort });
    const done = this.#setUp(id, runId, text, mode, plan, abort.signal).finally(() => {
      this.#settingUp.delete(id);
      this.#setupCancel.delete(id);
    });
    this.#settingUp.set(id, done);
  }

  /** Runs the setup commands, each shown as an item of the run, then sends the run's message with what setup did;
   * true once it went to claude. Setup is due again until it has run to its end. */
  async #setUp(id: string, runId: string, text: string, mode: "plain" | "boundary" | "now", plan: WorktreeSetup, signal: AbortSignal): Promise<boolean> {
    const row = this.store.session(id);
    if (!row) return false;
    // A worktree that is gone comes back first: setup runs in it.
    let rebuilt: string | undefined;
    try {
      const [recreated, note] = await this.#restoreWorktree(id, row);
      if (recreated) {
        const frame = this.store.commit(row, [], true);
        if (frame) this.#machine(frame);
        rebuilt = note;
      }
    } catch (error) {
      this.#failRun(id, runId, "other", (error as Error).message);
      return false;
    }
    const first = this.store.runs(id)[0]?.id === runId;
    const secrets = this.#secrets(row);
    const masker = new Masker(secrets);
    const timeoutSec = setup.timeoutOf(plan);
    const env: Env = { ...gitCommandEnv() };
    const order = row.local.orderId ? orderVarsForSpawn(this.home, row.summary.projectId, row.local.orderId).vars : [];
    const vars = [...projectVars(this.home, row.summary.projectId).filter(([n]) => !order.some(([o]) => o === n)), ...order];
    for (const [k, v] of vars) if (!(k in env) && k !== "OP_SERVICE_ACCOUNT_TOKEN") env[k] = v;
    const scratch = join(this.home, "tmp", scratchName(scratchOwner(row)));
    mkdirPrivate(scratch);
    for (const k of ["TMPDIR", "TMP", "TEMP", "CLAUDE_CODE_TMPDIR"]) env[k] = scratch;
    const commands = plan.commands ?? [];
    const startedAt: string[] = [];
    const item = (i: number, ran: setup.Ran | undefined, cancelled = false) => {
      const at = nowIso();
      const command = masker.text(commands[i] ?? "");
      this.update(id, (c) =>
        this.#putItem(c, {
          id: `setup-${runId}-${i}`,
          runId,
          status: cancelled ? "cancelled" : !ran ? "running" : ran.exitCode === 0 ? "completed" : "failed",
          title: headUtf16(`Setup: ${command}`, 200),
          startedAt: startedAt[i] ?? at,
          ...(ran || cancelled ? { completedAt: at } : {}),
          updatedAt: at,
          kind: {
            type: "command",
            command,
            timeoutMs: timeoutSec * 1000,
            ...(ran ? { output: masker.text(ran.outputTail) } : {}),
            ...(ran?.exitCode !== null && ran?.exitCode !== undefined ? { exitCode: ran.exitCode } : {}),
          },
        }),
      );
    };
    const outcome = await setup.run(
      plan,
      row.local.cwd,
      env,
      secrets.map(([, v]) => v),
      (i) => {
        startedAt[i] = nowIso();
        item(i, undefined);
      },
      (i, ran) => item(i, ran),
      signal,
    );
    // An interrupt or stop ended setup: its command was killed, and setup stays due.
    if (signal.aborted) {
      if (startedAt.length) item(startedAt.length - 1, undefined, true);
      console.log(`${nowIso()} INFO worktree setup stopped: the agent does not start {"sessionId":"${id}"}`);
      return false;
    }
    const why = setup.failure(outcome, timeoutSec);
    if (!plan.runAnyway && why) {
      this.#failRun(id, runId, "other", masker.text(why));
      return false;
    }
    this.update(id, (c) => void delete c.row.local.setupPending);
    const said = setup.note(outcome, timeoutSec, !first);
    let message = text;
    if (said && first) {
      // The brief: what setup did goes after it, and the stored message is what claude is sent.
      message = `${text.trimEnd()}\n\n## Setup\n${masker.text(said)}\n`;
      const stored = this.store.message(id, runId);
      if (stored) this.update(id, (c) => this.#putMessage(c, { ...stored, text: message }));
    } else if (said) message = `${masker.text(said)}\n\n${text}`;
    if (rebuilt) message = `${rebuilt}\n\n${message}`;
    if (!this.store.runs(id).some((r) => r.id === runId && isActive(r.status))) return false;
    try {
      await this.#dispatch(id, { Send: { run_id: runId, text: message, mode } });
      return true;
    } catch (error) {
      this.#failRun(id, runId, "other", (error as Error).message);
      return false;
    }
  }

  /** How many sessions are mid-step: a tool call of theirs runs that the hold didn't stop from starting. */
  midStep(): number {
    let held = new Set<string>();
    try {
      held = new Set(readdirSync(join(this.home, "update", "held")));
    } catch {}
    return [...this.#live.values()].filter((l) => [...l.tools].some((t) => !held.has(t))).length;
  }

  /** claude refused a first start because it already has the session: the message goes again, once, to a respawn. */
  #resendRefused(id: string, live: Live, runId: string): boolean {
    if (this.#retries.has(runId)) return false;
    this.#retries.set(runId, 0);
    live.closing = true;
    this.#resend(id, runId, 0, true);
    return true;
  }

  /** claude refused the model a profile's setting chose: the session goes on on its profile's own model, once, in a
   * new process, and says so (`modelRefused`). */
  #fallBack(id: string, live: Live, runId: string, failure: NonNullable<RunInfo["failure"]>, unread: boolean): boolean {
    const row = this.store.session(id);
    if (!row) return false;
    const refused = (failure.class === "invalid_request" || failure.class === "pool_exhausted") && failure.model === row.summary.model;
    if (!refused || !row.local.profile) return false;
    const own = claude.profileModel(row.local.profile);
    if (row.summary.model === own.model || this.#retries.has(runId)) return false;
    this.#retries.set(runId, 0);
    live.closing = true;
    console.warn(`${nowIso()} WARN claude refused the model; the session runs on ${own.model} instead {"sessionId":"${id}","model":"${row.summary.model}"}`);
    this.update(id, (c) => {
      c.row.summary.modelRefused = c.row.summary.model;
      c.row.summary.model = own.model;
    });
    live.link.send(shutdown(10_000));
    this.#scheduleRetry(id, runId, 1, 0, failure, unread);
    return true;
  }

  /** The run stays active while the node waits, with a `node_retry` item saying why it is slow. */
  #scheduleRetry(id: string, runId: string, attempt: number, delayMs: number, failure: NonNullable<RunInfo["failure"]>, unread: boolean): void {
    this.update(id, (c) =>
      this.#putItem(c, {
        id: `node-retry-${runId}-${attempt}`,
        runId,
        status: "completed",
        title: "Node retry",
        startedAt: c.at,
        completedAt: c.at,
        updatedAt: c.at,
        kind: { type: "node_retry", attempt, of: this.#retrySchedule.length, delayMs, reason: failure },
      }),
    );
    this.#resend(id, runId, delayMs, unread);
  }

  /** After `delayMs`, unless the run ended meanwhile, the session gets the run's message again (`unread`) or
   * RETRY_MESSAGE, under a fresh uuid that maps back to the run. */
  #resend(id: string, runId: string, delayMs: number, unread: boolean): void {
    setTimeout(async () => {
      if (!this.store.runs(id).some((r) => r.id === runId && isActive(r.status))) {
        if (unread) this.#steers.failed(runId, "the run ended before claude took it in");
        return;
      }
      const text = unread ? this.store.message(id, runId)?.text : RETRY_MESSAGE;
      try {
        if (text === undefined) throw notFound(`run ${runId} has no message`);
        const uuid = crypto.randomUUID();
        await this.#dispatch(id, { Send: { run_id: uuid, text, mode: "plain" } }, [uuid, runId]);
      } catch (error) {
        this.#retries.delete(runId);
        this.#failRun(id, runId, "other", (error as Error).message);
        if (unread) this.#steers.failed(runId, (error as Error).message);
      }
    }, delayMs);
  }

  /** Drops a send claude still holds queued; a no-op once it has started. Waits up to WITHDRAW_WAIT_MS for claude. */
  async #withdraw(id: string, runId: string): Promise<SessionOutput> {
    this.#session(id);
    const queued = this.store.runs(id).some((r) => r.id === runId && r.status === "queued");
    const live = this.#live.get(id);
    if (!live || !queued) return { kind: "withdrawn", cancelled: false };
    const answered = new Promise<boolean>((resolve) => this.#withdrawWaiters.set(runId, resolve));
    const cancelled = live.link.send({ Withdraw: { run_id: runId } })
      ? await Promise.race([answered, Bun.sleep(WITHDRAW_WAIT_MS).then(() => false)])
      : false;
    this.#withdrawWaiters.delete(runId);
    return { kind: "withdrawn", cancelled };
  }

  async #interrupt(id: string, runId: string | undefined, reason: string | undefined): Promise<SessionOutput> {
    this.#session(id);
    const active = this.store.runs(id).find((r) => isActive(r.status));
    if (!active || (runId && runId !== active.id)) return { kind: "done" };
    const why = reason?.trim() ? reason : "interrupted";
    // A run still in its worktree's setup: the setup ends, its command killed, and no claude starts for it.
    const settingUp = this.#cancelSetup(id, active.id);
    const live = this.#live.get(id);
    if (!live) {
      this.update(id, (c) => {
        state.closeOut(c.runs, { kind: "requested", why }, c.at);
        this.#cancelPending(c);
      });
      if (settingUp) await Promise.race([settingUp, Bun.sleep(EXIT_WAIT_MS)]);
      return { kind: "done" };
    }
    live.ending = { kind: "requested", why };
    live.link.send("Interrupt");
    setTimeout(() => {
      const still = this.store.runs(id).some((r) => r.id === active.id && isActive(r.status));
      if (still && this.#live.get(id) === live) {
        live.closing = true;
        live.link.send(shutdown(0));
      }
    }, INTERRUPT_GRACE_MS);
    return { kind: "done" };
  }

  async #stop(id: string, removeWorktree: boolean, why = "stopped"): Promise<SessionOutput> {
    // A run still in its worktree's setup ends with it: its command is killed and no claude starts.
    const settingUp = this.#cancelSetup(id);
    if (settingUp) {
      this.update(id, (c) => {
        state.closeOut(c.runs, { kind: "requested", why }, c.at);
        this.#cancelPending(c);
      });
      await Promise.race([settingUp, Bun.sleep(EXIT_WAIT_MS)]);
    }
    if (removeWorktree && this.store.runs(id).some((r) => isActive(r.status))) return { kind: "done" };
    const row = this.#session(id);
    const live = this.#live.get(id);
    if (live) {
      live.ending = { kind: "requested", why };
      live.closing = true;
      live.link.send(shutdown(STOP_GRACE_MS));
      const exited = await Promise.race([live.exited.then(() => true), Bun.sleep(EXIT_WAIT_MS).then(() => false)]);
      if (!exited) {
        try {
          process.kill(-live.pid, "SIGKILL");
        } catch {}
        await Promise.race([live.exited, Bun.sleep(5_000)]);
      }
    }
    // A session's scratch goes with its worktree, or with its process when it has none.
    if (removeWorktree || !row.local.baseRef) rmSync(join(this.home, "tmp", scratchName(scratchOwner(row))), { recursive: true, force: true });
    if (removeWorktree && row.local.baseRef) {
      const deleted = row.local.branch
        ? worktree.remove(row.local.workspaceRoot, row.local.cwd, row.local.branch, row.local.baseRef)
        : // Its build goes on to the next reader of the checkout.
          (warm.give(this.home, row.local.workspaceRoot, row.local.cwd, warm.keep(this.home)),
          worktree.removeDetached(row.local.workspaceRoot, row.local.cwd),
          false);
      this.update(id, (c) => {
        delete c.row.summary.worktreePath;
        if (deleted) delete c.row.summary.branch;
      });
    }
    return { kind: "done" };
  }

  async #answer(id: string, requestId: string, decision: unknown, by: string | undefined): Promise<SessionOutput> {
    const row = this.#session(id);
    if (row.summary.pendingPermission?.requestId !== requestId) throw notFound(`no permission request ${requestId} is waiting in session ${id}`);
    const live = this.#live.get(id);
    if (!live || !live.link.send({ Answer: { request_id: requestId, decision, by: by ?? null } })) throw notFound("the run that asked has ended");
    this.update(id, (c) => {
      const item = this.store.item(id, permissionItemId(requestId));
      if (item && item.kind.type === "permission") {
        this.#putItem(c, { ...item, kind: { ...item.kind, decision: decision as never }, status: "completed", completedAt: c.at, updatedAt: c.at });
      }
      this.#nextPrompt(c);
    });
    return { kind: "done" };
  }

  #subscribe(after: number | undefined, spansAfter: number | undefined, caughtUp: boolean): SessionOutput {
    this.#subscribed = true;
    const replay = after === undefined || after === null ? undefined : this.store.eventsAfter(after);
    if (replay) for (const f of replay) this.#machine(f);
    else
      this.#machine({
        seq: this.store.latestSeq(),
        at: nowIso(),
        event: { type: "snapshot", projects: this.store.projects(), sessions: this.store.sessions().map((r) => r.summary) },
      });
    if (caughtUp) this.#machine({ seq: this.store.latestSeq(), at: nowIso(), event: { type: "caught_up" } });
    if (spansAfter !== undefined && spansAfter !== null) {
      // A cursor past every row this outbox ever had is from a reset database: send all of it.
      this.#spans = { enabled: true, sent: spansAfter > this.store.spansHead() ? 0 : spansAfter };
      this.#flushSpans();
    }
    return { kind: "done" };
  }

  #flushSpans(): void {
    if (!this.#spans.enabled || !this.#outlet) return;
    for (;;) {
      const rows = this.store.spansAfter(this.#spans.sent, SPANS_PER_FRAME);
      if (!rows.length) return;
      const fromRid = rows[0]![0];
      const toRid = rows[rows.length - 1]![0];
      this.#outlet({ t: "spans", fromRid, toRid, spans: rows.map(([, s]) => s) });
      this.#spans.sent = toRid;
    }
  }

  /** `spans_ack`: the hub stored every row up to `upto`; with `rewind`, send again from it. */
  spansAcked(upto: number, rewind: boolean): void {
    this.store.spansAcked(upto);
    if (rewind) {
      this.#spans.sent = upto;
      this.#flushSpans();
    }
  }

  #snapshot(id: string) {
    const row = this.#session(id);
    const [messages, olderMessages] = this.store.newestMessages(id, SNAPSHOT_WINDOW);
    const [items, olderItems] = this.store.newestItems(id, SNAPSHOT_WINDOW);
    return { summary: row.summary, messages, items: items.map(state.bounded), runs: this.store.runs(id), truncated: olderMessages || olderItems };
  }

  /** The runner's state, probed once and again when asked while it can't run sessions. */
  async runnerInfo(): Promise<RunnerInfo> {
    if (this.#runner && this.#runner.login === "logged_in" && this.#runner.conformanceOk) return this.#runner;
    return this.reprobe();
  }

  async reprobe(): Promise<RunnerInfo> {
    const info = await claude.probe(this.config.claudeBin, runnerEnv(this.config));
    // No session host: claude may be fine, but no session starts here. Both hubs read a logged-in runner as able to
    // take sessions whatever its problem says (runner_problem), so its login goes out as unknown: the hub shows the
    // machine degraded with this problem, and places no task here.
    if (!this.config.nativeBin) {
      info.problem = info.problem ? `${NO_HELPER}. ${info.problem}` : NO_HELPER;
      info.login = "unknown";
    }
    const changed = JSON.stringify(info) !== JSON.stringify(this.#runner);
    this.#runner = info;
    if (changed) this.#machine(this.store.appendEvent({ type: "runner_info", ...info }));
    return info;
  }

  /** The machine just woke. A run whose claude has said nothing since, and waits on no tool and no person, lost its
   * stream with the network: after WAKE_GRACE_MS it is interrupted and retried like a network failure. */
  woke(graceMs = WAKE_GRACE_MS): void {
    const since = Date.now();
    setTimeout(() => this.#recoverAfterSleep(since), graceMs);
  }

  #recoverAfterSleep(since: number): void {
    for (const [id, live] of this.#live) {
      if (live.closing || live.lastActive >= since) continue;
      const row = this.store.session(id);
      const run = row?.summary.activeRunId;
      if (!run || row.summary.pendingPermission) continue;
      if (this.store.newestItems(id, 20)[0].some((i) => i.status === "running")) continue;
      console.log(`${nowIso()} INFO claude said nothing since the machine woke; interrupting it to resume the run {"sessionId":"${id}"}`);
      live.slept = run;
      live.link.send("Interrupt");
      setTimeout(() => {
        if (this.#live.get(id) !== live || live.slept === undefined) return;
        live.closing = true;
        live.link.send(shutdown(0));
      }, INTERRUPT_GRACE_MS);
    }
  }

  /** Holds every agent's tool call that hasn't started yet (node/hold.rs); how many sessions are mid-step. */
  hold(): number {
    const path = join(this.home, "update", "hold");
    mkdirSync(join(this.home, "update", "held"), { recursive: true });
    writeAtomic(path, String(Date.now() + 60_000));
    return this.midStep();
  }

  /** The node stops: every host is let go of (its session runs on, and the next node re-adopts it). */
  async shutdown(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#reaper);
    clearInterval(this.#warmPruner);
    await Promise.all([...this.#live.values()].map((live) => live.link.detach()));
    this.#live.clear();
    this.store.close();
  }

  /** Ends every session for good (tests, `machine remove`): each host is stopped with its claude. */
  async stopAll(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#reaper);
    clearInterval(this.#warmPruner);
    for (const id of [...this.#live.keys()]) await stopHost(join(this.home, "hosts", id));
  }
}
