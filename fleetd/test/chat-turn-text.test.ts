// A lead turn posts one message: its last text, after its last tool call. Narration it wrote between tool calls never
// reaches the chat (W810): "Now the Antigravity order." posted as a bubble on 2026-11-22, drawn by claude's mid-turn
// "the user hasn't heard from you" reminder, which leads no longer get.
import { expect, test } from "bun:test";
import { registerLeadCalls } from "../src/hub/chat/calls.ts";
import { mirror } from "../src/hub/chat/flow.ts";
import { leadMessages, type ThreadMessage } from "../src/hub/chat/history.ts";
import { chat } from "../src/hub/chat/index.ts";
import { executors } from "../src/hub/executor/index.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import { leads } from "../src/hub/leads/index.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { roleEnv } from "../src/node/runner/claude.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

const AT = "2026-11-22T16:30:00Z";
const text = (id: string, runId: string, t: string): ThreadMessage => ({ id, runId, role: "assistant", text: t, createdAt: AT });

/** The turn of F1183: narration before its tool calls, then what the lead meant to say. */
const TURN = [text("a", "r1", "Now the Antigravity order."), text("b", "r1", "Checking the docs."), text("c", "r1", "The Antigravity order is in: two writers on it.")];

test("a turn's narration before its tool calls never posts: only its last text does", () => {
  expect(leadMessages("lead-1", TURN).map((m) => [m.source, m.text])).toEqual([["lead:lead-1:c", "The Antigravity order is in: two writers on it."]]);
});

test("a turn that ends with (quiet) posts nothing, whatever it wrote before its tool calls", () => {
  expect(leadMessages("lead-1", [text("a", "r1", "Now the Antigravity order."), text("b", "r1", "(quiet)")])).toEqual([]);
  expect(leadMessages("lead-1", [text("a", "r1", "Now the writers."), text("b", "r1", "Still running.\n\n(quiet)")]).map((m) => m.text)).toEqual(["Still running."]);
});

test("each turn posts its own last text; a turn still going or stopped posts none", () => {
  const messages = [text("a", "r1", "Looking."), text("b", "r1", "First answer."), text("c", "r2", "Now the order."), text("d", "r2", "Second answer."), text("e", "r3", "Now the next order.")];
  expect(leadMessages("lead-1", messages).map((m) => m.text)).toEqual(["First answer.", "Second answer.", "Now the next order."]);
  expect(leadMessages("lead-1", messages, "r3").map((m) => m.text)).toEqual(["First answer.", "Second answer."]);
  // A text with no run stands alone, as before.
  expect(leadMessages("lead-1", [{ id: "x", role: "assistant", text: "Hi.", createdAt: AT }, { id: "y", role: "assistant", text: "There.", createdAt: AT }]).map((m) => m.text)).toEqual(["Hi.", "There."]);
});

/** A hub with a lead whose session holds `messages`, its chat read. */
async function lead(messages: ThreadMessage[]) {
  const t = testHub();
  leads(t.hub).records.leadPut({ projectRef: PROJECT, threadId: "lead-1", startedAt: AT, sessionGeneration: 1 });
  await chat(t.hub).readHistory(PROJECT, () => []);
  Object.assign(executors(t.hub).views, { messages: async () => messages });
  const thread = { machineId: PROJECT.machineId, threadId: "lead-1" };
  /** The lead's thread as its node last said: `status`, its last run `r` and how that run is. */
  const threadIs = (status: "idle" | "running", r: string, run: string) =>
    store(t.hub).threadUpsert({
      thread: { machineId: PROJECT.machineId, threadId: "lead-1", projectId: PROJECT.projectId, title: "lead", status, headline: "", latestMessageTail: "", lastProgressAt: AT, stale: false, asOf: AT } as never,
      lastRunId: r,
      lastRunStatus: run,
    });
  const lead = { projectRef: PROJECT, by: "lead:lab-a/p1", agent: { kind: "lead" as const } };
  registerLeadCalls(t.hub);
  const nudge = (reason: string) => leadCalls(t.hub).handler("nudge")?.(lead, { op: "nudge", reason });
  const texts = () => chat(t.hub).page(PROJECT, undefined, undefined, 50).messages.filter((m) => m.author === "lead").map((m) => m.text);
  return { ...t, thread, threadIs, nudge, texts };
}

