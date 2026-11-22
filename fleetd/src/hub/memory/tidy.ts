// The tidy of a person's own memory: once a night per person, after the night's per-bot refreshes (refresh.ts), and
// soon after a write leaves their memory past a cap (index.ts asks, tidy_store `askTidy`). A fresh session reads their
// whole memory and, from each bot, what they said there since its last tidy (tidy_rules `tidyChatLine`), and may merge,
// correct, tighten and move detail into topics with `memory_read`, `remember` and `forget` on their memory alone
// (lead_calls/policy.ts holds a `memory_refresh` caller with a person to scope user). It runs on the machine of the bot
// they wrote in last, held like a refresh (allowed_only, the lead not mid-turn, RUN_LIMIT_MS), on their own Claude
// choice. Its changes are posted at its end as one "Memory refreshed: +a ~b −c" line in that bot's chat, with Undo;
// the line keeps their files as the tidy found and left them, so Undo all puts them back exactly (tools.ts).
import type { AutomationTrigger, ChatMessage, PersonId, ProjectRef } from "../../shared/contracts.ts";
import { CAP_ALLOWED_ONLY } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import { ClaudeAccountStore, isRefusal, launchAccount } from "../claude_accounts/index.ts";
import { chat } from "../chat/index.ts";
import type { LaunchInput, LaunchOptions } from "../executor/sessions.ts";
import { profiles } from "../projects/profiles.ts";
import { prompts } from "../prompts/store.ts";
import { store } from "../store/hub_store.ts";
import { activePeople, Memory } from "./index.ts";
import { ended, held, type Launcher, launchOptions, nightDue, nodeAccounts, outcome, refreshPorts, RUN_LIMIT_MS, schedule } from "./refresh.ts";
import { refreshedSummary } from "./refresh_rules.ts";
import { getRun, listed, putLineItems } from "./refresh_store.ts";
import {
  ownWords,
  type Snapshot,
  snapshotKey,
  TIDY_CHAT_CHARS,
  TIDY_DEBOUNCE_MS,
  TIDY_GAP_MS,
  TIDY_LATEST_MS,
  TIDY_PROMPT_ID,
  tidyChatLine,
  tidyMemory,
  tidyPrompt,
} from "./tidy_rules.ts";
import { botKey, getTidy, putLineSnapshot, putTidy, type Tidy } from "./tidy_store.ts";

/** The chat rows of one bot a tidy looks at. */
const CHAT_ROWS = 2_000;
const QUIET = "Nothing new since the last tidy.";

type Bot = { r: ProjectRef; title: string };

const liveBots = (hub: Hub): Bot[] =>
  store(hub)
    .projectsList()
    .filter((p) => p.archivedAt === undefined)
    .map((p) => ({ r: { machineId: p.machineId, projectId: p.projectId }, title: p.title }));

const nameOf = (hub: Hub, person: PersonId) =>
  hub.db.all<{ name: string }>("SELECT name FROM people WHERE person_id = ?", [person])[0]?.name || "the person";

/**
 * Finishes the tidies whose session ended or ran too long, then starts at most one: a person's night once the night's
 * per-bot refreshes are done (or TIDY_LATEST_MS after its hour), or one a write past a cap asked for.
 */
export async function tick(hub: Hub, launcher: Launcher = refreshPorts(hub).launcher): Promise<void> {
  const now = hub.clock.now();
  const people = activePeople(hub.db).map((p) => p.personId);
  for (const person of people) {
    const t = getTidy(hub.db, person);
    if (t.threadId === undefined || t.startedMs === undefined || t.host === undefined) continue;
    const thread = { machineId: t.host.machineId, threadId: t.threadId };
    let completed = ended(hub, thread, t.startedMs);
    if (completed === undefined) {
      if (now - t.startedMs <= RUN_LIMIT_MS) continue;
      completed = false;
    }
    if (!completed) {
      try {
        await launcher.stop(thread);
      } catch (error) {
        console.warn("memory tidy: session not stopped:", (error as Error).message);
      }
    }
    finish(hub, person, completed);
  }
  const [tz, at] = schedule(hub);
  const night = nightDue(now, tz, at);
  const bots = liveBots(hub);
  const refreshesDone =
    night !== undefined &&
    (now - night >= TIDY_LATEST_MS ||
      bots.every(({ r }) => {
        const run = getRun(hub.db, r);
        return run.threadId === undefined && run.nightMs !== undefined && run.nightMs >= night;
      }));
  for (const person of people) {
    const t = getTidy(hub.db, person);
    if (t.threadId !== undefined) continue;
    if (refreshesDone && night !== undefined && (t.nightMs === undefined || t.nightMs < night)) {
      if (quiet(hub, person, t, bots, people.length === 1)) {
        t.nightMs = night;
        t.lastRun = outcome(night, "schedule", "skipped", [], QUIET);
        putTidy(hub.db, person, t);
        continue;
      }
      if (await start(hub, launcher, person, t, bots, "schedule", night)) return;
      continue;
    }
    if (t.dueMs !== undefined) {
      const last = t.lastRun?.state === "skipped" || t.lastRun === undefined ? undefined : Date.parse(t.lastRun.at);
      if (now < t.dueMs + TIDY_DEBOUNCE_MS || (last !== undefined && now < last + TIDY_GAP_MS)) continue;
      if (!Memory.of(hub).overCap(person)) {
        delete t.dueMs;
        putTidy(hub.db, person, t);
        continue;
      }
      if (await start(hub, launcher, person, t, bots, "cap", now)) return;
    }
  }
}

