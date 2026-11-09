// The nightly memory refresh: once a night, at `policy.memory_refresh_at`
// (04:00 by default) in `policy.tz` (else the hub machine's zone), each project with the refresh on
// (`project_settings.memory_refresh`) and chat or order activity since its last run gets a fresh lead session of its
// own. It reads the chat since the last run, the decisions and the memory, and may use `memory_read`, `remember` and
// `forget` and nothing else: it starts with none of the runtime's tools and none of the person's MCP servers, only on a
// node that lists `allowed_only`, and the hub takes only those calls from it (lead_calls/policy.ts). Its changes are
// kept as it makes them (refresh_store.ts `record`) and posted at its end as one "Memory refreshed: +a ~b −c" line with
// Undo; a night that changed nothing posts nothing. A session that fails, or still runs after RUN_LIMIT_MS, is
// stopped. The Automations page lists it as a built-in row (`job`), whose Run now starts one at once (`runNow`).
//
// Sessions start and stop through a `Launcher`, as in Rust: `refreshPorts(hub).launcher`, the executor's launch and stop
// by default; tests set their own.
import type {
  AutomationRunState,
  AutomationTrigger,
  ChatMessage,
  Decision,
  MemoryRefreshJob,
  MemoryRefreshRun,
  ProjectRef,
  RememberedItem,
  ThreadRef,
} from "../../shared/contracts.ts";
import { CAP_ALLOWED_ONLY } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import { quietPolicy } from "../attention/index.ts";
import { accountKey, ClaudeAccountStore, forLead, isRefusal, type NodeAccounts, whoseForLead } from "../claude_accounts/index.ts";
import { CAP_CLAUDE_ACCOUNTS } from "../claude_accounts/tools.ts";
import { chat } from "../chat/index.ts";
import { isPool } from "../cloud/outbox.ts";
import { decisions } from "../ledger/decisions.ts";
import { leads } from "../leads/index.ts";
import { clip } from "../leads/text.ts";
import { launch, type LaunchInput, type LaunchOptions } from "../executor/sessions.ts";
import { stop } from "../executor/stop.ts";
import { link } from "../link/index.ts";
import { profiles } from "../projects/profiles.ts";
import { projectSettings } from "../projects/settings.ts";
import { prompts } from "../prompts/store.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { zonedParts, zonedToUtc } from "../wakes/schedule.ts";
import { INDEX_FILE, Memory, projectTarget, youTarget } from "./index.ts";
import { getRun, listed, putLineItems, putRun, type Run, youOver } from "./refresh_store.ts";

/** The global decision that moves the night's hour: "HH:MM" in the person's zone. */
export const AT_KEY = "policy.memory_refresh_at";
export const DEFAULT_AT = "04:00";
/** The night's refresh starts within this long after its hour, or not that night. */
const WINDOW_MS = 3 * 3_600_000;
/** A refresh session still going after this long is stopped, and finished as it stands. */
export const RUN_LIMIT_MS = 3_600_000;
const TICK_MS = 60_000;
/** The longest a zone's clocks have jumped forward at once, with room to spare. */
const GAP_MINUTES = 180;
/** The chat a refresh reads: newest kept, each message cut. */
const CHAT_CHARS = 40_000;
const MESSAGE_CHARS = 2_000;
const CHAT_ROWS = 2_000;
const DECISIONS = 200;
const END_EVENTS = ["thread.completed", "thread.failed", "thread.interrupted", "thread.usage_limited"];
/** The ops the hub takes from a refresh session (lead_calls/policy.ts, Rust `MEMORY_REFRESH_OPS`). */
const MEMORY_REFRESH_OPS = ["memory_read", "remember", "forget"];

/** The tools a refresh session may use, and nothing else: fleetd's memory calls. */
export const allowedTools = () => MEMORY_REFRESH_OPS.map((op) => `mcp__fleetd__${op}`);

/** How a refresh session starts: the lead's fleetd tools, only `allowedTools` usable, and fleetd's MCP server alone. */
export const launchOptions = (): LaunchOptions => ({
  role: "lead",
  mcpRole: "lead",
  mcp: { userServers: false, servers: [] },
  onlyTools: allowedTools(),
});

