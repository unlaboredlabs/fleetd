// The chat flow (nudges.rs, project_lead/recall.rs): chat_send starting and reaching the
// lead, chat_stop and project_stop, the stream mirror, nudge, chat_search and chat_read, chat_nudge_clear.
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { excerpt, registerLeadCalls, when } from "../src/hub/chat/calls.ts";
import { type LiveParts, since, streamPass } from "../src/hub/chat/flow.ts";
import { chat } from "../src/hub/chat/index.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import { leads } from "../src/hub/leads/index.ts";
import { start } from "../src/hub/leads/loops.ts";
import { leadWiring } from "../src/hub/leads/ports.ts";
import { type SendOpts, WriteQueue } from "../src/hub/queue/index.ts";
import { workstreams } from "../src/hub/leads/workstreams.ts";
import { events } from "../src/hub/store/events.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

function withFlow(o: { sleep?: (ms: number) => Promise<void> } = {}) {
  const t = testHub();
  const launches: string[] = [];
  const sends: { text: string; crid: string; mode?: string }[] = [];
  // The real write queue over a node writer that records what reaches the node.
  t.hub.area(
    "write_queue",
    (h) =>
      new WriteQueue(h, {
        isConnected: () => true,
        awaitLive: async () => {},
        sendWith: async (_thread, text: string, crid: string, opts: SendOpts) => {
          sends.push({ text, crid, ...(opts.mode && opts.mode !== "plain" ? { mode: opts.mode } : {}) });
          return {};
        },
      }),
  );
  // After the start, which wires the real ports: this stands in for the executor's launch.
  start(t.hub, o);
  Object.assign(leadWiring(t.hub).ports, {
    launch: async (_m: string, input: { prompt: string }) => {
      launches.push(input.prompt);
      return `lead-${launches.length}`;
    },
  });
  registerLeadCalls(t.hub);
  const tools = new Registry();
  registerAll(tools);
  const call = async (key: ReturnType<typeof caller>, tool: string, input: unknown) => {
    const out = (await tools.call(t.hub, key, tool, input)) as { output?: any; error?: { kind: string; error?: Error; message?: string } };
    if (out.error) throw new Error(out.error.error?.message ?? out.error.message ?? out.error.kind);
    return out.output;
  };
  return { ...t, launches, sends, call };
}

const human = caller("operate", true);

/** A lead call's refusal, thrown or rejected. */
const refusal = (f: () => unknown) => (async () => f())().catch((e: Error) => e.message);

test("chat_send starts the lead with the message, then sends the next into its session, once per clientRequestId", async () => {
  const { call, launches, sends, done } = withFlow();
  const first = await call(human, "chat_send", { projectRef: PROJECT, text: "add dark mode", clientRequestId: "c1", tz: "Europe/Berlin" });
  expect(first.message).toMatchObject({ author: "human", text: "add dark mode", delivery: "turn", client: "app" });
  expect(first.next).toBe("The lead's reply arrives as chat.message events; read the chat with chat_history.");
  expect(launches.length).toBe(1);
  expect(launches[0]).toContain("add dark mode");
  expect(sends.length).toBe(0);
  const second = await call(human, "chat_send", { projectRef: PROJECT, text: "and a toggle", clientRequestId: "c2" });
  expect(sends).toEqual([{ text: expect.stringContaining("and a toggle"), crid: `chat:${second.message.messageId}` }]);
  // A lead whose thread hasn't reported yet is starting: its session takes the message when its turn begins.
  expect(second.message.delivery).toBe("queued");
  const again = await call(human, "chat_send", { projectRef: PROJECT, text: "and a toggle", clientRequestId: "c2" });
  expect(again.message.messageId).toBe(second.message.messageId);
  expect(sends.length).toBe(1);
  const history = await call(caller("read"), "chat_history", { projectRef: PROJECT });
  expect(history.messages.map((m: { text: string }) => m.text)).toEqual(["add dark mode", "and a toggle"]);
  expect(history.moreBefore).toBe(false);
  done();
});

test("a message the lead took is announced again as delivered, stamped after its queued copy, so the apps keep it", async () => {
  const { hub, call, done } = withFlow();
  // The clock stands still: the lead takes it within the millisecond the message was stored in.
  const out = await call(human, "chat_send", { projectRef: PROJECT, text: "1yes", clientRequestId: "c1" });
  const copies = events(hub)
    .page(0)
    .events.filter((e) => e.type === "chat.message")
    .map((e) => (e.data as { message: { delivery?: string; createdAt: string; updatedAt?: string } }).message);
  expect(copies.map((m) => m.delivery)).toEqual(["queued", "turn"]);
  // The apps' rule (app/desktop chat.ts `newer`): a later stamp wins, an equal one keeps what they had.
  const stamp = (m: { createdAt: string; updatedAt?: string }) => m.updatedAt ?? m.createdAt;
  expect(stamp(copies[1]!) > stamp(copies[0]!)).toBe(true);
  expect(out.message).toMatchObject({ delivery: "turn", updatedAt: copies[1]!.updatedAt });
  done();
});

