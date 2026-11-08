// The nightly memory refresh and Import memory (src/hub/memory/refresh.ts, import.ts), after
// crates/fleetd/src/hub/memory/refresh_tests.rs and import_tests.rs: who gets a refresh, what its session is told, the
// one line it leaves, the row's Run now; an import's turn and how its entries are written. The sessions are fakes: a
// launcher and a turn of the test's own, a fresh home under $TMPDIR, a fake clock.
import { afterEach, expect, test } from "bun:test";
import type { Hub } from "../src/hub/api/hub.ts";
import type { Registry } from "../src/hub/api/registry.ts";
import { chat } from "../src/hub/chat/index.ts";
import { decisions } from "../src/hub/ledger/decisions.ts";
import { answer } from "../src/hub/memory/calls.ts";
import { clean, importPorts, parse, registerImportAndRefresh, type Turn } from "../src/hub/memory/import.ts";
import { Memory, projectTarget, userTarget } from "../src/hub/memory/index.ts";
import type { LaunchInput, LaunchOptions } from "../src/hub/executor/sessions.ts";
import { ExecutorTurn } from "../src/hub/executor/turn.ts";
import { register as registerAutomationTools } from "../src/hub/automations/tools.ts";
import { job, nightDue, refreshPorts, runNow, tick } from "../src/hub/memory/refresh.ts";
import { put as putNavi } from "../src/hub/navi/store.ts";
import { projectSettings } from "../src/hub/projects/settings.ts";
import type { LeadCall } from "../src/hub/leads/seams.ts";
import { events } from "../src/hub/store/events.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { ChatMessage } from "../src/shared/contracts.ts";
import { CAP_ALLOWED_ONLY } from "../src/shared/node_link.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

/** 2026-10-27 04:10 UTC: ten minutes into the night's window. */
const NIGHT_MS = 1_793_074_200_000;
const DAY = 24 * 3_600_000;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

type Node = { launches: LaunchInput[]; options: LaunchOptions[]; stops: string[]; caps: Set<string> };

/** A hub at NIGHT_MS whose zone is UTC, its node linked with `allowed_only`, and a launcher that records each start. */
function setup() {
  const t = testHub(NIGHT_MS);
  cleanup = t.done;
  const hub = t.hub;
  global(hub, "policy.tz", "UTC");
  const node: Node = { launches: [], options: [], stops: [], caps: new Set([CAP_ALLOWED_ONLY]) };
  Object.assign(refreshPorts(hub), {
    launcher: {
      async launch(_m: string, input: LaunchInput, options: LaunchOptions) {
        node.launches.push(input);
        node.options.push(options);
        return `refresh-${node.launches.length}`;
      },
      async stop(thread: { threadId: string }) {
        node.stops.push(thread.threadId);
      },
    },
    can: (_m: string, cap: string) => node.caps.has(cap),
    lacks: (_m: string, cap: string) => !node.caps.has(cap),
  });
  return { ...t, node };
}

function global(hub: Hub, key: string, value: string): void {
  decisions(hub).record({ key, scope: { kind: "global" }, value }, { source: "human", by: "human:desk" });
}

const say = (hub: Hub, author: "human" | "lead", text: string) => chat(hub).add(PROJECT, { author, text });

const lines = (hub: Hub): ChatMessage[] =>
  hub.db.all<{ data: string }>("SELECT data FROM chat_messages WHERE machine_id = ? AND project_id = ? ORDER BY seq", [PROJECT.machineId, PROJECT.projectId]).map(
    (r) => JSON.parse(r.data) as ChatMessage,
  );

const refreshed = (hub: Hub) => lines(hub).filter((m) => m.memoryRefreshed !== undefined);

const memoryMd = (hub: Hub) => Memory.of(hub).read(projectTarget(PROJECT));