/** Whether `person` said nothing in any bot since its last tidy, and their memory is empty or as the last tidy left it. */
function quiet(hub: Hub, person: PersonId, t: Tidy, bots: Bot[], only: boolean): boolean {
  const files = Memory.of(hub).snapshot(person);
  if (Object.keys(files).length > 0 && snapshotKey(files) !== t.seen) return false;
  return bots.every(({ r }) => {
    const rows = hub.db.all<{ data: string }>(
      `SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3 AND held = 0
       AND json_extract(data, '$.author') = 'human' ORDER BY seq DESC LIMIT ?4`,
      [r.machineId, r.projectId, t.watermarks[botKey(r)] ?? 0, CHAT_ROWS],
    );
    return !rows.some(({ data }) => {
      try {
        return ownWords(JSON.parse(data) as ChatMessage, person, only);
      } catch {
        return false;
      }
    });
  });
}

/**
 * What `person` said in bot `r` after `watermark`, as lines, oldest first, within TIDY_CHAT_CHARS (newest kept), and
 * the newest `seq` there is.
 */
function chatOf(hub: Hub, r: ProjectRef, person: PersonId, only: boolean, watermark: number): [string, number] {
  const rows = hub.db.all<{ seq: number; data: string }>(
    `SELECT seq, data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3 AND held = 0
     ORDER BY seq DESC LIMIT ?4`,
    [r.machineId, r.projectId, watermark, CHAT_ROWS],
  );
  const readTo = rows[0]?.seq ?? watermark;
  const messages: ChatMessage[] = [];
  for (const { data } of rows) {
    try {
      messages.push(JSON.parse(data) as ChatMessage);
    } catch {}
  }
  // The lead's words count only where nobody else wrote: its answers to another person aren't this person's.
  const solo = !messages.some((m) => m.author === "human" && !ownWords(m, person, only));
  const lines: string[] = [];
  let used = 0;
  let cut = 0;
  for (const m of messages) {
    const line = tidyChatLine(m, person, only, solo);
    if (line === undefined) continue;
    const size = [...line].length;
    if (used + size > TIDY_CHAT_CHARS) {
      cut += 1;
      continue;
    }
    used += size;
    lines.push(line);
  }
  if (!lines.length) return ["", readTo];
  lines.reverse();
  return [`${cut > 0 ? `(${cut} older messages left out.)\n` : ""}${lines.join("\n")}`, readTo];
}

/**
 * The bot to run `person`'s tidy on, whose chat gets its line: of the bots they wrote in where nobody else did (their
 * entries are theirs alone, D212), the one they wrote in last that can hold the session now.
 */
function host(hub: Hub, person: PersonId, bots: Bot[], only: boolean): Bot | undefined {
  const last = new Map<string, number>();
  const rows = hub.db.all<{ machine_id: string; project_id: string; seq: number }>(
    `SELECT machine_id, project_id, MAX(seq) AS seq FROM chat_messages
     WHERE held = 0 AND json_extract(data, '$.author') = 'human'
       AND (json_extract(data, '$.person.personId') = ?1 OR (?2 = 1 AND json_extract(data, '$.person') IS NULL))
     GROUP BY machine_id, project_id`,
    [person, only ? 1 : 0],
  );
  for (const row of rows) last.set(botKey({ machineId: row.machine_id, projectId: row.project_id }), row.seq);
  const shared = new Set(
    hub.db
      .all<{ machine_id: string; project_id: string }>(
        `SELECT DISTINCT machine_id, project_id FROM chat_messages
         WHERE held = 0 AND json_extract(data, '$.author') = 'human'
           AND (json_extract(data, '$.person.personId') IS NOT ?1 AND NOT (?2 = 1 AND json_extract(data, '$.person') IS NULL))`,
        [person, only ? 1 : 0],
      )
      .map((row) => botKey({ machineId: row.machine_id, projectId: row.project_id })),
  );
  const ports = refreshPorts(hub);
  return bots
    .filter((b) => last.has(botKey(b.r)) && !shared.has(botKey(b.r)))
    .sort((a, b) => (last.get(botKey(b.r)) as number) - (last.get(botKey(a.r)) as number))
    .find((b) => ports.can(b.r.machineId, CAP_ALLOWED_ONLY) && held(hub, b.r) === undefined);
}