/** Starts and stops refresh sessions on the project's machine: the hub's executors, or a test's. */
export type Launcher = {
  /** The session's thread id; throws with why it didn't start. */
  launch(machineId: string, input: LaunchInput, options: LaunchOptions): Promise<string>;
  /** Ends the session's process, as a task's stop does. */
  stop(thread: ThreadRef): Promise<void>;
};

/** What the refresh reaches in other areas: the launcher, and the node's capabilities (link `node_can`/`node_lacks`). */
export type RefreshPorts = {
  launcher: Launcher;
  can(machineId: string, cap: string): boolean;
  lacks(machineId: string, cap: string): boolean;
};

/** The hub's executors, which start refresh sessions on the project's machine; tests set the whole port. */
export const refreshPorts = (hub: Hub): RefreshPorts =>
  hub.area<RefreshPorts>("memory_refresh", (h) => ({
    launcher: {
      launch: async (machineId, input, options) => (await launch(h, machineId, input, options)).threadId,
      stop: (thread) => stop(h, thread),
    },
    can: (m, cap) => link(h).can(m, cap),
    lacks: (m, cap) => link(h).lacks(m, cap),
  }));

/** claude_accounts `node_accounts`: whether the machine's node runs Claude accounts. */
function nodeAccounts(hub: Hub, m: string): NodeAccounts {
  const ports = refreshPorts(hub);
  return ports.can(m, CAP_CLAUDE_ACCOUNTS) ? "runs" : ports.lacks(m, CAP_CLAUDE_ACCOUNTS) ? "too_old" : "offline";
}

/** The refresh's loop: one pass a minute, until the hub stops. */
export function run(hub: Hub): void {
  const stop = hub.shutdown.signal;
  const pass = async () => {
    if (stop.aborted) return;
    try {
      await tick(hub);
    } catch (error) {
      console.warn("memory refresh: pass failed:", (error as Error).message);
    }
    if (!stop.aborted) {
      const timer = setTimeout(pass, TICK_MS);
      stop.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }
  };
  void pass();
}

// ---- the night's hour ------------------------------------------------------------------------------------------------

type Time = { hour: number; minute: number };

/** The day's `at` in `tz`, as epoch ms: the first minute that exists from it on (spring forward skips some). */
function dayAt(year: number, month: number, day: number, at: Time, tz: string): number | undefined {
  for (let m = 0; m <= GAP_MINUTES; m++) {
    const d = new Date(Date.UTC(year, month - 1, day, at.hour, at.minute + m));
    const local = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: 0 };
    const ms = zonedToUtc(local, tz);
    const back = zonedParts(ms, tz);
    if (back.year === local.year && back.month === local.month && back.day === local.day && back.hour === local.hour && back.minute === local.minute) return ms;
  }
  return undefined;
}

/** The local day `offset` days from the one `ms` falls on in `tz`. */
function dayOf(ms: number, tz: string, offset: number): [number, number, number] {
  const t = zonedParts(ms, tz);
  const d = new Date(Date.UTC(t.year, t.month - 1, t.day + offset));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** The hour of the night due now: today's (or yesterday's) `at` in `tz`, when now is at most WINDOW_MS past it. */
export function nightDue(nowMs: number, tz: string, at: Time): number | undefined {
  for (const offset of [0, -1]) {
    const ms = dayAt(...dayOf(nowMs, tz, offset), at, tz);
    if (ms !== undefined && ms <= nowMs && nowMs - ms < WINDOW_MS) return ms;
  }
  return undefined;
}

/** The first hour of a night after `nowMs`. */
export function nextNight(nowMs: number, tz: string, at: Time): number | undefined {
  for (const offset of [0, 1, 2]) {
    const ms = dayAt(...dayOf(nowMs, tz, offset), at, tz);
    if (ms !== undefined && ms > nowMs) return ms;
  }
  return undefined;
}

const parseTime = (v: string | undefined): Time | undefined => {
  const m = v === undefined ? null : /^(\d{1,2}):(\d{1,2})$/.exec(v);
  if (!m) return undefined;
  const [hour, minute] = [Number(m[1]), Number(m[2])];
  return hour < 24 && minute < 60 ? { hour, minute } : undefined;
};

