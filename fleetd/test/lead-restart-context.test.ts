// A restarted or switched lead keeps its context (W844): a restart mid-turn marks the person's messages it left
// unanswered and waits (bounded) for the stopped turn's end to be followed; a new session's first state is clean of
// the old session's wake cutoff, which a failed fresh start keeps; the recap keeps whole messages, ids, orders, replies,
// system and approval lines and blocks by their caption; and the lead's state flags open orders idle past 30 minutes.
import { afterEach, expect, test } from "bun:test";
import { run } from "../src/hub/chat/flow.ts";
import { chat } from "../src/hub/chat/index.ts";
import { executors } from "../src/hub/executor/index.ts";
import { LEAD_FRESH_AFTER_MS, leads } from "../src/hub/leads/index.ts";
import { start } from "../src/hub/leads/loops.ts";
import { leadWiring } from "../src/hub/leads/ports.ts";
import { STALLED_MS, stalledLines } from "../src/hub/leads/stalled_rules.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { ThreadRef } from "../src/shared/contracts.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0).reverse()) done();
});

/** A hub with a started lead and fake ports: the prompts its leads were launched with. */
async function rig() {
  const t = testHub();
  cleanups.push(() => {
    t.hub.shutdown.abort();
    t.done();
  });
  start(t.hub);
  const prompts: string[] = [];
  const interrupted: string[] = [];
  Object.assign(leadWiring(t.hub).ports, {
    launch: async (_machineId: string, input: { prompt: string }) => {
      prompts.push(input.prompt);
      return `lead-${prompts.length}`;
    },
    send: async () => false,
    interrupt: async (thread: ThreadRef) => void interrupted.push(thread.threadId),
  });
  await leads(t.hub).start(PROJECT);
  return { ...t, prompts, interrupted };
}

/** The lead's thread as its node last reported it. */
function threadIs(t: Awaited<ReturnType<typeof rig>>, status: "idle" | "running" | "interrupted") {
  const { threadId } = leads(t.hub).records.leadGet(PROJECT)!;
  const at = isoMs(t.clock.now());
  store(t.hub).threadUpsert({
    thread: { machineId: PROJECT.machineId, threadId, projectId: PROJECT.projectId, title: "lead", status, headline: "", latestMessageTail: "", lastProgressAt: at, stale: false, asOf: at } as never,
  });
  return threadId;
}

const until = async (what: () => boolean) => {
  for (let i = 0; i < 400 && !what(); i++) await Bun.sleep(5);
  expect(what()).toBe(true);
};

test("Restart lead mid-turn marks the person's message it never answered, and asks for an answer", async () => {
  const t = await rig();
  chat(t.hub).add(PROJECT, { author: "human", text: "is the docs page gone?" });
  t.clock.ms += 60_000;
  chat(t.hub).add(PROJECT, { author: "lead", text: "Yes: it moved to /docs/start." });
  t.clock.ms += 60_000;
  const { message } = chat(t.hub).add(PROJECT, { author: "human", text: "then fix the link in the README" });
  threadIs(t, "running");
  (leads(t.hub) as unknown as { settleMs: number }).settleMs = 20;
  await leads(t.hub).switchSoon(PROJECT);
  await until(() => t.prompts.length === 2);
  const prompt = t.prompts[1]!;
  // The answered message reads as it did; the one the stopped turn never answered is marked.
  expect(prompt).toMatch(/^Human \([^)]*\): is the docs page gone\?$/m);
  expect(prompt).not.toMatch(/^Human \([^)]*unanswered\): is the docs page gone\?$/m);
  expect(prompt).toMatch(new RegExp(`^Human \\([^)]*${message.messageId}; unanswered\\): then fix the link in the README$`, "m"));
  expect(prompt).not.toContain("the chat messages above were already seen and handled");
  expect(prompt).toContain("marked unanswered above still wait for your answer, so answer them now");
});

test("a restart while the lead is idle and answered says the chat was handled", async () => {
  const t = await rig();
  chat(t.hub).add(PROJECT, { author: "human", text: "is the docs page gone?" });
  t.clock.ms += 60_000;
  chat(t.hub).add(PROJECT, { author: "lead", text: "Yes: it moved to /docs/start." });
  await leads(t.hub).restart(PROJECT);
  expect(t.prompts[1]).not.toContain("unanswered");
  expect(t.prompts[1]).toContain("the chat messages above were already seen and handled");
});

