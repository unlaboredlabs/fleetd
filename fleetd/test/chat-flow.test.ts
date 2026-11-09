// The chat flow (crates/fleetd/src/hub/chat/flow.rs, nudges.rs, navi/recall.rs): chat_send starting and reaching the
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

function withFlow() {
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
  start(t.hub);
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

test("chat_send refuses an empty message, an agent's `now`, and an unknown project", async () => {
  const { call, done } = withFlow();
  expect(call(human, "chat_send", { projectRef: PROJECT, text: "", clientRequestId: "c1" })).rejects.toThrow("text is empty");
  expect(call(caller("operate"), "chat_send", { projectRef: PROJECT, text: "go", now: true, clientRequestId: "c1" })).rejects.toThrow(
    "Only a person can stop the lead's step.",
  );
  expect(call(human, "chat_send", { projectRef: { machineId: "lab-a", projectId: "nope" }, text: "x", clientRequestId: "c1" })).rejects.toThrow(
    "No project nope on lab-a.",
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
    "Only a project's lead nudges, and only its own messages.",
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