/** `policy.memory_refresh_at`, or 04:00; and the zone it is in. */
function schedule(hub: Hub): [string, Time] {
  const global = (k: string) => {
    try {
      return decisions(hub).globalValue(k);
    } catch {
      return undefined;
    }
  };
  const [tz] = quietPolicy(global);
  return [tz, parseTime(global(AT_KEY)) ?? (parseTime(DEFAULT_AT) as Time)];
}

const pad = (n: number) => String(n).padStart(2, "0");

// ---- one pass --------------------------------------------------------------------------------------------------------

/** Whether anyone spoke in the chat after `watermark`, or an order changed after `sinceMs`. */
function active(hub: Hub, r: ProjectRef, watermark: number, sinceMs: number | undefined): boolean {
  const row = hub.db.all<{ yes: number }>(
    `SELECT EXISTS (SELECT 1 FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3
       AND held = 0 AND json_extract(data, '$.author') IN ('human', 'lead'))
     OR EXISTS (SELECT 1 FROM workstreams WHERE machine_id = ?1 AND project_id = ?2
       AND json_extract(data, '$.updatedAt') > ?4) AS yes`,
    [r.machineId, r.projectId, watermark, isoMs(sinceMs ?? 0)],
  )[0];
  return Boolean(row?.yes);
}

/** Why a project with nothing new isn't refreshed. */
const QUIET = "Nothing new in the chat or its orders since the last refresh.";

const tooOld = (r: ProjectRef) => `update ${r.machineId} to let it run`;

/** Why a refresh of `r` can't start now: its lead is mid-turn, its login is out of usage, or no node is linked. */
function held(hub: Hub, r: ProjectRef): string | undefined {
  try {
    if (leads(hub).get(r)?.state === "working") return "The lead is mid-turn: try again once it is done.";
  } catch {}
  const usage = hub.peek<{ gateFor(machineId: string, account: string | undefined): string | undefined }>("usage");
  const gate = usage?.gateFor(r.machineId, leadAccountKey(hub, r));
  if (gate !== undefined) return gate;
  return refreshPorts(hub).can(r.machineId, CAP_ALLOWED_ONLY) ? undefined : `${r.machineId} is offline.`;
}

/** The key of the account the lead of `r` runs on (claude_accounts `lead_account_key`), for the usage gate. */
function leadAccountKey(hub: Hub, r: ProjectRef): string | undefined {
  try {
    const setup = new ClaudeAccountStore(hub.db).setup();
    const on = setup.runsOn(whoseForLead(hub.db, setup, r), r.machineId);
    return on.kind === "account" ? accountKey(on.account) : undefined;
  } catch {
    return undefined;
  }
}

const sign = (i: RememberedItem) => (i.forgotten === true ? "−" : i.replaced !== undefined ? "~" : "+");

/** "Memory refreshed: +2 ~1 −1" (contracts memory.rs `refreshed_summary`). */
export function refreshedSummary(items: RememberedItem[]): string {
  const parts = ["+", "~", "−"].map((s) => [s, items.filter((i) => sign(i) === s).length] as const).filter(([, n]) => n > 0);
  return `Memory refreshed: ${parts.map(([s, n]) => `${s}${n}`).join(" ")}`;
}

/** A refresh's record for its row: when, what started it, how it went, and the changes in `items`. */
function outcome(atMs: number, trigger: AutomationTrigger, state: AutomationRunState, items: RememberedItem[], why?: string): MemoryRefreshRun {
  const count = (s: string) => items.filter((i) => sign(i) === s).length;
  return {
    at: isoMs(atMs),
    trigger,
    state,
    added: count("+"),
    replaced: count("~"),
    removed: count("−"),
    ...(why === undefined ? {} : { why: clip(why.replace(/[\r\n]/g, " "), 200) }),
  };
}