/** Sleeps a test ends by hand, each with how long it was asked for. */
function sleeps() {
  const asked: { ms: number; end: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((end) => void asked.push({ ms, end }));
  return { asked, sleep };
}

test("a lead whose hosted sandbox doesn't come up says so in the chat, once a run, and is started again by itself with the message", async () => {
  // A bot with no repo on hosted sandboxes: the person's message, then nothing at all (W737), then a line that
  // promised a retry nothing made (W753).
  const timers = sleeps();
  const { hub, clock, call, sends, done } = withFlow({ sleep: timers.sleep });
  await call(human, "chat_send", { projectRef: PROJECT, text: "hello", clientRequestId: "c1" });
  const failed = (runId: string, message: string) => ({
    machineId: PROJECT.machineId,
    projectId: PROJECT.projectId,
    threadId: "lead-1",
    summary: "failed",
    data: { runId, endCause: "failed", error: { class: "sandbox", message } },
  });
  const boxless = "could not start /opt/claude/.local/bin/claude: no hosted sandbox came up at boat.dev: git rev-parse failed: fatal: not a git repository (cwd /srv/x)";
  const at = (ms: number) => new Date(ms).toISOString();
  events(hub).append({ at: at(clock.ms), type: "thread.failed", ...failed("r1", boxless) });
  events(hub).append({ at: at(clock.ms), type: "thread.failed", ...failed("r1", boxless) });
  const lines = async () =>
    (await call(caller("read"), "chat_history", { projectRef: PROJECT })).messages.filter((m: { author: string }) => m.author === "system").map((m: { text: string }) => m.text);
  const until = async (ok: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 200 && !(await ok()); i++) await Bun.sleep(10);
  };
  await until(async () => (await lines()).length === 1 && timers.asked.length === 1);
  expect(await lines()).toEqual([
    "The lead couldn't start: no sandbox came up for it at boat.dev. It tries again by itself in about 10 minutes, and your message is kept for it. If it keeps failing, check boat.dev in Settings › Hub › Machines.",
  ]);
  // In the person's words: no path, no git, no clock time.
  expect((await lines())[0]).not.toMatch(/\/|git|\d:\d\d/);
  // Nothing at once, which would fail the same way while the provider is set aside: once it is offered again.
  expect(sends).toEqual([]);
  // One wait for the run, though its failure came twice.
  await Bun.sleep(30);
  expect(timers.asked.map((t) => t.ms)).toEqual([630_000]);
  clock.ms += 630_000;
  timers.asked[0]!.end();
  await until(() => leads(hub).wakes.pending(PROJECT));
  expect(leads(hub).wakes.pending(PROJECT)).toBe(true);
  // The wake goes to the lead's session, where the node puts the kept message ahead of it.
  // 10 s of it is the wake's own wait, in real time.
  for (let i = 0; i < 1500 && sends.length === 0; i++) await Bun.sleep(10);
  expect(sends.map((s) => s.text)).toEqual([expect.stringContaining("the message above never reached you until now")]);

  // It didn't come up again (the provider's template didn't build): twice as long, the node's UTC time gone.
  events(hub).append({ at: at(clock.ms), type: "thread.failed", ...failed("r2", "boat.dev's sandbox template didn't build (try again in a minute); trying again at 19:20") });
  await until(async () => (await lines()).length === 2 && timers.asked.length === 2);
  expect((await lines())[1]).toBe("The lead couldn't start: boat.dev's sandbox template didn't build. It tries again by itself in about 20 minutes, and your message is kept for it.");
  expect(timers.asked[1]!.ms).toBe(1_230_000);
  // A completed turn ends the run of failed starts: the wait due then wakes nothing.
  events(hub).append({ at: at(clock.ms), type: "thread.completed", machineId: PROJECT.machineId, projectId: PROJECT.projectId, threadId: "lead-1", summary: "completed" });
  clock.ms += 1_230_000;
  timers.asked[1]!.end();
  await Bun.sleep(30);
  expect(sends.length).toBe(1);
  done();
}, 30_000);