function complete(hub: Hub, thread: string): void {
  events(hub).append({ at: isoMs(hub.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, projectId: PROJECT.projectId, threadId: thread, summary: "completed", data: { threadId: thread } });
}

/** A call of the refresh session, as the hub takes it from a `memory_refresh` caller. */
const refreshCall = (hub: Hub, op: string, args: Record<string, unknown>) =>
  answer(hub, { projectRef: PROJECT, by: `lead:${PROJECT.machineId}/${PROJECT.projectId}`, agent: { kind: "memory_refresh" } }, { op, ...args } as LeadCall);

test("the night is due from its hour for three hours in the zone", () => {
  const four = { hour: 4, minute: 0 };
  const ms = (s: string) => Date.parse(s);
  expect(nightDue(ms("2026-10-27T03:59:00Z"), "UTC", four)).toBeUndefined();
  const night = ms("2026-10-27T04:00:00Z");
  expect(nightDue(night, "UTC", four)).toBe(night);
  expect(nightDue(ms("2026-10-27T06:59:00Z"), "UTC", four)).toBe(night);
  expect(nightDue(ms("2026-10-27T07:00:00Z"), "UTC", four)).toBeUndefined();
  // 04:00 in Berlin (CET, after the clocks went back) is 03:00 UTC.
  expect(nightDue(ms("2026-10-27T03:30:00Z"), "Europe/Berlin", four)).toBe(ms("2026-10-27T03:00:00Z"));
  expect(nightDue(ms("2026-10-27T00:30:00Z"), "UTC", four)).toBeUndefined();
  // Berlin's clocks skip 02:00-03:00 on 2026-03-29: a 02:30 night runs at 03:00 CEST (01:00 UTC), not never.
  const gap = { hour: 2, minute: 30 };
  expect(nightDue(ms("2026-03-29T00:59:00Z"), "Europe/Berlin", gap)).toBeUndefined();
  const after = ms("2026-03-29T01:00:00Z");
  expect(nightDue(after, "Europe/Berlin", gap)).toBe(after);
  expect(nightDue(ms("2026-03-29T03:59:00Z"), "Europe/Berlin", gap)).toBe(after);
});

test("a node that can't hold the session to its memory tools gets no refresh, and one line a night", async () => {
  const { hub, clock, node } = setup();
  say(hub, "human", "Keep answers short.");
  node.caps.clear();
  const skipped = () => lines(hub).filter((m) => m.text === `Memory refresh skipped: update ${PROJECT.machineId} to let it run`).length;
  for (let i = 0; i < 3; i++) {
    await tick(hub);
    clock.ms += 60_000;
  }
  expect(node.launches).toEqual([]);
  expect(skipped()).toBe(1);
  clock.ms += DAY;
  say(hub, "human", "Still short, please.");
  await tick(hub);
  await tick(hub);
  expect(skipped()).toBe(2);
  node.caps.add(CAP_ALLOWED_ONLY);
  await tick(hub);
  expect(node.launches.length).toBe(1);
  expect(skipped()).toBe(2);
});

test("a quiet project gets no refresh and no line; the setting turns it off", async () => {
  const { hub, node } = setup();
  // A line of fleetd's own is not activity.
  chat(hub).systemLine(PROJECT, "PR #4 merged");
  await tick(hub);
  expect(node.launches).toEqual([]);
  expect(refreshed(hub)).toEqual([]);
  expect(job(hub, PROJECT).lastRun?.state).toBe("skipped");

  hub.db.conn.query("DELETE FROM memory_refreshes").run();
  hub.db.conn
    .query("INSERT INTO project_settings (machine_id, project_id, memory_refresh) VALUES (?, ?, 0) ON CONFLICT DO UPDATE SET memory_refresh = 0")
    .run(PROJECT.machineId, PROJECT.projectId);
  expect(projectSettings(hub).memoryRefresh(PROJECT)).toBe(false);
  say(hub, "human", "From now on, no npm here: pnpm only.");
  await tick(hub);
  expect(node.launches).toEqual([]);
  hub.db.conn.query("UPDATE project_settings SET memory_refresh = 1").run();
  await tick(hub);
  expect(node.launches.length).toBe(1);
});

test("an active project gets one session that reads its chat, memory and decisions, and opens no order", async () => {
  const { hub, clock, node } = setup();
  Memory.of(hub).set(projectTarget(PROJECT), "- Deploys freeze on Fridays.\n");
  say(hub, "human", "The Friday freeze is over since the launch.");
  say(hub, "lead", "Noted: deploys any day now.");
  await tick(hub);
  expect(node.launches.length).toBe(1);
  const input = node.launches[0]!;
  expect(input.title).toBe("fleetd memory refresh: Shop");
  expect(input.runtimeMode).toBe("approval-required");
  expect(input.clientRequestId).toBe(`fleetd-memory:${PROJECT.machineId}/${PROJECT.projectId}:${Date.parse("2026-10-27T04:00:00Z")}`);
  for (const needle of [
    "tonight's memory refresh",
    "Only `memory_read`, `remember` and `forget`",
    "- Deploys freeze on Fridays.",
    "Human: The Friday freeze is over since the launch.",
    "Lead: Noted: deploys any day now.",
    "## Active decisions\n- D",
    "policy.tz: UTC",
  ]) {
    expect(input.prompt).toContain(needle);
  }
  expect(node.options[0]).toMatchObject({ role: "lead", mcpRole: "lead", mcp: { userServers: false, servers: [] }, onlyTools: ["mcp__fleetd__memory_read", "mcp__fleetd__remember", "mcp__fleetd__forget"] });
  expect(hub.db.all("SELECT 1 FROM workstreams")).toEqual([]);
  expect(lines(hub).length).toBe(2);
  clock.ms += 60_000;
  await tick(hub);
  expect(node.launches.length).toBe(1);
});

test("a refresh posts one line with its changes once it ends, and nothing on a quiet night", async () => {
  const { hub, clock, node } = setup();
  Memory.of(hub).set(projectTarget(PROJECT), "- Deploys freeze on Fridays.\n- Use npm.\n- Run the e2e suite before a release.\n");
  say(hub, "human", "No npm here, pnpm only. The Friday freeze is over.");
  await tick(hub);
  await refreshCall(hub, "remember", { scope: "project", text: "Staging deploys need the VPN." });
  await refreshCall(hub, "remember", { scope: "project", text: "No npm: use pnpm.", replaces: "Use npm" });
  await refreshCall(hub, "forget", { scope: "project", entry: "Friday", reason: "The freeze ended." });
  expect(memoryMd(hub)).toBe("- No npm: use pnpm.\n- Run the e2e suite before a release.\n- Staging deploys need the VPN.\n");
  expect(lines(hub).length).toBe(1);
  expect(job(hub, PROJECT).lastRun).toMatchObject({ state: "running", added: 1, replaced: 1, removed: 1 });

  complete(hub, "refresh-1");
  await tick(hub);
  const posted = refreshed(hub);
  expect(posted.length).toBe(1);
  expect(posted[0]!.text).toBe("Memory refreshed: +1 ~1 −1");
  expect(posted[0]!.author).toBe("system");
  const items = posted[0]!.memoryRefreshed!.items;
  expect(items[1]!.replaced).toBe("Use npm.");
  expect(items[2]!.forgotten).toBe(true);
  expect(job(hub, PROJECT).lastRun).toMatchObject({ state: "done", trigger: "schedule", added: 1, replaced: 1, removed: 1 });
  expect(hub.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM memory_refresh_lines")[0]!.n).toBe(1);

  // The next night has nothing new: no session, no line.
  clock.ms += DAY;
  await tick(hub);
  expect(node.launches.length).toBe(1);
  expect(refreshed(hub).length).toBe(1);
});

test("a session past its hour, or one that failed, is stopped and its changes still posted", async () => {
  const { hub, clock, node } = setup();
  say(hub, "human", "We moved to pnpm.");
  await tick(hub);
  await refreshCall(hub, "remember", { scope: "project", text: "pnpm, never npm." });
  clock.ms += 3_600_000 + 60_000;
  await tick(hub);
  expect(node.stops).toEqual(["refresh-1"]);
  expect(refreshed(hub)[0]!.text).toBe("Memory refreshed: +1");
  const last = job(hub, PROJECT).lastRun!;
  expect(last.state).toBe("failed");
  expect(last.why).toContain("the next one reads the same chat again");
  // Failed: the same chat is read again the next night.
  clock.ms += DAY - 3_600_000 - 60_000;
  await tick(hub);
  expect(node.launches.length).toBe(2);
  expect(node.launches[1]!.prompt).toContain("Human: We moved to pnpm.");
});

test("the row lists its hour, next night and last run; Run now is held by the night's rules", async () => {
  const { hub, clock, node } = setup();
  global(hub, "policy.memory_refresh_at", "05:30");
  const row = job(hub, PROJECT);
  expect(row).toMatchObject({ on: true, at: "05:30", tz: "UTC", nextRunAt: "2026-10-27T05:30:00.000Z" });
  expect(row.lastRun).toBeUndefined();
  expect(await runNow(hub, PROJECT)).toBe("Nothing new in the chat or its orders since the last refresh.");
  say(hub, "human", "Tabs, not spaces.");
  node.caps.clear();
  expect(await runNow(hub, PROJECT)).toBe(`Its node is too old: update ${PROJECT.machineId} to let it run.`);
  node.caps.add(CAP_ALLOWED_ONLY);
  expect(await runNow(hub, PROJECT)).toBeUndefined();
  expect(node.launches[0]!.clientRequestId).toBe(`fleetd-memory:${PROJECT.machineId}/${PROJECT.projectId}:${clock.ms}`);
  expect(job(hub, PROJECT).lastRun).toMatchObject({ trigger: "manual", state: "running" });
  expect(await runNow(hub, PROJECT)).toBe("A refresh is already running.");
  expect(await runNow(hub, { ...PROJECT, projectId: "gone" })).toBe(`There is no project ${PROJECT.machineId}/gone.`);
  hub.db.conn.query("INSERT INTO project_settings (machine_id, project_id, memory_refresh) VALUES (?, ?, 0) ON CONFLICT DO UPDATE SET memory_refresh = 0").run(PROJECT.machineId, PROJECT.projectId);
  expect(job(hub, PROJECT).nextRunAt).toBeUndefined();

  // The tool answers with the row, and why when nothing started.
  const tools = new Map<string, (hub: Hub, c: unknown, input: unknown) => unknown>();
  registerImportAndRefresh({ add: (n: string, h: never) => tools.set(n, h) } as unknown as Registry);
  const out = (await tools.get("memory_refresh_run")!(hub, caller("operate", true), { projectRef: PROJECT })) as Record<string, unknown>;
  expect(out.why).toBe("It is off for this project: turn it on first.");
  expect(out.next).toBe("Nothing started; the nightly pass goes on as before.");
  expect((out.memoryRefresh as { on: boolean }).on).toBe(false);
  expect(() => tools.get("memory_refresh_run")!(hub, caller("read", true), { projectRef: PROJECT })).toThrow("no operate grant");
});

test("a launch that fails is the row's failed run, tried again the next night", async () => {
  const { hub, clock, node } = setup();
  refreshPorts(hub).launcher = {
    launch: async () => {
      throw new Error("the runner is logged out");
    },
    stop: async () => {},
  };
  say(hub, "human", "Prefer short commits.");
  await tick(hub);
  expect(job(hub, PROJECT).lastRun).toMatchObject({ state: "failed", why: "It didn't start: the runner is logged out" });
  clock.ms += 60_000;
  await tick(hub);
  expect(node.launches).toEqual([]);
  expect(events(hub).page(0, ["memory.refresh"]).events.length).toBe(1);
});

// ---- import ----

/** A person with an Only me project of their own on the test machine, and the import's turn as `reply`. */
function importSetup(reply: (input: LaunchInput) => string) {
  const t = setup();
  const hub = t.hub;
  hub.db.conn.query("INSERT INTO people (person_id, name, role, created_ms) VALUES ('pe_ada00001', 'Ada', 'owner', 0)").run();
  putNavi(hub.db.conn, PROJECT, { keyId: "key_h", name: "Ada's phone" }, "pe_ada00001", NIGHT_MS);
  const turns: LaunchInput[] = [];
  const turn: Turn = {
    async run(_r, person, input, options) {
      expect(person).toBe("pe_ada00001");
      expect(options).toMatchObject({ role: "plain", onlyTools: [], mcp: { userServers: false, servers: [] } });
      turns.push(input);
      return reply(input);
    },
  };
  importPorts(hub).turn = turn;
  const tools = new Map<string, (hub: Hub, c: unknown, input: unknown) => unknown>();
  registerImportAndRefresh({ add: (n: string, h: never) => tools.set(n, h) } as unknown as Registry);
  const ada = caller("operate", true, { personId: "pe_ada00001", name: "Ada" });
  const imported = (text?: string) => tools.get("memory_import")!(hub, ada, text === undefined ? {} : { text }) as Promise<Record<string, unknown>>;
  const mine = () => Memory.of(hub).read(userTarget("pe_ada00001"));
  return { ...t, turns, imported, mine };
}

test("without text, memory_import gives the export prompt", async () => {
  const { imported, turns } = importSetup(() => "");
  const out = await imported();
  expect(out.prompt).toContain("memory");
  expect(out.added).toEqual([]);
  expect(out.next).toBe("Copy the prompt into your other assistant, then call again with its answer as text.");
  expect(turns).toEqual([]);
});

test("an export becomes entries of the person's own memory, secrets and duplicates skipped", async () => {
  const reply = JSON.stringify({
    entries: [
      { kind: "project", text: "[2025-03-01] - Works on a Rust CLI called fleetd." },
      { kind: "instruction", text: "Answer in short paragraphs." },
      { kind: "preference", text: "answer in short paragraphs." },
      { kind: "identity", text: "Their API key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
      { kind: "preference", text: "Prefers pnpm.", replaces: "Prefers npm." },
    ],
  });
  const { imported, turns, mine, hub } = importSetup(() => `Here you go:\n\`\`\`json\n${reply}\n\`\`\``);
  Memory.of(hub).set(userTarget("pe_ada00001"), "- Prefers npm.\n");
  const out = await imported("ChatGPT said: …\n===== export 00 =====");
  const input = turns[0]!;
  expect(input.title).toBe("fleetd memory import");
  expect(input.clientRequestId).toStartWith("fleetd-memory-import:pe_ada00001:");
  expect(input.prompt).toContain("## The person's memory now\n- Prefers npm.");
  expect(input.prompt).toMatch(/===== export [0-9a-f]{24} =====\nChatGPT said/);
  expect(out.added).toEqual([{ text: "Answer in short paragraphs." }, { text: "Prefers pnpm.", replaced: "Prefers npm." }, { text: "Works on a Rust CLI called fleetd." }]);
  expect((out.skipped as { why: string }[]).map((s) => s.why)).toEqual(["secret"]);
  expect(mine()).toBe("- Prefers pnpm.\n- Answer in short paragraphs.\n- Works on a Rust CLI called fleetd.\n");
  expect(out.next).toBe("Added 3 to your memory.");
  expect(events(hub).page(0, ["memory.changed"]).events.length).toBe(1);
});

test("an answer that isn't entries adds nothing; a failed turn says so", async () => {
  let answer = "I can't help with that.";
  const { imported, mine } = importSetup(() => {
    if (answer === "throw") throw new Error("the session ended early");
    return answer;
  });
  await expect(imported("stuff")).rejects.toThrow("couldn't be read as memory entries");
  answer = "throw";
  await expect(imported("stuff")).rejects.toThrow("The import didn't finish: the session ended early.");
  expect(mine()).toBe("");
});

test("it runs only in the person's own Only me project", async () => {
  const { hub, imported } = importSetup(() => '{"entries":[]}');
  hub.db.conn.query("UPDATE project_settings SET owner_person = 'pe_someone1'").run();
  await expect(imported("stuff")).rejects.toThrow("you have none yet");
  hub.db.conn.query("UPDATE project_settings SET owner_person = 'pe_ada00001'").run();
  const out = await imported("stuff");
  expect(out.next).toBe("Nothing new to add: your memory already says it all.");
});

test("clean and parse read what other assistants write", () => {
  expect(clean("- [unknown] - Likes tea.")).toBe("Likes tea.");
  expect(clean("[2024-01-02]   Uses   vim")).toBe("Uses vim");
  expect(clean("[note] keep")).toBe("[note] keep");
  expect(parse('x {"entries":[{"text":"a","kind":"preference"}]} y')).toEqual([{ text: "a", kind: "preference" }]);
  expect(parse('{"entries":[{"kind":"x"}]}')).toBeUndefined();
});

test("by default the refresh launches through the executor, and the import runs the executor's turn", async () => {
  const t = testHub(NIGHT_MS);
  cleanup = t.done;
  const hub = t.hub;
  global(hub, "policy.tz", "UTC");
  Object.assign(refreshPorts(hub), { can: () => true, lacks: () => false });
  expect(importPorts(hub).turn).toBeInstanceOf(ExecutorTurn);
  say(hub, "human", "Short answers.");
  // No node is linked: the executor's launch refuses, and the row says so.
  await tick(hub);
  const last = job(hub, PROJECT).lastRun!;
  expect(last.state).toBe("failed");
  expect(last.why).toStartWith("It didn't start: ");
  expect(last.why).not.toContain("not ported");
});

test("automation_list carries the refresh's row for a project the hub knows", async () => {
  const { hub } = setup();
  const tools = new Map<string, (hub: Hub, c: unknown, input: unknown) => unknown>();
  registerAutomationTools({ add: (n: string, h: never) => tools.set(n, h) } as unknown as Registry);
  const listed = (r: typeof PROJECT) => tools.get("automation_list")!(hub, caller("read", true), { projectRef: r }) as Record<string, unknown>;
  expect(listed(PROJECT).memoryRefresh).toMatchObject({ on: true, at: "04:00", tz: "UTC", nextRunAt: "2026-10-28T04:00:00.000Z" });
  expect(listed({ ...PROJECT, projectId: "gone" }).memoryRefresh).toBeUndefined();
});