/** Keeps `run` with `last` as how its refresh went, and tells the app (`memory.refresh`). */
function ran(hub: Hub, r: ProjectRef, run: Run, last: MemoryRefreshRun): void {
  run.lastRun = last;
  putRun(hub.db, r, run);
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "memory.refresh",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: `memory refresh of ${r.machineId}/${r.projectId}: ${last.state}`,
    data: { projectRef: r, trigger: last.trigger, state: last.state },
  });
}

/** Whether the session ended after `startedMs`: true when it completed. */
function ended(hub: Hub, thread: ThreadRef, startedMs: number): boolean | undefined {
  const type = hub.db.all<{ type: string }>(
    `SELECT type FROM events WHERE type IN (SELECT value FROM json_each(?1)) AND machine_id = ?2
       AND json_extract(data, '$.threadId') = ?3 AND created_ms >= ?4 ORDER BY seq LIMIT 1`,
    [JSON.stringify(END_EVENTS), thread.machineId, thread.threadId, startedMs],
  )[0]?.type;
  return type === undefined ? undefined : type === "thread.completed";
}

/**
 * Finishes the refreshes whose session ended or ran too long, then starts the night's refresh of at most one project,
 * so a hub's projects start a minute apart.
 */
export async function tick(hub: Hub, launcher: Launcher = refreshPorts(hub).launcher): Promise<void> {
  const now = hub.clock.now();
  for (const project of store(hub).projectsList()) {
    const r = { machineId: project.machineId, projectId: project.projectId };
    const run = getRun(hub.db, r);
    if (run.threadId === undefined || run.startedMs === undefined) continue;
    const thread = { machineId: r.machineId, threadId: run.threadId };
    let completed = ended(hub, thread, run.startedMs);
    if (completed === undefined) {
      if (now - run.startedMs <= RUN_LIMIT_MS) continue;
      completed = false;
    }
    // A session that didn't complete may still run, or be resumed: it goes, so nothing it does later is lost.
    if (!completed) {
      try {
        await launcher.stop(thread);
      } catch (error) {
        console.warn(`memory refresh: session of ${project.title} not stopped:`, (error as Error).message);
      }
    }
    finish(hub, r, completed);
  }
  const [tz, at] = schedule(hub);
  const night = nightDue(now, tz, at);
  if (night === undefined) return;
  // A cloud machine's checkouts are its projects' twins (D306): their memory is their home checkout's.
  for (const project of store(hub).projectsList().filter((p) => !isPool(hub, p.machineId))) {
    const r = { machineId: project.machineId, projectId: project.projectId };
    const run = getRun(hub.db, r);
    if (run.threadId !== undefined || (run.nightMs !== undefined && run.nightMs >= night) || !projectSettings(hub).memoryRefresh(r)) continue;
    if (!active(hub, r, run.watermark, run.nightMs)) {
      run.nightMs = night;
      ran(hub, r, run, outcome(night, "schedule", "skipped", [], QUIET));
      continue;
    }
    // A node too old to hold the session to its memory tools: tried again on the next pass, and the chat says so once.
    if (refreshPorts(hub).lacks(r.machineId, CAP_ALLOWED_ONLY)) {
      if (run.skippedMs !== night) {
        chat(hub).systemLine(r, `Memory refresh skipped: ${tooOld(r)}`);
        run.skippedMs = night;
        ran(hub, r, run, outcome(night, "schedule", "skipped", [], tooOld(r)));
      }
      continue;
    }
    // Tried again on the next pass, within the night's window.
    if (held(hub, r) !== undefined) continue;
    await start(hub, launcher, r, project.title, run, night, "schedule");
    return;
  }
}

/** The refresh as the Automations page lists it for `r`: on or off, its hour and zone, its next night, the run now or last. */
export function job(hub: Hub, r: ProjectRef): MemoryRefreshJob {
  const on = projectSettings(hub).memoryRefresh(r);
  const [tz, at] = schedule(hub);
  const run = getRun(hub.db, r);
  const last = run.lastRun;
  const lastRun = last && run.threadId !== undefined ? { ...outcome(0, last.trigger, "running", run.items), at: last.at } : last;
  const next = on ? nextNight(hub.clock.now(), tz, at) : undefined;
  return {
    on,
    at: `${pad(at.hour)}:${pad(at.minute)}`,
    tz,
    ...(next === undefined ? {} : { nextRunAt: isoMs(next) }),
    ...(lastRun === undefined ? {} : { lastRun }),
  };
}