/** Starts `person`'s tidy; whether it started (one that can't yet is tried on the next pass). */
async function start(hub: Hub, launcher: Launcher, person: PersonId, t: Tidy, bots: Bot[], trigger: AutomationTrigger, at: number): Promise<boolean> {
  const only = activePeople(hub.db).length === 1;
  const on = host(hub, person, bots, only);
  if (on === undefined) return false;
  const now = hub.clock.now();
  const memory = Memory.of(hub);
  const before = memory.snapshot(person);
  const readTo: Record<string, number> = {};
  const chats: { title: string; text: string }[] = [];
  for (const b of bots) {
    const [text, to] = chatOf(hub, b.r, person, only, t.watermarks[botKey(b.r)] ?? 0);
    readTo[botKey(b.r)] = to;
    chats.push({ title: b.title, text });
  }
  const name = nameOf(hub, person);
  const rules = prompts(hub.db).current().render(TIDY_PROMPT_ID, { person: name });
  let profile = "legacy";
  try {
    profile = profiles(hub).defaultProfile().name;
  } catch {}
  const input: LaunchInput = {
    projectId: on.r.projectId,
    prompt: tidyPrompt(rules, tidyMemory(before, memory.caps), chats),
    profile,
    runtimeMode: "approval-required",
    title: [...`fleetd memory tidy: ${name}`].slice(0, 80).join(""),
    clientRequestId: `fleetd-memory-tidy:${person}:${at}`,
  };
  if (trigger === "schedule") t.nightMs = at;
  delete t.dueMs;
  const failed = (why: string) => {
    t.lastRun = outcome(now, trigger, "failed", [], why);
    putTidy(hub.db, person, t);
    return true;
  };
  // It runs on the person's own Claude choice, as their import does.
  const account = launchAccount(new ClaudeAccountStore(hub.db).setup(), { person }, on.r.machineId, () => nodeAccounts(hub, on.r.machineId));
  if (isRefusal(account)) return failed(account.message);
  const options: LaunchOptions = { ...launchOptions(), ...(account === undefined ? {} : { claudeAccount: account }) };
  let threadId: string;
  try {
    threadId = await launcher.launch(on.r.machineId, input, options);
  } catch (error) {
    console.warn(`memory tidy of ${name}: not started:`, (error as Error).message);
    return failed(`It didn't start: ${(error as Error).message}`);
  }
  Object.assign(t, { host: on.r, threadId, startedMs: now, trigger, readTo, items: [], before, outside: false });
  t.lastRun = outcome(now, trigger, "running", []);
  putTidy(hub.db, person, t);
  return true;
}

/** Ends `person`'s running tidy: its line when it changed anything, and the chat it read marked read when it completed. */
export function finish(hub: Hub, person: PersonId, completed: boolean): void {
  const t = getTidy(hub.db, person);
  if (t.threadId === undefined || t.host === undefined) return;
  const items = t.items;
  const started = t.startedMs ?? hub.clock.now();
  const trigger = t.trigger ?? "schedule";
  const after: Snapshot = Memory.of(hub).snapshot(person);
  // A bot erased while it ran gets no line; the changes stay, and Settings shows them.
  if (items.length > 0 && store(hub).projectGet(t.host)) {
    const { message } = chat(hub).add(t.host, { author: "system", text: refreshedSummary(items), memoryRefreshed: listed(items) });
    putLineItems(hub.db, t.host, message.messageId, items);
    // Undo all restores the files exactly only when the tidy alone wrote them meanwhile; else it goes item by item.
    if (t.outside !== true) putLineSnapshot(hub.db, message.messageId, { person, before: t.before ?? {}, after });
    t.messageId = message.messageId;
  }
  if (completed && t.readTo !== undefined) {
    for (const [k, seq] of Object.entries(t.readTo)) t.watermarks[k] = Math.max(t.watermarks[k] ?? 0, seq);
  }
  t.seen = snapshotKey(after);
  t.lastRun = completed
    ? outcome(started, trigger, "done", items)
    : outcome(started, trigger, "failed", items, "It failed or ran past its hour, and was stopped; the next one reads the same chat again.");
  for (const k of ["host", "threadId", "startedMs", "trigger", "readTo", "before", "outside"] as const) delete t[k];
  t.items = [];
  putTidy(hub.db, person, t);
}

/** `person`'s last tidy's line, for the top of their Memory page. */
export function lastTidied(hub: Hub, person: PersonId): ChatMessage | undefined {
  const id = getTidy(hub.db, person).messageId;
  return id === undefined ? undefined : chat(hub).byId(id);
}