test("Restart lead mid-turn starts the new session once the stopped turn's end was followed, not before", async () => {
  const t = await rig();
  executors(t.hub).views.messages = async () => [];
  executors(t.hub).views.runs = async () => [];
  void run(t.hub);
  await Bun.sleep(20);
  const old = threadIs(t, "running");
  let endedAtLaunch: boolean | undefined;
  const ended = () => events(t.hub).page(0).events.some((e) => e.type === "thread.interrupted" && e.threadId === old);
  const ports = leadWiring(t.hub).ports;
  const launch = ports.launch;
  ports.launch = async (...args) => {
    endedAtLaunch = ended();
    return launch(...args);
  };
  // The node stops the turn a moment after it is asked, as a real one does.
  ports.interrupt = async () => {
    setTimeout(() => {
      threadIs(t, "interrupted");
      events(t.hub).append({ at: isoMs(t.clock.now()), type: "thread.interrupted", machineId: PROJECT.machineId, threadId: old, summary: "" });
    }, 40);
  };
  await leads(t.hub).switchSoon(PROJECT);
  await until(() => t.prompts.length === 2);
  expect(endedAtLaunch).toBe(true);
});

test("a stopped turn whose end never comes holds the new session back only for the bound", async () => {
  const t = await rig();
  threadIs(t, "running");
  (leads(t.hub) as unknown as { settleMs: number }).settleMs = 50;
  const at = Date.now();
  await leads(t.hub).switchSoon(PROJECT);
  await until(() => t.prompts.length === 2);
  expect(Date.now() - at).toBeGreaterThanOrEqual(45);
});

test("a switched lead's first state is built clean, not from the old session's last wake", async () => {
  const t = await rig();
  const seen: (string | undefined)[] = [];
  leadWiring(t.hub).hooks.trainLines = (_r, since) => {
    seen.push(since);
    return undefined;
  };
  const lead = leads(t.hub).records.leadGet(PROJECT)!;
  leads(t.hub).records.leadPut({ ...lead, lastWakeAt: "2026-11-08T10:30:00.000Z" });
  await leads(t.hub).restart(PROJECT);
  expect(seen).toEqual([undefined]);
  expect(leads(t.hub).records.leadGet(PROJECT)?.lastWakeAt).toBeUndefined();
});

test("a fresh start that fails keeps the old session's last wake", async () => {
  const t = await rig();
  threadIs(t, "idle");
  const lead = leads(t.hub).records.leadGet(PROJECT)!;
  leads(t.hub).records.leadPut({ ...lead, lastWakeAt: "2026-11-08T10:00:00.000Z" });
  t.clock.ms += LEAD_FRESH_AFTER_MS + 1;
  leadWiring(t.hub).ports.launch = async () => {
    throw new Error("machine lab-a has no live node link");
  };
  await expect(leads(t.hub).freshIfDue(PROJECT, "Human: hello")).rejects.toThrow("no live node link");
  expect(leads(t.hub).records.leadGet(PROJECT)?.lastWakeAt).toBe("2026-11-08T10:00:00.000Z");
});