/** Run now: a refresh of `r` started at once, held by the night's rules; why it didn't start. */
export async function runNow(hub: Hub, r: ProjectRef, launcher: Launcher = refreshPorts(hub).launcher): Promise<string | undefined> {
  const project = store(hub).projectGet(r);
  if (!project) return `There is no project ${r.machineId}/${r.projectId}.`;
  const run = getRun(hub.db, r);
  let why: string | undefined;
  if (!projectSettings(hub).memoryRefresh(r)) why = "It is off for this project: turn it on first.";
  else if (run.threadId !== undefined) why = "A refresh is already running.";
  else if (!active(hub, r, run.watermark, run.nightMs)) why = QUIET;
  else if (refreshPorts(hub).lacks(r.machineId, CAP_ALLOWED_ONLY)) why = `Its node is too old: ${tooOld(r)}.`;
  else why = held(hub, r);
  if (why !== undefined) return why;
  return start(hub, launcher, r, project.title, run, hub.clock.now(), "manual");
}

/** Starts the refresh of `night` (Run now's: its moment); why it didn't start, which its row shows. */
async function start(hub: Hub, launcher: Launcher, r: ProjectRef, title: string, run: Run, night: number, trigger: AutomationTrigger): Promise<string | undefined> {
  // Tried once a night: a launch that fails waits for the next one.
  run.nightMs = night;
  putRun(hub.db, r, run);
  const now = hub.clock.now();
  const failed = (why: string) => {
    ran(hub, r, run, outcome(now, trigger, "failed", [], why));
    return why;
  };
  const [chatText, readTo] = chatSince(hub, r, run.watermark);
  let decided: Decision[] = [];
  try {
    decided = decisions(hub).list({ chain: { projectRef: r }, limit: DECISIONS });
  } catch {}
  const set = prompts(hub.db).current(r);
  const message = prompt(set.render("lead.memory", { project: title }), memoryNow(hub, r, run.watermark, readTo), decided, chatText);
  let profile = "legacy";
  try {
    profile = profiles(hub).defaultProfile().name;
  } catch {}
  const input: LaunchInput = {
    projectId: r.projectId,
    prompt: message,
    profile,
    // Its node asks for any tool not allowed, and refuses it.
    runtimeMode: "approval-required",
    title: [...`fleetd memory refresh: ${title}`].slice(0, 80).join(""),
    clientRequestId: `fleetd-memory:${r.machineId}/${r.projectId}:${night}`,
  };
  // Nobody asked for it: it runs on the account the project's lead does (a Navi's, its owner's).
  const account = forLead(hub.db, (m) => nodeAccounts(hub, m), r);
  if (isRefusal(account)) {
    console.warn(`memory refresh of ${title}: not started: ${account.message}`);
    return failed(account.message);
  }
  const options: LaunchOptions = { ...launchOptions(), ...(account === undefined ? {} : { claudeAccount: account }) };
  let threadId: string;
  try {
    threadId = await launcher.launch(r.machineId, input, options);
  } catch (error) {
    console.warn(`memory refresh of ${title}: not started:`, (error as Error).message);
    return failed(`It didn't start: ${(error as Error).message}`);
  }
  run.threadId = threadId;
  run.startedMs = now;
  run.readTo = readTo;
  run.items = [];
  ran(hub, r, run, outcome(now, trigger, "running", []));
  return undefined;
}

/**
 * Ends the running refresh of `r`: its line when it changed anything, and the chat it read marked read when it
 * completed. One that failed or ran out of time reads the same chat again the next night.
 */