test("a lead's start again is bounded: three, at 10, 20 and 40 minutes, then the line says the next message tries", async () => {
  const timers = sleeps();
  const { hub, clock, call, done } = withFlow({ sleep: timers.sleep });
  await call(human, "chat_send", { projectRef: PROJECT, text: "hello", clientRequestId: "c1" });
  const lines = async () =>
    (await call(caller("read"), "chat_history", { projectRef: PROJECT })).messages.filter((m: { author: string }) => m.author === "system").map((m: { text: string }) => m.text);
  for (let i = 1; i <= 4; i++) {
    events(hub).append({
      at: new Date(clock.ms).toISOString(),
      type: "thread.failed",
      machineId: PROJECT.machineId,
      projectId: PROJECT.projectId,
      threadId: "lead-1",
      summary: "failed",
      data: { runId: `r${i}`, endCause: "failed", error: { class: "sandbox", message: "boat.dev's sandbox template didn't build" } },
    });
    for (let j = 0; j < 200 && (await lines()).length < i; j++) await Bun.sleep(10);
    clock.ms += 60_000;
  }
  await Bun.sleep(30);
  expect(timers.asked.map((t) => t.ms)).toEqual([630_000, 1_230_000, 2_430_000]);
  expect((await lines()).at(-1)).toBe(
    "The lead couldn't start: boat.dev's sandbox template didn't build. It was tried again 3 times by itself; your message is kept, and the lead tries again when you send another.",
  );
  done();
}, 30_000);

test("after a hub restart, a lead's start again that was due keeps its time", async () => {
  const timers = sleeps();
  const { hub, clock, call, done } = withFlow({ sleep: timers.sleep });
  await call(human, "chat_send", { projectRef: PROJECT, text: "hello", clientRequestId: "c1" });
  events(hub).append({
    at: new Date(clock.ms).toISOString(),
    type: "thread.failed",
    machineId: PROJECT.machineId,
    projectId: PROJECT.projectId,
    threadId: "lead-1",
    summary: "failed",
    data: { runId: "r1", endCause: "failed", error: { class: "sandbox", message: "boat.dev's sandbox template didn't build" } },
  });
  // The hub restarts 4 minutes later: what it reads at its start (`start` again, as serve does).
  clock.ms += 240_000;
  const after = sleeps();
  start(hub, { sleep: after.sleep });
  expect(after.asked.map((t) => t.ms)).toEqual([390_000]);
  done();
});

test("chat_send refuses an empty message, an agent's `now`, and an unknown bot", async () => {
  const { call, done } = withFlow();
  expect(call(human, "chat_send", { projectRef: PROJECT, text: "", clientRequestId: "c1" })).rejects.toThrow("text is empty");
  expect(call(caller("operate"), "chat_send", { projectRef: PROJECT, text: "go", now: true, clientRequestId: "c1" })).rejects.toThrow(
    "Only a person can stop the lead's step.",
  );
  expect(call(human, "chat_send", { projectRef: { machineId: "lab-a", projectId: "nope" }, text: "x", clientRequestId: "c1" })).rejects.toThrow(
    "No bot nope on lab-a.",
  );
  done();
});

test("chat_stop stops every open order once per clientRequestId; an agent key may not", async () => {
  const { hub, call, done } = withFlow();
  workstreams(hub).intake({ projectRef: PROJECT, text: "one", clientRequestId: "o1", channel: "app", by: "human" });
  const out = await call(human, "chat_stop", { projectRef: PROJECT, clientRequestId: "s1" });
  expect(out).toMatchObject({ stopped: false, message: { author: "system", text: "Nothing was running." } });
  expect(leads(hub).records.workstreamGet("W1")).toMatchObject({ state: "stopped", headline: "Stopped by you" });
  const stopped = events(hub)
    .page(0)
    .events.find((e) => e.type === "workstream.state");
  expect(stopped?.data).toEqual({ workstreamId: "W1", state: "stopped", reason: "stopped by the human", by: "key_h" });
  const again = await call(human, "chat_stop", { projectRef: PROJECT, clientRequestId: "s1" });
  expect(again.message.messageId).toBe(out.message.messageId);
  expect(call(caller("operate"), "chat_stop", {})).rejects.toThrow("chat_stop speaks for the human");
  expect(call(human, "chat_stop", {})).rejects.toThrow("missing field");
  const counts = await call(human, "project_stop", { projectRef: PROJECT, reason: "enough" });
  expect(counts).toMatchObject({ stopped: 0, cancelled: 0, next: "Tell the lead in the chat what to do next." });
  done();
});