test("the recap keeps long messages whole, ids, orders, replies, approval and system lines, and blocks by caption", async () => {
  const t = await rig();
  const proposal = `Here is the plan:\n${"1. a step of the plan, said in full. ".repeat(30)}\nShall I go?`;
  const about = { workstreamId: "W7", title: "Docs" };
  const lead = chat(t.hub).add(PROJECT, { author: "lead", text: proposal, about }).message;
  t.clock.ms += 1000;
  chat(t.hub).add(PROJECT, {
    author: "lead",
    text: 'Pick one:\n\n```fleetd-block\n{"v":1,"kind":"ask","question":"Ship it today?","options":["Yes","Later"]}\n```',
  });
  t.clock.ms += 1000;
  chat(t.hub).item(PROJECT, {
    kind: "command_approval",
    requestId: "q1",
    machineId: PROJECT.machineId,
    gated: { argv: ["gh", "workflow", "run", "deploy"], class: "deploy", reason: "Deploy the docs", timeoutSec: 600 },
    state: "approved",
    by: "Ada",
  } as never);
  t.clock.ms += 1000;
  chat(t.hub).add(PROJECT, { author: "system", text: "Added the repo api" });
  t.clock.ms += 1000;
  chat(t.hub).add(PROJECT, { author: "human", text: "yes go", replyTo: { messageId: lead.messageId, part: 0 }, about });
  t.clock.ms += 1000;
  chat(t.hub).add(PROJECT, { author: "lead", text: "Started." });
  await leads(t.hub).restart(PROJECT);
  const prompt = t.prompts[1]!;
  expect(prompt).toContain(proposal);
  expect(prompt).toContain(`You (`);
  expect(prompt).toMatch(new RegExp(`^You \\([^)]*; ${lead.messageId}; W7\\): Here is the plan:$`, "m"));
  expect(prompt).toMatch(new RegExp(`^Human \\([^)]*; W7; replying to ${lead.messageId}\\): yes go$`, "m"));
  expect(prompt).toContain("[ask: Ship it today? (options: Yes / Later)]");
  expect(prompt).not.toContain('"kind":"ask"');
  expect(prompt).toMatch(/^System \([^)]*\): approval for `gh workflow run deploy` \(Deploy the docs\): approved by Ada$/m);
  expect(prompt).toMatch(/^System \([^)]*\): Added the repo api$/m);
});

test("the recap stays bounded: the oldest lines go first", async () => {
  const t = await rig();
  for (let i = 0; i < 30; i++) {
    chat(t.hub).add(PROJECT, { author: "human", text: `message ${i} ${"x".repeat(1000)}` });
    t.clock.ms += 1000;
  }
  await leads(t.hub).restart(PROJECT);
  const recap = t.prompts[1]!.slice(t.prompts[1]!.indexOf("## Recent chat"));
  expect(recap.length).toBeLessThan(14_000);
  expect(recap).toContain("message 29 ");
  expect(recap).not.toContain("message 0 ");
});

test("the lead's state flags each open order with nothing running for more than 30 minutes", async () => {
  const t = await rig();
  const r = leads(t.hub).records;
  const at = isoMs(t.clock.now());
  const idle = r.workstreamCreate({ projectRef: PROJECT, title: "Idle order", text: "idle", channel: "app", by: "human", at }).workstream;
  const busy = r.workstreamCreate({ projectRef: PROJECT, title: "Busy order", text: "busy", channel: "app", by: "human", at }).workstream;
  t.hub.db.conn
    .query("INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES (?, ?, ?, 'running', ?)")
    .run(PROJECT.machineId, PROJECT.projectId, busy.workstreamId, JSON.stringify({ projectRef: PROJECT, workstreamId: busy.workstreamId, state: "running" }));
  expect(leads(t.hub).wakes.digest(PROJECT)).not.toContain("nothing running since");
  t.clock.ms += 31 * 60_000;
  const fresh = r.workstreamCreate({ projectRef: PROJECT, title: "New order", text: "new", channel: "app", by: "human", at: isoMs(t.clock.now()) }).workstream;
  const digest = leads(t.hub).wakes.digest(PROJECT);
  expect(digest).toContain(`${idle.workstreamId} open, nothing running since 2026-11-08 10:00 UTC`);
  expect(digest).not.toContain(`${busy.workstreamId} open, nothing running`);
  expect(digest).not.toContain(`${fresh.workstreamId} open, nothing running`);
  // At the top: before the Work section.
  expect(digest.indexOf("nothing running since")).toBeLessThan(digest.indexOf("## Work"));
});

test("the stalled-order rules alone, as fleetd cloud calls them: busy, recent and asked-of-the-person orders get no line", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const ago = (min: number) => now - min * 60_000;
  const lines = stalledLines(
    [
      { workstreamId: "W1", lastMovedMs: ago(45), busy: false },
      { workstreamId: "W2", lastMovedMs: ago(600), busy: false },
      { workstreamId: "W3", lastMovedMs: ago(600), busy: true },
      { workstreamId: "W4", lastMovedMs: ago(20), busy: false },
      { workstreamId: "W5", lastMovedMs: ago(600), busy: false },
    ],
    [{ workstreamId: "W5" } as never],
    now,
  );
  expect(lines).toEqual(["W2 open, nothing running since 2026-11-23 02:00 UTC", "W1 open, nothing running since 2026-11-23 11:15 UTC"]);
  expect(STALLED_MS).toBe(30 * 60_000);
});