export function finish(hub: Hub, r: ProjectRef, completed: boolean): void {
  const run = getRun(hub.db, r);
  if (run.threadId === undefined) return;
  const items = run.items;
  const started = run.startedMs ?? hub.clock.now();
  const trigger = run.lastRun?.trigger ?? "schedule";
  const last = completed
    ? outcome(started, trigger, "done", items)
    : outcome(started, trigger, "failed", items, "It failed or ran past its hour, and was stopped; the next one reads the same chat again.");
  if (items.length > 0) {
    const { message } = chat(hub).add(r, { author: "system", text: refreshedSummary(items), memoryRefreshed: listed(items) });
    putLineItems(hub.db, r, message.messageId, items);
  }
  if (completed && run.readTo !== undefined) run.watermark = Math.max(run.watermark, run.readTo);
  delete run.threadId;
  delete run.startedMs;
  delete run.readTo;
  run.items = [];
  ran(hub, r, run, last);
}

// ---- the session's message -------------------------------------------------------------------------------------------

/**
 * The chat after `watermark` as lines, oldest first, within CHAT_CHARS (newest kept, with a note of what was cut), and
 * the newest `seq` there is.
 */
function chatSince(hub: Hub, r: ProjectRef, watermark: number): [string, number] {
  const rows = hub.db.all<{ seq: number; data: string }>(
    `SELECT seq, data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3 AND held = 0
     ORDER BY seq DESC LIMIT ?4`,
    [r.machineId, r.projectId, watermark, CHAT_ROWS],
  );
  const readTo = rows[0]?.seq ?? watermark;
  const lines: string[] = [];
  let used = 0;
  let cut = 0;
  for (const { data } of rows) {
    let m: ChatMessage;
    try {
      m = JSON.parse(data) as ChatMessage;
    } catch {
      continue;
    }
    const line = chatLine(m);
    if (line === undefined) continue;
    const bytes = Buffer.byteLength(line);
    if (used + bytes > CHAT_CHARS) {
      cut += 1;
      continue;
    }
    used += bytes;
    lines.push(line);
  }
  lines.reverse();
  return [`${cut > 0 ? `(${cut} older messages left out.)\n` : ""}${lines.join("\n")}`, readTo];
}

function chatLine(m: ChatMessage): string | undefined {
  const text = clip((m.text ?? "").trim(), MESSAGE_CHARS);
  if (!text) return undefined;
  let who: string;
  if (m.author === "human") who = "Human";
  else if (m.author === "lead") who = "Lead";
  else if (m.author === "system" && m.remembered !== undefined) who = "fleetd";
  else return undefined;
  return `${who}: ${text}`;
}

/** Every memory file of the project and the user memory of whose chat it read, whole, each under its name. */
function memoryNow(hub: Hub, r: ProjectRef, watermark: number, readTo: number): string {
  const memory = Memory.of(hub);
  let you;
  try {
    you = youOver(hub.db, r, watermark, readTo);
  } catch {
    you = { kind: "nobody" as const };
  }
  const t = youTarget(you);
  const user = t ? memory.read(t) : "(Several people wrote in this chat, so user memory is left alone tonight.)";
  const files: [string, string][] = [
    ["user.md (add only)", user],
    [`${INDEX_FILE} (project)`, memory.read(projectTarget(r))],
  ];
  for (const topic of memory.topics(r)) files.push([`${topic}.md (project, topic ${topic})`, memory.read(projectTarget(r, topic))]);
  const caps = memory.caps;
  let out =
    `Caps, in characters: user.md ${caps.user}, MEMORY.md ${caps.index}, each topic ${caps.topic}, the project's files ` +
    `together ${caps.project} (now ${memory.projectChars(r)}).`;
  for (const [name, text] of files) {
    const body = text.trimEnd();
    out += `\n\n### ${name}\n${body || "(empty)"}`;
  }
  return out;
}

/** The refresh session's one message: its prompt, then the memory, the decisions and the chat. */
export function prompt(rules: string, memory: string, decided: Decision[], chatText: string): string {
  const list =
    decided.length === 0
      ? "(none)"
      : decided.map((d) => `- ${d.decisionId} ${d.key}: ${d.value}${d.why !== undefined ? ` (${d.why})` : ""}`).join("\n");
  const said = chatText.trim() ? chatText : "(none)";
  return `${rules.trimEnd()}\n\n## Memory now\n${memory}\n\n## Active decisions\n${list}\n\n## Chat since the last refresh\n${said}`;
}