test("the stream pass opens a bubble, appends to it and lands the reply whole; a quiet turn posts nothing", async () => {
  const { hub, call, done } = withFlow();
  await call(human, "chat_send", { projectRef: PROJECT, text: "hi", clientRequestId: "c1" });
  const sent = new Map<string, number>();
  let parts: LiveParts = { text: { messageId: "a", tail: "Hel", total: 3 }, done: [], runActive: true };
  streamPass(hub, sent, () => parts);
  const source = "lead:lead-1:a";
  expect(chat(hub).bySource(PROJECT, source)).toMatchObject({ state: "streaming", text: "Hel" });
  parts = { text: { messageId: "a", tail: "Hello there", total: 11 }, done: [], runActive: true };
  streamPass(hub, sent, () => parts);
  expect(chat(hub).bySource(PROJECT, source)?.text).toBe("Hello there");
  parts = { done: [{ messageId: "a", text: "Hello there!" }], runActive: false };
  streamPass(hub, sent, () => parts);
  expect(chat(hub).bySource(PROJECT, source)).toMatchObject({ state: "final", text: "Hello there!" });
  parts = { text: { messageId: "b", tail: "(qui", total: 4 }, done: [], runActive: true };
  streamPass(hub, sent, () => parts);
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:b")).toBeUndefined();
  expect(since({ messageId: "x", tail: "défg", total: 10 }, 8)).toBe("fg");
  done();
});

test("nudge flags the lead's newest reply, or the one still landing; chat_nudge_clear clears it", async () => {
  const { hub, call, done } = withFlow();
  await call(human, "chat_send", { projectRef: PROJECT, text: "hi", clientRequestId: "c1" });
  const lead = { projectRef: PROJECT, by: "lead:lab-a/p1", agent: { kind: "lead" as const } };
  const nudge = leadCalls(hub).handler("nudge");
  const none = await refusal(() => nudge?.(lead, { op: "nudge", reason: "look" }));
  expect(none).toBe("You haven't written anything this turn to flag.");
  const message = chat(hub).add(PROJECT, { author: "lead", text: "Done: the toggle", source: "lead:lead-1:m1" }).message;
  hub.area("activity", () => ({ live: () => ({ done: [{ messageId: "m1", text: "Done: the toggle" }], runActive: false }) }));
  const flagged = (await nudge?.(lead, { op: "nudge", reason: "the toggle" })) as Record<string, unknown>;
  expect(flagged).toEqual({ messageId: message.messageId, next: "Flagged: the person sees it as something to look at until they have seen it." });
  expect(chat(hub).openNudges(PROJECT).map((m) => m.messageId)).toEqual([message.messageId]);
  const task = { ...lead, agent: { kind: "task" as const, taskId: "T1" } };
  expect(await refusal(() => nudge?.(task, { op: "nudge", reason: "x" }))).toBe(
    "Only a bot's lead nudges, and only its own messages.",
  );
  expect(await call(human, "chat_nudge_clear", { projectRef: PROJECT, messageId: message.messageId })).toEqual({ ok: true });
  expect(chat(hub).openNudges(PROJECT)).toEqual([]);
  done();
});

test("chat_search finds a lead's own chat by words, a page at a time; chat_read reads around one", async () => {
  const { hub, done } = withFlow();
  for (let i = 1; i <= 25; i++) chat(hub).add(PROJECT, { author: i % 2 ? "human" : "lead", text: `note ${i} about deploys` });
  const lead = { projectRef: PROJECT, by: "lead:lab-a/p1", agent: { kind: "lead" as const } };
  const search = leadCalls(hub).handler("chat_search");
  const page = (await search?.(lead, { op: "chat_search", words: "DEPLOYS note" })) as { messages: { messageId: string; text: string }[]; more?: boolean; next: string };
  expect(page.messages.length).toBe(20);
  expect(page.messages[0]?.text).toBe("note 25 about deploys");
  expect(page.more).toBe(true);
  expect(page.next).toStartWith(`Older hits are left: call chat_search again with before: "${page.messages[19]?.messageId}".`);
  const read = leadCalls(hub).handler("chat_read");
  const around = (await read?.(lead, { op: "chat_read", messageId: "m10", before: 1, after: 1 })) as { messages: { text: string }[]; moreBefore: boolean };
  expect(around.messages.map((m) => m.text)).toEqual(["note 9 about deploys", "note 10 about deploys", "note 11 about deploys"]);
  expect(around.moreBefore).toBe(true);
  const other = await refusal(() => read?.(lead, { op: "chat_read", messageId: "m999" }));
  expect(other).toBe("m999 is not a message of this chat.");
  expect(when("2026-10-20", true)).toBe(Date.parse("2026-10-21T00:00:00Z") - 1);
  expect(excerpt(`${"a ".repeat(400)}needle ${"b ".repeat(400)}`, ["needle"], 300)[0]).toStartWith("…");
  done();
});
