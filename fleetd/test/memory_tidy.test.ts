// A person's own memory: its topic files, the tidy that runs once a night after the bots' refreshes and soon after a
// write past a cap, the one line it posts and its exact Undo (src/hub/memory/tidy.ts, index.ts, calls.ts, tools.ts).
// The sessions are fakes: a launcher of the test's own, a fresh home under $TMPDIR, a fake clock.
import { afterEach, expect, test } from "bun:test";
import type { Hub } from "../src/hub/api/hub.ts";
import type { Registry } from "../src/hub/api/registry.ts";
import { chat } from "../src/hub/chat/index.ts";
import { decisions } from "../src/hub/ledger/decisions.ts";
import { answer } from "../src/hub/memory/calls.ts";
import { Memory, userTarget } from "../src/hub/memory/index.ts";
import { refreshPorts, tick as refreshTick } from "../src/hub/memory/refresh.ts";
import { tick } from "../src/hub/memory/tidy.ts";
import { TIDY_DEBOUNCE_MS, tidyChatLine } from "../src/hub/memory/tidy_rules.ts";
import { getTidy } from "../src/hub/memory/tidy_store.ts";
import { register } from "../src/hub/memory/tools.ts";
import { Registry as ToolRegistry } from "../src/hub/api/registry.ts";
import { checkCall } from "../src/hub/lead_calls/policy.ts";
import type { LaunchInput } from "../src/hub/executor/sessions.ts";
import type { LeadCall } from "../src/hub/leads/seams.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { ChatMessage, ProjectSummary } from "../src/shared/contracts.ts";
import { CAP_ALLOWED_ONLY } from "../src/shared/node_link.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

/** 2026-10-27 04:10 UTC: ten minutes into the night's window. */
const NIGHT_MS = 1_793_074_200_000;
const ADA = { personId: "pe_ada00001", name: "Ada" };
const BEN = { personId: "pe_ben00001", name: "Ben" };

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** A hub at NIGHT_MS in UTC with Ada (and Ben, with `both`), its node linked, and a launcher that records each start. */
function setup(both = false) {
  const t = testHub(NIGHT_MS);
  cleanup = t.done;
  const hub = t.hub;
  decisions(hub).record({ key: "policy.tz", scope: { kind: "global" }, value: "UTC" }, { source: "human", by: "human:desk" });
  for (const p of both ? [ADA, BEN] : [ADA]) {
    hub.db.conn.query("INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, 'owner', 0)").run(p.personId, p.name);
  }
  const launches: LaunchInput[] = [];
  Object.assign(refreshPorts(hub), {
    launcher: {
      async launch(_m: string, input: LaunchInput) {
        launches.push(input);
        return `session-${launches.length}`;
      },
      async stop() {},
    },
    can: (_m: string, cap: string) => cap === CAP_ALLOWED_ONLY,
    lacks: (_m: string, cap: string) => cap !== CAP_ALLOWED_ONLY,
  });
  const tools = new Map<string, (hub: Hub, c: unknown, input: unknown) => unknown>();
  register({ add: (n: string, h: never) => tools.set(n, h) } as unknown as Registry);
  const ada = caller("operate", true, ADA);
  const tool = (name: string, input: unknown, as: unknown = ada) => tools.get(name)!(hub, as, input) as Record<string, unknown>;
  return { ...t, launches, tool };
}

const mine = (hub: Hub, topic?: string) => Memory.of(hub).read(userTarget(ADA.personId, topic));
const put = (hub: Hub, text: string, topic?: string) => Memory.of(hub).set(userTarget(ADA.personId, topic), text);

const says = (hub: Hub, who: typeof ADA, text: string) => chat(hub).add(PROJECT, { author: "human", text, person: who });

/** A call of Ada's tidy session, as the hub takes it from its caller. */
const tidyCall = (hub: Hub, op: string, args: Record<string, unknown>) => {
  const agent = { kind: "memory_refresh" as const, person: ADA.personId };
  const call = { op, ...args } as LeadCall;
  checkCall(agent, call);
  return answer(hub, { projectRef: PROJECT, by: "fleetd:memory-tidy", agent }, call);
};

