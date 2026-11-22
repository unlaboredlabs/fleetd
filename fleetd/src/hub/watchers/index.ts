// Watchers: automations with a `watch` (D: watchers watch the person's software, never fleetd's own machinery). A
// watcher's run opens no order: the hub reads a preset's evidence itself (Main's CI: the checks on the default branch
// of the bot's GitHub repo; Deploys: its GitHub deployments' statuses) and gives it to a session with no tools, or, for
// "Something else", gives the person's sentence to a session holding only WebFetch, WebSearch and the bot's
// connections' read tools. The session answers OK, which posts nothing, or one line, which goes in the bot's chat as
// "<name>: <line>". A look at the same evidence as the last one starts no session. Each run keeps what its session
// cost, so a watcher's row shows its last day, and its first day ends with one line saying what it cost.
//
// The schedule, Run now, pause and the run history are the automation's (hub/automations); this area starts and ends
// the runs' sessions. A session still going after RUN_LIMIT_MS is stopped and its run failed.
import type { Automation, AutomationRun, HubEvent, KnownWatchKind, ProjectRef, ThreadRef, WatchKind } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { chat } from "../chat/index.ts";
import { forLead, isRefusal } from "../claude_accounts/index.ts";
import { executors } from "../executor/index.ts";
import { launch, type LaunchInput, type LaunchOptions } from "../executor/sessions.ts";
import { stop } from "../executor/stop.ts";
import { launchRules } from "../integrations/policy.ts";
import { mcpServers } from "../mcp_servers/index.ts";
import { ended, nodeAccounts } from "../memory/refresh.ts";
import { profiles } from "../projects/profiles.ts";
import * as repos from "../repos/store.ts";
import { events } from "../store/events.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { systemGh } from "../train/gh.ts";
import { latest, TrainGitHub, type CheckRun } from "../train/github.ts";
import { fresh } from "../train/seams.ts";
import { storedRun, why } from "../automations/model.ts";
import {
  DAY_MS,
  type Deployment,
  deploys,
  type Evidence,
  firstDayLine,
  mainCi,
  message,
  PRESETS,
  RUN_LIMIT_MS,
  usage,
  verdict,
} from "./rules.ts";

export * from "./rules.ts";

/** How long a repo's "has deployments" answer is kept. */
const DEPLOYS_FRESH_MS = 30 * 60_000;
/** A run recorded as running with no session this long after it opened lost its start to a hub stop. */
const START_LOST_MS = 2 * 60_000;
const SWEEP_MS = 60_000;
const END_EVENTS = new Set(["thread.completed", "thread.failed", "thread.interrupted", "thread.usage_limited"]);
/** The runtime's read tools an "other" watcher always has. */
const WEB_TOOLS = ["WebFetch", "WebSearch"];

type GitHubGet = (path: string) => Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }>;

/** What a watcher reaches outside the hub's database: sessions, their answer and cost, and GitHub. Tests set their own. */
export type WatcherPorts = {
  /** The session's thread id; throws with why it didn't start. */
  launch(machineId: string, input: LaunchInput, options: LaunchOptions): Promise<string>;
  stop(thread: ThreadRef): Promise<void>;
  /** The session's last assistant message, whole. */
  text(thread: ThreadRef): Promise<string | undefined>;
  /** What the session's runs cost, in US dollars; undefined when its runner said nothing. */
  cost(thread: ThreadRef): Promise<number | undefined>;
  github: GitHubGet;
};

function hubPorts(hub: Hub): WatcherPorts {
  const github = new TrainGitHub(systemGh, fresh(hub), () => hub.clock.now(), Bun.sleep);
  return {
    launch: async (m, input, options) => (await launch(hub, m, input, options)).threadId,
    stop: (thread) => stop(hub, thread),
    text: (thread) => executors(hub).views.latestText(thread),
    cost: async (thread) => {
      const runs = await executors(hub).views.runs(thread);
      const costs = runs.map((r) => r.usage?.costUsd).filter((c): c is number => typeof c === "number");
      return costs.length === 0 ? undefined : costs.reduce((a, b) => a + b, 0);
    },
    github: (path) => github.get(path),
  };
}

type RunRow = { data: string; thread_id: string | null; started_ms: number | null; seen: string | null; automation: string };

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const hash = (key: string) => new Bun.CryptoHasher("sha256").update(key).digest("hex");

