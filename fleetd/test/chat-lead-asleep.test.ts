// A hosted lead's computer asleep and waking (W792): the session's `asleep` reaches the chat state the apps draw the
// bot from, its flip is told though no status changes, and the chat's Try again asks the node to start now, false
// where no start waits.
import { expect, test } from "bun:test";
import { executorHooks } from "../src/hub/executor/hooks.ts";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { startNow, state } from "../src/hub/chat/flow.ts";
import { leads } from "../src/hub/leads/index.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { ProjectChatState } from "../src/shared/contracts.ts";
import type { SessionSummary } from "../src/shared/sessions.ts";
import { AT, kit } from "./work-kit.ts";

const settle = () => Bun.sleep(5);
/** What the apps were told of the chat's lead asleep, each time a chat.waiting went out. */
const told = (hub: Parameters<typeof state>[0]) =>
  events(hub)
    .page(0)
    .events.filter((e) => e.type === "chat.waiting")
    .map((e) => (e.data as ProjectChatState).leadAsleep);
const r = { machineId: "devbox", projectId: "p1" };

const lead = (extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: "lead-1",
  projectId: "p1",
  title: "fleetd lead: p1",
  status: "idle",
  model: "claude-opus-5-5",
  effort: "high",
  runtimeMode: "approval-required",
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

/** A hub with one lead on a fake node; `answer` says how the node answers a call. */
async function node(answer: (c: HubToNodeSession) => { ok: unknown } | { err: { code: string; message: string } } = () => ({ ok: { kind: "done" } })) {
  const k = kit();
  store(k.hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT });
  const ex = executors(k.hub);
  const calls: HubToNodeSession[] = [];
  const seen: HubToNodeSession[] = [];
  ex.attach("devbox", { linkId: 1, send: (f) => void calls.push(f) });
  await settle();
  ex.handleFrame("devbox", { t: "session_reply", id: calls.shift()!.id, result: { ok: { kind: "done" } } });
  await ex.awaitLive("devbox");
  ex.handleFrame("devbox", { t: "machine_event", seq: 1, at: AT, event: { type: "snapshot", projects: [{ projectId: "p1", title: "P1", workspaceRoot: "/w", updatedAt: AT }], sessions: [] } });
  await settle();
  leads(k.hub).records.leadPut({ projectRef: r, threadId: "lead-1", startedAt: AT, sessionGeneration: 1 });
  const answering = setInterval(() => {
    for (const c of calls.splice(0)) {
      seen.push(c);
      ex.handleFrame("devbox", { t: "session_reply", id: c.id, result: answer(c) as never });
    }
  }, 2);
  let seq = 1;
  const updated = async (s: SessionSummary) => {
    ex.handleFrame("devbox", { t: "machine_event", seq: ++seq, at: AT, event: { type: "session_updated", ...s } });
    for (let i = 0; i < 10; i++) await settle();
  };
  const done = () => {
    clearInterval(answering);
    k.hub.shutdown.abort();
  };
  return { ...k, updated, seen, done };
}

test("a lead whose computer sleeps shows asleep in its chat state, and is told when it falls asleep and wakes", async () => {
  const n = await node();
  const flips: string[] = [];
  executorHooks(n.hub).onAsleep((t) => flips.push(`${t.threadId}:${String(store(n.hub).threadGet({ machineId: t.machineId, threadId: t.threadId })?.thread.asleep === true)}`));
  await n.updated(lead());
  expect(state(n.hub, r).leadAsleep).toBeUndefined();
  await n.updated(lead({ asleep: true }));
  expect(state(n.hub, r).leadAsleep).toBe(true);
  // The apps hear it, though nothing else of the chat changed.
  expect(told(n.hub)).toEqual([undefined, true]);
  // A message starts it: the start clears asleep, and the run makes it mid-turn.
  await n.updated(lead({ status: "running", activeRunId: "run-1", latestRun: { id: "run-1", status: "running", ordinal: 1 } }));
  expect(state(n.hub, r).leadAsleep).toBeUndefined();
  expect(flips).toEqual(["lead-1:true", "lead-1:false"]);
  n.done();
});

test("Try again asks the lead's node to start now, and answers false where no start waits", async () => {
  const waits = await node();
  expect(await startNow(waits.hub, r)).toBe(true);
  expect(waits.seen.map((c) => c.call)).toContainEqual({ op: "start_now", sessionId: "lead-1" });
  waits.done();
  const none = await node((c) => (c.call.op === "start_now" ? { err: { code: "not_found", message: "no start waits for session lead-1" } } : { ok: { kind: "done" } }));
  expect(await startNow(none.hub, r)).toBe(false);
  none.done();
  // A bot with no lead yet has nothing to start.
  expect(await startNow(kit().hub, { machineId: "devbox", projectId: "none" })).toBe(false);
});

// W852: the apps take a person's message from before the lead's latest turn ended as one that turn had, answered or
// not, so the bot leaves the reply's place on a quiet turn though the app was closed when it ended.
test("the chat state says when the lead's latest turn ended, and nothing while it is mid-turn", async () => {
  const n = await node();
  const ended = "2026-11-23T10:00:05.000Z";
  await n.updated(lead({ status: "running", activeRunId: "run-1", latestRun: { id: "run-1", status: "running", ordinal: 1 } }));
  expect(state(n.hub, r).leadWorking).toBe(true);
  expect(state(n.hub, r).leadIdleAt).toBeUndefined();
  await n.updated(lead({ updatedAt: ended, latestRun: { id: "run-1", status: "completed", ordinal: 1 } }));
  expect(state(n.hub, r)).toMatchObject({ leadWorking: false, leadIdleAt: ended });
  // The flip to idle is told with it, so an app that sees it live has the end too.
  const last = events(n.hub)
    .page(0)
    .events.filter((e) => e.type === "chat.waiting")
    .at(-1);
  expect((last?.data as ProjectChatState).leadIdleAt).toBe(ended);
  n.done();
});