test("narration then a final message: the chat gets the final message alone, once the turn ends", async () => {
  const messages: ThreadMessage[] = [];
  const { hub, thread, threadIs, texts, done } = await lead(messages);
  threadIs("running", "r1", "running");
  messages.push(TURN[0]!);
  await mirror(hub, PROJECT, thread);
  expect(texts()).toEqual([]);
  messages.push(TURN[1]!, TURN[2]!);
  threadIs("idle", "r1", "completed");
  await mirror(hub, PROJECT, thread);
  await mirror(hub, PROJECT, thread);
  expect(texts()).toEqual(["The Antigravity order is in: two writers on it."]);
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:a")).toBeUndefined();
  done();
});

test("narration then (quiet): the chat gets nothing", async () => {
  const { hub, thread, threadIs, texts, done } = await lead([TURN[0]!, text("q", "r1", "(quiet)")]);
  threadIs("idle", "r1", "completed");
  await mirror(hub, PROJECT, thread);
  expect(texts()).toEqual([]);
  done();
});

test("a turn stopped after its narration posts nothing", async () => {
  const { hub, thread, threadIs, texts, done } = await lead([TURN[0]!]);
  threadIs("idle", "r1", "interrupted");
  await mirror(hub, PROJECT, thread);
  expect(texts()).toEqual([]);
  done();
});

test("nudge flags the message the turn ends with; a quiet turn's nudge flags no later message", async () => {
  const messages: ThreadMessage[] = [];
  const { hub, thread, threadIs, nudge, done } = await lead(messages);
  threadIs("running", "r1", "running");
  expect(await nudge("the new toggle")).toEqual({
    next: "Flagged: the message you end this turn with shows as something to look at once it is in the chat. Write it last, after every tool call.",
  });
  messages.push(text("a", "r1", "Now the toggle."), text("b", "r1", "The toggle is live: try it in Settings."));
  threadIs("idle", "r1", "completed");
  await mirror(hub, PROJECT, thread);
  const flagged = chat(hub).bySource(PROJECT, "lead:lead-1:b")!;
  expect(chat(hub).openNudges(PROJECT).map((m) => m.messageId)).toEqual([flagged.messageId]);
  // A turn that nudged and then went quiet: its nudge goes with it.
  threadIs("running", "r2", "running");
  await nudge("something");
  messages.push(text("c", "r2", "(quiet)"));
  threadIs("idle", "r2", "completed");
  await mirror(hub, PROJECT, thread);
  messages.push(text("d", "r3", "Next turn's news."));
  threadIs("idle", "r3", "completed");
  await mirror(hub, PROJECT, thread);
  expect(chat(hub).bySource(PROJECT, "lead:lead-1:d")?.nudge).toBeUndefined();
  expect(chat(hub).openNudges(PROJECT).map((m) => m.messageId)).toEqual([flagged.messageId]);
  done();
});

test("leads, with or without repos, start with claude's mid-turn progress reminder off; agents keep claude's default", () => {
  expect(roleEnv("lead", {})).toEqual({ CLAUDE_CODE_SILENT_TURN_REMINDER: "0" });
  expect(roleEnv("assistant", {})).toEqual({ CLAUDE_CODE_SILENT_TURN_REMINDER: "0" });
  expect(roleEnv("worker", {})).not.toHaveProperty("CLAUDE_CODE_SILENT_TURN_REMINDER");
  expect(roleEnv("plain", {})).toEqual({});
});