export class Watchers {
  /** Per GitHub repo: whether it has deployments, and when that was read. */
  private readonly deployments = new Map<string, { at: number; has: boolean }>();
  private ports: WatcherPorts | undefined;
  private started = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly hub: Hub) {}

  /** The ports in use: the hub's, unless a test set its own. */
  get port(): WatcherPorts {
    this.ports ??= hubPorts(this.hub);
    return this.ports;
  }

  set port(p: WatcherPorts) {
    this.ports = p;
  }

  private now(): number {
    return this.hub.clock.now();
  }

  // ---- what a bot can watch --------------------------------------------------------------------------------------

  /** The bot's GitHub repo: its own first, then the others it holds; with the branch its work lands on, if known. */
  repoOf(r: ProjectRef): { repo: string; base?: string } | undefined {
    const all = repos.of(this.hub.db.conn, r);
    const own = repos.own(this.hub.db.conn, r);
    for (const x of own ? [own, ...all] : all) {
      const key = x.repoKey;
      if (key?.startsWith("github.com/")) return { repo: key.slice("github.com/".length), ...(x.base ? { base: x.base } : {}) };
    }
    return undefined;
  }

  /** The presets the bot can have now, and `other`: Main's CI with a GitHub repo, Deploys once that repo has deployments. */
  async watchable(r: ProjectRef): Promise<WatchKind[]> {
    const gh = this.repoOf(r);
    if (!gh) return ["other"];
    const out: KnownWatchKind[] = ["main_ci"];
    if (await this.hasDeployments(gh.repo)) out.push("deploys");
    out.push("other");
    return out;
  }

  private async hasDeployments(repo: string): Promise<boolean> {
    const known = this.deployments.get(repo);
    if (known && this.now() - known.at < DEPLOYS_FRESH_MS) return known.has;
    let has = known?.has ?? false;
    try {
      const got = await this.port.github(`repos/${repo}/deployments?per_page=1`);
      if (got.ok) has = Array.isArray(got.value) && got.value.length > 0;
    } catch {}
    this.deployments.set(repo, { at: this.now(), has });
    return has;
  }

  // ---- evidence --------------------------------------------------------------------------------------------------

  /** A preset's evidence, read from GitHub now; why it couldn't be. */
  async evidence(a: Automation): Promise<Evidence | { error: string }> {
    const gh = this.repoOf(a.projectRef);
    if (!gh) return { error: "The bot has no GitHub repo to look at." };
    const get = async (path: string): Promise<unknown> => {
      const got = await this.port.github(path);
      if (!got.ok) throw new Error(`GitHub answered ${got.status} for ${path.split("?")[0]}: ${got.message}`);
      return got.value;
    };
    const now = this.now();
    try {
      if (a.watch?.kind === "main_ci") {
        const branch = gh.base ?? str(((await get(`repos/${gh.repo}`)) as { default_branch?: unknown }).default_branch) ?? "main";
        const commit = (await get(`repos/${gh.repo}/commits/${encodeURIComponent(branch)}`)) as {
          sha?: unknown;
          commit?: { message?: unknown; committer?: { date?: unknown } };
        };
        const sha = str(commit.sha);
        if (sha === undefined) return { error: `GitHub gave no head for ${gh.repo} ${branch}.` };
        const runs = (await get(`repos/${gh.repo}/commits/${sha}/check-runs?per_page=100`)) as { check_runs?: CheckRun[] };
        const status = (await get(`repos/${gh.repo}/commits/${sha}/status`)) as { statuses?: { context: string; state: string; target_url?: string | null }[] };
        const checks = latest(Array.isArray(runs.check_runs) ? runs.check_runs : []).map((c) => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          startedAt: c.started_at,
          completedAt: c.completed_at,
          url: c.html_url,
        }));
        const statuses = (Array.isArray(status.statuses) ? status.statuses : []).map((s) => ({ context: s.context, state: s.state, url: s.target_url }));
        const at = str(commit.commit?.committer?.date);
        const said = str(commit.commit?.message)?.split("\n")[0];
        return mainCi(gh.repo, branch, { sha, ...(at ? { at } : {}), ...(said ? { message: said } : {}) }, checks, statuses, now);
      }
      const list = (await get(`repos/${gh.repo}/deployments?per_page=50`)) as { id: number; environment: string; ref?: string; sha?: string; created_at?: string }[];
      const newest = new Map<string, Deployment>();
      for (const d of Array.isArray(list) ? list : []) {
        if (newest.has(d.environment) || newest.size >= 8) continue;
        newest.set(d.environment, { id: d.id, environment: d.environment, ...(d.ref ? { ref: d.ref } : {}), ...(d.sha ? { sha: d.sha } : {}), ...(d.created_at ? { createdAt: d.created_at } : {}) });
      }
      for (const d of newest.values()) {
        const statuses = (await get(`repos/${gh.repo}/deployments/${d.id}/statuses?per_page=1`)) as {
          state?: string;
          created_at?: string;
          description?: string;
          log_url?: string;
          environment_url?: string;
        }[];
        const s = Array.isArray(statuses) ? statuses[0] : undefined;
        if (!s) continue;
        if (s.state) d.state = s.state;
        if (s.created_at) d.stateAt = s.created_at;
        if (s.description) d.description = s.description;
        const url = s.log_url || s.environment_url;
        if (url) d.url = url;
      }
      return deploys(gh.repo, [...newest.values()], now);
    } catch (error) {
      return { error: `GitHub couldn't be read: ${(error as Error).message}` };
    }
  }

  // ---- runs ------------------------------------------------------------------------------------------------------

  private rowOf(runId: string): RunRow | undefined {
    return this.hub.db.all<RunRow>(
      "SELECT data, thread_id, started_ms, seen, automation_id AS automation FROM automation_runs WHERE run_id = ?",
      [runId],
    )[0];
  }

  private automation(id: string): Automation | undefined {
    const data = this.hub.db.all<{ data: string }>("SELECT data FROM automations WHERE automation_id = ?", [id])[0]?.data;
    return data === undefined ? undefined : (JSON.parse(data) as Automation);
  }

  private save(run: AutomationRun, cols: { thread?: string | null; startedMs?: number | null; seen?: string | null } = {}): AutomationRun {
    const out = storedRun(run);
    const sets = ["state = ?", "data = ?"];
    const params: (string | number | null)[] = [out.state, JSON.stringify(out)];
    if (cols.thread !== undefined) (sets.push("thread_id = ?"), params.push(cols.thread));
    if (cols.startedMs !== undefined) (sets.push("started_ms = ?"), params.push(cols.startedMs));
    if (cols.seen !== undefined) (sets.push("seen = ?"), params.push(cols.seen));
    this.hub.db.conn.query(`UPDATE automation_runs SET ${sets.join(", ")} WHERE run_id = ?`).run(...params, out.runId);
    return out;
  }

  private end(run: AutomationRun, state: "done" | "failed", extra: { why?: string; said?: string; costUsd?: number }): AutomationRun {
    const out: AutomationRun = { ...run, state, endedAt: isoMs(this.now()) };
    if (extra.why !== undefined) out.why = why(extra.why);
    if (extra.said !== undefined) out.said = extra.said;
    if (extra.costUsd !== undefined) out.costUsd = Math.round(extra.costUsd * 10_000) / 10_000;
    return this.save(out);
  }

  /** The `seen` of the watcher's last look that finished (spoke or not), other than `runId`. */
  private lastSeen(automationId: string, runId: string): string | undefined {
    return (
      this.hub.db.all<{ seen: string }>(
        `SELECT seen FROM automation_runs WHERE automation_id = ? AND run_id != ? AND seen IS NOT NULL AND state = 'done'
         ORDER BY at_ms DESC, rowid DESC LIMIT 1`,
        [automationId, runId],
      )[0]?.seen ?? undefined
    );
  }

  /**
   * Starts a watcher's run, opened running with no order (`Automations.open`): its evidence read, then either nothing
   * new to look at (done, quiet) or its session launched. A run that can't start fails, saying why; it posts nothing.
   */
  async look(a: Automation, run: AutomationRun): Promise<AutomationRun> {
    const w = a.watch;
    if (!w) return run;
    const r = a.projectRef;
    let evidence: Evidence | undefined;
    if (PRESETS.includes(w.kind as KnownWatchKind)) {
      const got = await this.evidence(a);
      if ("error" in got) return this.end(run, "failed", { why: got.error });
      evidence = got;
      const seen = hash(`${w.kind}\n${got.key}`);
      if (this.lastSeen(a.automationId, run.runId) === seen) {
        const out = this.end(run, "done", { why: "Nothing changed since its last look.", costUsd: 0 });
        this.save(out, { seen });
        this.firstDay(a, out);
        return out;
      }
      this.save(run, { seen });
    }
    let tools: string[] = [];
    let options: LaunchOptions;
    if (evidence !== undefined) {
      options = { role: "plain", mcp: { userServers: false, servers: [] }, onlyTools: [] };
    } else {
      // Only the tools the person marked as reading on a connection with a named integration: a plain server's are unknown.
      tools = launchRules(mcpServers(this.hub).serversFor(r).filter((s) => s.integration !== undefined)).allowed.filter((t) =>
        /^mcp__.+__.+/.test(t),
      );
      options = { role: "plain", mcp: mcpServers(this.hub).sessionConfig(r), onlyTools: [...WEB_TOOLS, ...tools] };
    }
    const account = forLead(this.hub.db, (m) => nodeAccounts(this.hub, m), r);
    if (isRefusal(account)) return this.end(run, "failed", { why: account.message });
    if (account !== undefined) options.claudeAccount = account;
    const ps = profiles(this.hub);
    let profile = "legacy";
    try {
      profile = w.profile !== undefined && ps.allowed(r).includes(w.profile) ? w.profile : ps.defaultProfile().name;
    } catch {}
    const input: LaunchInput = {
      projectId: r.projectId,
      prompt: message(w, a.prompt, evidence, tools),
      profile,
      // Its node refuses any tool not in onlyTools.
      runtimeMode: "approval-required",
      title: [...`fleetd watcher: ${a.name}`].slice(0, 80).join(""),
      clientRequestId: `fleetd-watch:${run.runId}`,
    };
    let threadId: string;
    try {
      threadId = await this.port.launch(r.machineId, input, options);
    } catch (error) {
      return this.end(run, "failed", { why: `Its look didn't start: ${(error as Error).message}` });
    }
    return this.save(run, { thread: threadId, startedMs: this.now() });
  }

  /** `look`, after the follow-ups queued before it: a schedule or Run now doesn't wait for GitHub or the launch. */
  later(a: Automation, run: AutomationRun): void {
    void this.then("a look's start", () => this.look(a, run));
  }

  /** The running watcher run in `thread`, if any. */
  private runIn(thread: ThreadRef): { run: AutomationRun; a: Automation; startedMs: number } | undefined {
    const row = this.hub.db.all<RunRow>(
      `SELECT r.data, r.thread_id, r.started_ms, r.seen, r.automation_id AS automation FROM automation_runs r
         JOIN automations a ON a.automation_id = r.automation_id
       WHERE r.thread_id = ? AND r.state = 'running' AND a.machine_id = ?`,
      [thread.threadId, thread.machineId],
    )[0];
    if (!row) return undefined;
    const a = this.automation(row.automation);
    return a ? { run: JSON.parse(row.data) as AutomationRun, a, startedMs: row.started_ms ?? 0 } : undefined;
  }

  /** A watcher's session ended: its answer read, its line posted when it has one, its cost kept, its run ended. */
  async finish(thread: ThreadRef, completed: boolean): Promise<AutomationRun | undefined> {
    const found = this.runIn(thread);
    if (!found) return undefined;
    const { run, a } = found;
    let costUsd: number | undefined;
    try {
      costUsd = await this.port.cost(thread);
    } catch {}
    const cost = costUsd === undefined ? {} : { costUsd };
    if (!completed) return this.end(run, "failed", { why: "Its look failed or was stopped before it answered.", ...cost });
    let text: string | undefined;
    try {
      text = await this.port.text(thread);
    } catch (error) {
      return this.end(run, "failed", { why: `Its answer couldn't be read: ${(error as Error).message}`, ...cost });
    }
    const line = verdict(text);
    if (line !== undefined) chat(this.hub).systemLine(a.projectRef, `${a.name}: ${line}`);
    const out = this.end(run, "done", { ...(line === undefined ? {} : { said: line }), ...cost });
    this.firstDay(a, out);
    return out;
  }

  /** The watcher's first finished look a day after it was made: one line with what that day cost. */
  private firstDay(a: Automation, run: AutomationRun): void {
    const made = parseMs(a.createdAt);
    const at = parseMs(run.at);
    if (made === undefined || at === undefined || at < made + DAY_MS) return;
    const earlier = this.hub.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ? AND run_id != ? AND state = 'done' AND at_ms >= ? AND at_ms <= ?",
      [a.automationId, run.runId, made + DAY_MS, at],
    )[0]?.n;
    if (earlier !== 0) return;
    const runs = this.hub.db
      .all<{ data: string }>("SELECT data FROM automation_runs WHERE automation_id = ? AND at_ms < ?", [a.automationId, made + DAY_MS])
      .map((x) => JSON.parse(x.data) as AutomationRun);
    chat(this.hub).systemLine(a.projectRef, firstDayLine(a.name, usage(runs, made)));
  }

  /**
   * Every running watcher run checked: one whose session ended while the hub wasn't following finishes now, one past
   * RUN_LIMIT_MS is stopped and fails, and one whose start a hub stop cut off fails.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    const rows = this.hub.db.all<RunRow & { machine: string; at_ms: number }>(
      `SELECT r.data, r.thread_id, r.started_ms, r.seen, r.automation_id AS automation, a.machine_id AS machine, r.at_ms
         FROM automation_runs r JOIN automations a ON a.automation_id = r.automation_id
       WHERE r.state = 'running' AND r.workstream_id IS NULL AND json_extract(a.data, '$.watch') IS NOT NULL`,
    );
    for (const row of rows) {
      const run = JSON.parse(row.data) as AutomationRun;
      if (row.thread_id === null) {
        if (now - row.at_ms > START_LOST_MS) this.end(run, "failed", { why: "The hub stopped before its look started." });
        continue;
      }
      const thread = { machineId: row.machine, threadId: row.thread_id };
      const started = row.started_ms ?? row.at_ms;
      const done = ended(this.hub, thread, started);
      if (done !== undefined) {
        await this.finish(thread, done);
        continue;
      }
      if (now - started <= RUN_LIMIT_MS) continue;
      try {
        await this.port.stop(thread);
      } catch {}
      let costUsd: number | undefined;
      try {
        costUsd = await this.port.cost(thread);
      } catch {}
      this.end(run, "failed", { why: `It ran past ${RUN_LIMIT_MS / 60_000} minutes and was stopped.`, ...(costUsd === undefined ? {} : { costUsd }) });
    }
  }

  /** Runs `fn` after the follow-ups before it, its failure logged. */
  private then(what: string, fn: () => Promise<unknown>): Promise<void> {
    this.chain = this.chain.then(async () => {
      try {
        await fn();
      } catch (error) {
        console.warn(`watchers: ${what} failed:`, (error as Error).message);
      }
    });
    return this.chain;
  }

  /** Waits for the follow-ups queued so far (tests). */
  settled(): Promise<void> {
    return this.chain;
  }

  /** A followed thread's end, for the watcher run in it. */
  threadEvent(event: HubEvent): void {
    if (!END_EVENTS.has(event.type) || event.machineId === undefined) return;
    const data = (event.data ?? undefined) as Record<string, unknown> | undefined;
    const threadId = event.threadId ?? str(data?.threadId);
    if (threadId === undefined) return;
    const thread = { machineId: event.machineId, threadId };
    if (!this.runIn(thread)) return;
    void this.then("a look's end", () => this.finish(thread, event.type === "thread.completed"));
  }

  /** Follows sessions' ends and sweeps once a minute, until the hub stops. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const stopSignal = this.hub.shutdown.signal;
    const unsubscribe = events(this.hub).subscribe((event) => this.threadEvent(event));
    stopSignal.addEventListener("abort", unsubscribe, { once: true });
    const pass = () => {
      if (stopSignal.aborted) return;
      void this.then("the sweep", () => this.sweep()).then(() => {
        if (stopSignal.aborted) return;
        const timer = setTimeout(pass, SWEEP_MS);
        stopSignal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      });
    };
    pass();
  }
}


/** The hub's watchers, `hub.area("watchers")`. */
export const watchers = (hub: Hub) => hub.area("watchers", (h) => new Watchers(h));