/** A call of a lead answering Ada, the hub's one person. */
const leadCall = (hub: Hub, op: string, args: Record<string, unknown>) =>
  answer(hub, { projectRef: PROJECT, by: `lead:${PROJECT.machineId}/${PROJECT.projectId}`, agent: { kind: "lead" } }, { op, ...args } as LeadCall);

function complete(hub: Hub, thread: string): void {
  events(hub).append({ at: isoMs(hub.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, projectId: PROJECT.projectId, threadId: thread, summary: "completed", data: { threadId: thread } });
}

const refreshedLines = (hub: Hub): ChatMessage[] =>
  hub.db
    .all<{ data: string }>("SELECT data FROM chat_messages ORDER BY seq")
    .map((r) => JSON.parse(r.data) as ChatMessage)
    .filter((m) => m.memoryRefreshed !== undefined);

/** The night's bot refresh and the tidy after it: the bot's session starts, ends, then Ada's tidy starts. */
async function toTheTidy(hub: Hub, launches: LaunchInput[]): Promise<LaunchInput> {
  await refreshTick(hub);
  await tick(hub);
  expect(launches.map((l) => l.title)).toEqual(["fleetd memory refresh: Shop"]);
  complete(hub, "session-1");
  await refreshTick(hub);
  await tick(hub);
  expect(launches.length).toBe(2);
  return launches[1] as LaunchInput;
}

test("user memory has topic files: remember, memory_read and forget take one, and the core lists it", () => {
  const { hub, tool } = setup();
  put(hub, "- Keep answers short.\n");
  leadCall(hub, "remember", { scope: "user", topic: "phone", text: "Phone UI is judged on a real simulator." });
  expect(mine(hub, "phone")).toBe("- Phone UI is judged on a real simulator.\n");
  expect(mine(hub)).toBe("- Keep answers short.\n- [phone](phone.md)\n");
  // A later entry of the core goes above its topic lines.
  leadCall(hub, "remember", { scope: "user", text: "Plain words." });
  expect(mine(hub)).toBe("- Keep answers short.\n- Plain words.\n- [phone](phone.md)\n");
  expect(leadCall(hub, "memory_read", { scope: "user", topic: "phone" }).text).toBe("- Phone UI is judged on a real simulator.\n");
  // Without scope it is the bot's topic, which has none.
  expect(leadCall(hub, "memory_read", { topic: "phone" }).text).toBe("");
  expect(() => leadCall(hub, "remember", { scope: "user", topic: "user", text: "x" })).toThrow("core of user memory");

  // Settings > Memory shows the core and each topic, and edits a topic as a file.
  const got = tool("memory_get", {});
  expect((got.user as { text: string }).text).toContain("Plain words.");
  expect((got.userFiles as { topic: string; text: string; cap: number }[]).map((f) => [f.topic, f.cap])).toEqual([["phone", 32_000]]);
  tool("memory_set", { scope: "user", topic: "release", text: "- Tag from main only.\n" });
  expect(mine(hub, "release")).toBe("- Tag from main only.\n");
  expect(mine(hub)).toContain("- [release](release.md)");

  leadCall(hub, "forget", { scope: "user", topic: "phone", entry: "real simulator" });
  expect(mine(hub, "phone")).toBe("");
  expect(mine(hub)).toBe("- Keep answers short.\n- Plain words.\n- [release](release.md)\n");
});

test("a write past the core's cap lands, and starts a tidy a minute later instead of waiting for the night", async () => {
  const { hub, clock, launches } = setup();
  hub.db.conn.query("INSERT INTO memory_settings (key, value) VALUES ('user', 1000)").run();
  // Midday: no night is due.
  clock.ms = NIGHT_MS + 8 * 3_600_000;
  put(hub, `- ${"An older rule. ".repeat(70).trim()}\n`);
  says(hub, ADA, "Always write devbox, never the host's name.");
  const out = leadCall(hub, "remember", { scope: "user", text: "Always write devbox, never the host's name." });
  expect(out.next).toContain("Remembered in user.md");
  expect(mine(hub)).toContain("Always write devbox");
  expect(getTidy(hub.db, ADA.personId).dueMs).toBe(clock.ms);
  // Debounced: a burst of writes gets one tidy, after it.
  await tick(hub);
  expect(launches).toEqual([]);
  clock.ms += TIDY_DEBOUNCE_MS;
  await tick(hub);
  expect(launches.length).toBe(1);
  expect(launches[0]!.title).toBe("fleetd memory tidy: Ada");
  expect(launches[0]!.prompt).toContain("user.md (the core, read by every session) 1000");
  expect(getTidy(hub.db, ADA.personId).lastRun).toMatchObject({ trigger: "cap", state: "running" });
  // A project write past its cap is still refused.
  hub.db.conn.query("INSERT INTO memory_settings (key, value) VALUES ('index', 1000)").run();
  Memory.of(hub).set({ project: PROJECT }, `- ${"x".repeat(990)}\n`);
  expect(() => leadCall(hub, "remember", { scope: "project", effect: "none", text: "One more." })).toThrow("past its cap");
});

test("the night's tidy runs after the bots' refreshes, in the person's own bot, and reads their whole memory and own words", async () => {
  const { hub, clock, launches, tool } = setup(true);
  // Ada's own bot, where nobody else writes; Shop is shared with Ben.
  const NOTES = { machineId: PROJECT.machineId, projectId: "p2" };
  store(hub).projectsUpsertMany(PROJECT.machineId, [
    { ...NOTES, title: "Notes", workspaceRoot: "/srv/notes", lastActivityAt: isoMs(clock.ms), threads: { failed: 0, idle: 0, running: 0, waiting: 0 } } as unknown as ProjectSummary,
  ]);
  put(hub, "- Keep answers short.\n- Use npm.\n- Prefers tabs.\n- [site](site.md)\n");
  put(hub, "- Bold type, one kinetic moment.\n", "site");
  chat(hub).add(NOTES, { author: "human", text: "Notes for me.", person: ADA });
  says(hub, ADA, "No npm, pnpm only.");
  chat(hub).add(PROJECT, { author: "lead", text: "Got it, pnpm." });
  says(hub, BEN, "I like npm, Ben here.");
  // Each bot's refresh first, a minute apart; only then Ada's tidy.
  for (let i = 0; i < 2; i++) {
    await refreshTick(hub);
    await tick(hub);
    clock.ms += 60_000;
  }
  expect(launches.map((l) => l.title).sort()).toEqual(["fleetd memory refresh: Notes", "fleetd memory refresh: Shop"]);
  complete(hub, "session-1");
  events(hub).append({ at: isoMs(hub.clock.now()), type: "thread.completed", machineId: NOTES.machineId, projectId: NOTES.projectId, threadId: "session-2", summary: "completed", data: { threadId: "session-2" } });
  await refreshTick(hub);
  await tick(hub);
  expect(launches.length).toBe(3);
  const input = launches[2]!;
  expect(input.title).toBe("fleetd memory tidy: Ada");
  expect(input.projectId).toBe("p2");
  expect(input.prompt).toContain("tidying Ada's own memory");
  expect(input.prompt).toContain("Remove a rule because it didn't come up lately");
  expect(input.prompt).toContain("### user.md (core)\n- Keep answers short.");
  expect(input.prompt).toContain("### site.md (topic site)\n- Bold type, one kinetic moment.");
  expect(input.prompt).toContain("### Shop\nHuman: No npm, pnpm only.");
  // Ben wrote in Shop too: his words, and the lead's answers there, stay out of Ada's tidy.
  expect(input.prompt).not.toContain("Ben here");
  expect(input.prompt).not.toContain("Got it, pnpm.");

  // It merges and corrects; the rules nobody mentioned stay as they were.
  tidyCall(hub, "remember", { scope: "user", text: "pnpm only, never npm.", replaces: "Use npm." });
  tidyCall(hub, "remember", { scope: "user", topic: "site", text: "Keep answers short on the site too." });
  tidyCall(hub, "forget", { scope: "user", entry: "Keep answers short.", reason: "merged" });
  expect(() => tidyCall(hub, "remember", { scope: "project", text: "x" })).toThrow("only reads and writes theirs");
  expect(mine(hub)).toBe("- pnpm only, never npm.\n- Prefers tabs.\n- [site](site.md)\n");
  // Nothing goes to the chat until it ends.
  expect(refreshedLines(hub)).toEqual([]);

  events(hub).append({ at: isoMs(hub.clock.now()), type: "thread.completed", machineId: NOTES.machineId, projectId: NOTES.projectId, threadId: "session-3", summary: "completed", data: { threadId: "session-3" } });
  await tick(hub);
  const line = refreshedLines(hub);
  expect(line.map((m) => [m.text, m.projectRef.projectId])).toEqual([["Memory refreshed: +1 ~1 −1", "p2"]]);
  expect(line[0]!.memoryRefreshed!.items.every((i) => i.person === ADA.personId)).toBe(true);
  expect(getTidy(hub.db, ADA.personId).lastRun).toMatchObject({ state: "done", trigger: "schedule", added: 1, replaced: 1, removed: 1 });
  // Ben wrote only in the bot he shares with Ada: his tidy still runs, but its line shows on his Memory page only.
  hub.db.conn.query("INSERT INTO memory_settings (key, value) VALUES ('user', 16000) ON CONFLICT (key) DO NOTHING").run();
  Memory.of(hub).set(userTarget(BEN.personId), "- Use npm.\n");
  await tick(hub);
  expect(launches.length).toBe(4);
  expect(launches[3]!.title).toBe("fleetd memory tidy: Ben");
  expect(launches[3]!.prompt).toContain("Human: I like npm, Ben here.");
  expect(launches[3]!.prompt).not.toContain("No npm, pnpm only.");
  const benCall = (op: string, args: Record<string, unknown>) => {
    const agent = { kind: "memory_refresh" as const, person: BEN.personId };
    return answer(hub, { projectRef: PROJECT, by: "fleetd:memory-tidy", agent }, { op, ...args } as LeadCall);
  };
  benCall("remember", { scope: "user", text: "npm is fine.", replaces: "Use npm." });
  complete(hub, "session-4");
  await tick(hub);
  expect(refreshedLines(hub).length).toBe(1);
  const ben = caller("operate", true, BEN);
  const page = tool("memory_get", {}, ben).tidied as ChatMessage;
  expect(page.text).toBe("Memory refreshed: ~1");
  // An id of the chat's own shape, which memory_undo's input takes, and no chat message has.
  expect(page.messageId).toMatch(/^m[1-9][0-9]*$/);
  expect(chat(hub).byId(page.messageId)).toBeUndefined();
  // Ada sees none of it, and can't undo it.
  expect((tool("memory_get", {}).tidied as ChatMessage | undefined)?.messageId).not.toBe(page.messageId);
  expect(() => tool("memory_undo", { projectRef: page.projectRef, messageId: page.messageId })).toThrow("only they read and edit it");
  // Through the registry, as the apps call it: its input decodes, and Undo all runs.
  const decoded = new ToolRegistry();
  register(decoded);
  expect(await decoded.call(hub, caller("operate", true, BEN), "memory_undo", { projectRef: page.projectRef, messageId: page.messageId })).toEqual({ output: { ok: true } });
  expect(Memory.of(hub).read(userTarget(BEN.personId))).toBe("- Use npm.\n");
  expect((tool("memory_get", {}, ben).tidied as ChatMessage).memoryRefreshed!.items.every((i) => i.undone === true)).toBe(true);
});

test("the tidy moves and removes an entry of any length", async () => {
  const { hub, launches } = setup();
  const long = `Release steps: ${"tag, build, notarize, upload. ".repeat(60).trim()}`;
  put(hub, `- Short answers.\n- ${long}\n`);
  says(hub, ADA, "Hi.");
  await toTheTidy(hub, launches);
  tidyCall(hub, "remember", { scope: "user", topic: "release", text: long });
  tidyCall(hub, "forget", { scope: "user", entry: "Release steps:", reason: "moved to topic release" });
  expect(mine(hub)).toBe("- Short answers.\n- [release](release.md)\n");
  expect(mine(hub, "release")).toBe(`- ${long}\n`);
});

test("a tidy that can't run says why on the Memory page", async () => {
  const { hub, clock, tool } = setup();
  put(hub, "- Short answers.\n");
  says(hub, ADA, "Hi.");
  // Every bot's machine is offline: the night's tidy can't start, and is tried again on the next pass.
  Object.assign(refreshPorts(hub), { can: () => false, lacks: () => false });
  clock.ms += 2 * 3_600_000;
  await tick(hub);
  expect(tool("memory_get", {}).tidyRun).toMatchObject({ state: "failed", why: "No bot's machine can run it now: each is offline, too old or mid-turn." });
});

test("Undo all of a tidy goes item by item when something else wrote the memory while it ran, and keeps that", async () => {
  const { hub, launches, tool } = setup();
  put(hub, "- Use npm.\n- Prefers tabs.\n");
  says(hub, ADA, "pnpm, not npm.");
  await toTheTidy(hub, launches);
  tidyCall(hub, "remember", { scope: "user", text: "pnpm, never npm.", replaces: "Use npm." });
  // Meanwhile a lead remembers a rule for Ada in her chat.
  leadCall(hub, "remember", { scope: "user", text: "Short commits." });
  complete(hub, "session-2");
  await tick(hub);
  const line = tool("memory_get", {}).tidied as ChatMessage;
  tool("memory_undo", { projectRef: PROJECT, messageId: line.messageId });
  expect(mine(hub)).toBe("- Use npm.\n- Prefers tabs.\n- Short commits.\n");
});

test("the per-bot refresh still only adds to user memory; the tidy may replace and remove", () => {
  const refresh = { kind: "memory_refresh" as const };
  expect(() => checkCall(refresh, { op: "forget", scope: "user", entry: "x" } as LeadCall)).toThrow("only adds to user memory");
  expect(() => checkCall(refresh, { op: "remember", scope: "user", text: "x", replaces: "y" } as LeadCall)).toThrow("only adds to user memory");
  checkCall(refresh, { op: "remember", scope: "user", topic: "phone", text: "x" } as LeadCall);
  const tidy = { kind: "memory_refresh" as const, person: ADA.personId };
  checkCall(tidy, { op: "forget", scope: "user", entry: "x" } as LeadCall);
  expect(() => checkCall(tidy, { op: "memory_read", topic: "ci" } as LeadCall)).toThrow("only reads and writes theirs");
  expect(() => checkCall(tidy, { op: "spawn_agent" } as unknown as LeadCall)).toThrow("only reads and writes memory");
});

test("Undo all puts the person's memory back exactly as the tidy found it, and the Memory page shows the line", async () => {
  const { hub, launches, tool } = setup();
  const core = "- Keep answers short.\n- Use npm.\n- Prefers tabs.\n- Long release steps: tag, build, notarize, upload.\n";
  put(hub, core);
  says(hub, ADA, "pnpm, not npm.");
  await toTheTidy(hub, launches);
  tidyCall(hub, "remember", { scope: "user", text: "pnpm, never npm.", replaces: "Use npm." });
  tidyCall(hub, "remember", { scope: "user", topic: "release", text: "Long release steps: tag, build, notarize, upload." });
  tidyCall(hub, "forget", { scope: "user", entry: "Long release steps", reason: "moved to topic release" });
  complete(hub, "session-2");
  await tick(hub);
  expect(mine(hub)).toBe("- Keep answers short.\n- pnpm, never npm.\n- Prefers tabs.\n- [release](release.md)\n");

  const page = tool("memory_get", {});
  const line = page.tidied as ChatMessage;
  expect(line.text).toBe("Memory refreshed: +1 ~1 −1");
  // Only Ada undoes her tidy.
  expect(() => tool("memory_undo", { projectRef: PROJECT, messageId: line.messageId }, caller("operate", true, BEN))).toThrow("only they read and edit it");
  tool("memory_undo", { projectRef: PROJECT, messageId: line.messageId });
  // Byte for byte, the moved entry back in its place and the topic gone, not appended at the end.
  expect(mine(hub)).toBe(core);
  expect(mine(hub, "release")).toBe("");
  expect(Memory.of(hub).topicsOf(userTarget(ADA.personId))).toEqual([]);
  const after = (tool("memory_get", {}).tidied as ChatMessage).memoryRefreshed!;
  expect(after.items.every((i) => i.undone === true)).toBe(true);
  expect(tool("memory_undo", { projectRef: PROJECT, messageId: line.messageId }).next).toBe("Already undone.");
});

test("a night with nothing new from the person and their memory as the last tidy left it starts no tidy", async () => {
  const { hub, clock, launches } = setup();
  put(hub, "- Keep answers short.\n");
  says(hub, ADA, "Short, please.");
  await toTheTidy(hub, launches);
  complete(hub, "session-2");
  await tick(hub);
  clock.ms += 24 * 3_600_000;
  await refreshTick(hub);
  await tick(hub);
  expect(launches.length).toBe(2);
  expect(getTidy(hub.db, ADA.personId).lastRun).toMatchObject({ state: "skipped", why: "Nothing new since the last tidy." });
});

test("tidyChatLine keeps the person's words, and the lead's only where nobody else wrote", () => {
  const m = (author: "human" | "lead", person?: typeof ADA) => ({ author, text: "hi", ...(person ? { person } : {}) }) as ChatMessage;
  expect(tidyChatLine(m("human", ADA), ADA.personId, false, false)).toBe("Human: hi");
  expect(tidyChatLine(m("human", BEN), ADA.personId, false, true)).toBeUndefined();
  expect(tidyChatLine(m("lead"), ADA.personId, false, true)).toBe("Lead: hi");
  expect(tidyChatLine(m("lead"), ADA.personId, false, false)).toBeUndefined();
  // A message from before people is the one person's on a hub with only them.
  expect(tidyChatLine(m("human"), ADA.personId, true, true)).toBe("Human: hi");
  expect(tidyChatLine(m("human"), ADA.personId, false, true)).toBeUndefined();
});

test("a tidy a write asks for while no machine is up starts once one is, not an hour later", async () => {
  const { hub, clock, launches } = setup();
  hub.db.conn.query("INSERT INTO memory_settings (key, value) VALUES ('user', 1000)").run();
  clock.ms = NIGHT_MS + 8 * 3_600_000;
  says(hub, ADA, "Hi.");
  Object.assign(refreshPorts(hub), { can: () => false, lacks: () => false });
  put(hub, `- ${"An older rule. ".repeat(70).trim()}\n`);
  clock.ms += TIDY_DEBOUNCE_MS;
  await tick(hub);
  clock.ms += 60_000;
  await tick(hub);
  expect(launches).toEqual([]);
  expect(getTidy(hub.db, ADA.personId).lastRun?.state).toBe("failed");
  // The machine is back a few minutes later: the tidy starts then, the tries that couldn't start counting for nothing.
  Object.assign(refreshPorts(hub), { can: (_m: string, cap: string) => cap === CAP_ALLOWED_ONLY, lacks: () => false });
  clock.ms += 3 * 60_000;
  await tick(hub);
  expect(launches.map((l) => l.title)).toEqual(["fleetd memory tidy: Ada"]);
});
