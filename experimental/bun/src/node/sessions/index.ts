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
  nativeBin: string;
  boxKey?: NodeBoxKey;
};

const expandHome = (dir: string) => (dir === "~" ? homeDir() : dir.startsWith("~/") ? join(homeDir(), dir.slice(2)) : dir);

/** The node's session config, as the Rust node's `SessionConfig::for_node`. */
export function configFor(home: string, fleetdDirPath: string, nativeBin: string, boxKey?: NodeBoxKey): SessionConfig {
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
    ...(boxKey ? { boxKey } : {}),
  };
}

/** What every claude the node starts gets: the base environment, `claude.env`, defaults, fleetd's own values. */
export function runnerEnv(config: SessionConfig): Env {
  const env: Env = { ...config.baseEnv };
  try {
    const extra = parseEnvFile(readFileSync(config.claudeEnv, "utf8"));
    if (extra.some(([k]) => k === "ANTHROPIC_BASE_URL")) env[claude.FLEETD_ENV_SOURCE] = config.claudeEnv;
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
    }
    await sweep(hosts, adopted);
    return service;
  }

  #adopt(row: SessionRow, link: HostLink): void {
    const id = row.summary.sessionId;
    const live = this.#newLive(link, this.#secrets(row));
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
    return { generation: ++this.#generation, pid: link.pid, link, lastActive: Date.now(), closing: false, exited, markExited, secrets };
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
        const queued = await this.#beginRun(c.sessionId, c.runId, c.text, c.mode ?? "plain");
        return { kind: "sent", runId: c.runId, queued };
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
    let base: worktree.Base | undefined;
    if (ws.type !== "root") base = await worktree.freshBase(root, ws.baseRef);
    // A retry that arrived while this one fetched.
    const raced = this.store.session(id);
    if (raced) return { kind: "launched", summary: raced.summary };
    const path = join(this.#worktreesDir(launch.projectId), id);
    let cwd = root;
    let addDirs: string[] = [];
    let baseRef: string | undefined;
    let branch: string | undefined;
    if (ws.type === "worktree" && base) {
      worktree.ensure(root, path, ws.branch, base.sha);
      [cwd, addDirs, baseRef, branch] = [path, [root], base.baseRef, ws.branch];
    } else if (ws.type === "detached" && base) {
      const sha = (ws.head && worktree.knownCommit(root, ws.head)) || base.sha;
      worktree.ensureDetached(root, path, sha);
      [cwd, addDirs, baseRef] = [path, [root], sha];
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
      },
    };
    this.store.commit(row, [], false);
    const dir = join(this.home, "sessions", id);
    if (launch.mcpRole && launch.mcp) this.#keepMcp(id, { role: launch.mcpRole, config: launch.mcp });
    try {
      skills.keepSkills(dir, launch.skills ?? []);
    } catch (error) {
      throw new Refusal("internal", `cannot keep the session's skills: ${(error as Error).message}`);
    }
    await this.#beginRun(id, launch.runId, launch.prompt, "plain");
    const reported = base && { ref: base.baseRef, sha: base.sha, ...(base.fetchedAt ? { fetchedAt: base.fetchedAt } : {}), ...(base.error ? { error: base.error } : {}) };
    return { kind: "launched", summary: this.#session(id).summary, ...(reported ? { base: reported } : {}) };
  }

  /** Records a run and its user message, then hands it to the session's process. Whether it waits behind an active
   * run. Idempotent on `runId`. */
  async #beginRun(id: string, runId: string, text: string, mode: "plain" | "boundary" | "now"): Promise<boolean> {
    const recorded = this.update(id, (c): { again: boolean } | { queued: boolean } => {
      const known = c.runs.find((r) => r.id === runId);
      if (known) return { again: known.status === "queued" };
      const queued = c.runs.some((r) => isActive(r.status));
      c.runs.push({ id: runId, status: queued ? "queued" : "starting", ordinal: c.runs.length + 1, queuedAt: c.at });
      this.#putMessage(c, { id: runId, runId, role: "user", text, createdAt: c.at });
      return { queued };
    });
    if ("again" in recorded) return recorded.again;
    try {
      await this.#dispatch(id, { Send: { run_id: runId, text, mode } });
    } catch (error) {
      const message = error instanceof Refusal ? error.message : (error as Error).message;
      this.#failRun(id, runId, "other", message);
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

  async #dispatch(id: string, command: SessionCommand): Promise<void> {
    const live = await this.#ensureLive(id);
    live.lastActive = Date.now();
    if (!live.link.send(command)) throw new Refusal("internal", "the session's claude process ended");
  }

  /** The live process, spawning (first start) or resuming the session when there is none. One spawn per session at a
   * time, so two sends never start two processes. */
  #ensureLive(id: string): Promise<Live> {
    const prior = this.#spawning.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.#spawn(id));
    this.#spawning.set(id, next);
    return next;
  }

  async #spawn(id: string): Promise<Live> {
    const current = this.#live.get(id);
    if (current && !current.closing) return current;
    if (current) await Promise.race([current.exited, Bun.sleep(EXIT_WAIT_MS)]);
    if (this.#stopping) throw new Refusal("runner_unavailable", "the node is stopping");
    const row = this.#session(id);
    const env = runnerEnv(this.config);
    let resume: boolean;
    try {
      resume = state.startMode(row.local, claude.configDir(env), id);
    } catch (error) {
      throw new Refusal("runner_unavailable", (error as Error).message);
    }
    if (!existsSync(row.local.cwd)) throw invalid(`the session's workspace ${row.local.cwd} is missing`);
    const spec = this.#spec(row, resume, env);
    const file = claude.sessionFile(claude.configDir(spec.env), spec.cwd, id);
    if (file) spec.resume = existsSync(file);
    const mark = marker(id);
    let link: HostLink;
    try {
      link = await launchHost({
        exe: this.config.nativeBin,
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
    return live;
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
    const sessionMcp = mcp.sessionConfig(this.home, mcp.kept(dir), fleetdServer(this.config.nativeBin, role, sock, id), id);
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
    Bun.write(settings, settingsOverlay(roleVars, skills.overrides(prepared), helperModel, ask, !!row.local.fast, claude.heavyLspOn(env), holdHook(this.config.nativeBin, this.home)));
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
    const scratch = join(this.home, "tmp", scratchName(id));
    mkdirPrivate(scratch);
    for (const k of ["TMPDIR", "TMP", "TEMP", "CLAUDE_CODE_TMPDIR"]) env[k] = scratch;
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
      pluginDirs: prepared.pluginDir ? [prepared.pluginDir] : [],
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
            const started = body.run_id as string;
            runId = started;
            masker = new Masker(this.#secrets(this.#session(id)));
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
              const run = c.runs.find((r) => r.id === body.run_id);
              if (run && (run.status === "queued" || run.status === "starting")) {
                run.status = "running";
                run.startedAt ??= c.at;
              }
            });
            break;
          case "AssistantText":
            if (delta?.messageId === body.message_id) delta = undefined;
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
            } else this.update(id, (c) => this.#putItem(c, item));
            break;
          }
          case "Compacting":
            this.update(id, (c) => void (c.announce = true));
            break;
          case "PermissionRequest":
            this.#permission(id, live, body.request_id, body.tool_name, body.input, body.summary, runId);
            break;
          case "RunEnded":
            this.#runEnded(id, live, body.run_id, body.outcome, body.usage);
            break;
          case "Usage":
            if (this.#followed.has(id)) this.#thread(id, { type: "usage", runId: body.run_id, usage: body.usage });
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
          case "Withdrawn":
            this.#withdrawWaiters.get(body.run_id)?.(!!body.cancelled);
            this.#withdrawWaiters.delete(body.run_id);
            break;
          default:
            // Init, Queued, Seen, SendNow, WatchEnded: steer receipts and monitors aren't ported.
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
          run.failure = { ...(outcome as { Failed: RunInfo["failure"] }).Failed!, retries: 0 };
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
    const cause: state.EndCause = live.ending ?? (this.#stopping ? { kind: "node_stopping" } : { kind: "exited", exit });
    try {
      this.update(id, (c) => {
        state.closeOut(c.runs, cause, c.at);
        this.#cancelPending(c);
        if (c.row.local.pid === live.pid) {
          delete c.row.local.pid;
          delete c.row.local.pidStart;
        }
      });
    } catch {}
    live.markExited();
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
    const live = this.#live.get(id);
    if (!live) {
      this.update(id, (c) => {
        state.closeOut(c.runs, { kind: "requested", why }, c.at);
        this.#cancelPending(c);
      });
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
    if (removeWorktree || !row.local.baseRef) rmSync(join(this.home, "tmp", scratchName(id)), { recursive: true, force: true });
    if (removeWorktree && row.local.baseRef) {
      const deleted = row.local.branch
        ? worktree.remove(row.local.workspaceRoot, row.local.cwd, row.local.branch, row.local.baseRef)
        : (worktree.removeDetached(row.local.workspaceRoot, row.local.cwd), false);
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
    const changed = JSON.stringify(info) !== JSON.stringify(this.#runner);
    this.#runner = info;
    if (changed) this.#machine(this.store.appendEvent({ type: "runner_info", ...info }));
    return info;
  }

  /** Holds every agent's tool call that hasn't started yet (node/hold.rs); how many sessions are mid-step. */
  hold(): number {
    const path = join(this.home, "update", "hold");
    mkdirSync(join(this.home, "update", "held"), { recursive: true });
    writeAtomic(path, String(Date.now() + 60_000));
    return [...this.#live.keys()].filter((id) => this.store.runs(id).some((r) => isActive(r.status))).length;
  }

  /** The node stops: every host is let go of (its session runs on, and the next node re-adopts it). */
  async shutdown(): Promise<void> {
    this.#stopping = true;
    await Promise.all([...this.#live.values()].map((live) => live.link.detach()));
    this.#live.clear();
    this.store.close();
  }

  /** Ends every session for good (tests, `machine remove`): each host is stopped with its claude. */
  async stopAll(): Promise<void> {
    this.#stopping = true;
    for (const id of [...this.#live.keys()]) await stopHost(join(this.home, "hosts", id));
  }
}
