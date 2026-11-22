// Agents write to each other: a running agent takes a message at its next
// tool boundary, one that has finished but still waits (a wait_ci or Monitor of its own) is woken with it, batched, its
// wait kept armed, and one that waits on nothing keeps it for the turn its lead starts, unless it waits for an answer. A note to the bot wakes nobody: its agents
// read it at the top of `agents`.
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { type SendOpts, WriteQueue } from "../src/hub/queue/index.ts";
import { pollCiWaits } from "../src/hub/tasks/ci_wait.ts";
import { askAnswered, list, NOTE_MS, PER_MINUTE, sendMessage } from "../src/hub/steer/dm.ts";
import { leadCall } from "../src/hub/tasks/calls.ts";
import { rehold, send, sendRunId, steerTasks, takeHeld } from "../src/hub/steer/index.ts";
import * as steers from "../src/hub/steer/store.ts";
import { events } from "../src/hub/store/events.ts";
import type { Task } from "../src/shared/contracts.ts";
import { caller } from "./hub-helpers.ts";
import { P, tasksKit, until } from "./tasks-kit.ts";

const tools = new Registry();
registerAll(tools);

async function setup() {
  const k = tasksKit();
  // The seams the steer and tasks areas set when they start (steer/loops.ts, tasks/loops.ts).
  Object.assign(steerTasks(k.hub), {
    message: async (c: { projectRef: typeof P; by: string }, taskId: string, text: string) => void (await k.t.message(c, taskId, text)),
    takeBack: (taskId: string, message: string) => k.t.takeBack(taskId, message),
    holdMessage: (taskId: string, text: string) => k.t.holdMessage(taskId, text),
    askedAt: (taskId: string) => k.t.askedAt(taskId),
    answered: (taskId: string) => k.t.answered(taskId),
    wakeWaiting: (taskId: string) => {
      const on = k.t.waitingOn(taskId);
      if (on === undefined) return undefined;
      k.t.wakeHeld(taskId);
      return { on, inMs: k.t.wakeInMs(taskId) };
    },
    wakeDue: (taskId: string) => k.t.wakeDue(taskId),
    waitingOn: (taskId: string) => k.t.waitingOn(taskId),
    closedOrder: (taskId: string) => {
      const task = k.t.get(taskId);
      return task ? k.t.closedOrder(task) : undefined;
    },
  });
  k.ports.takeHeld = ((taskId: string, thread: never, id: string) => takeHeld(k.hub, taskId, thread, id)) as never;
  k.ports.rehold = ((id: string) => rehold(k.hub, id)) as never;
  // A running agent's message goes through the write queue to its node.
  const boundary: string[] = [];
  k.hub.area(
    "write_queue",
    (h) =>
      new WriteQueue(h, {
        isConnected: () => true,
        awaitLive: () => new Promise<void>(() => {}),
        sendWith: async (_thread, message: string, _crid: string, _opts: SendOpts) => {
          boundary.push(message);
          return {};
        },
      }),
  );
  // A message wake's batch, short for the tests.
  k.t.wakeBatchMs = 40;
  void k.t.run();
  await k.spawn("Dark mode");
  const from = (await k.spawn("Light mode")) as Task;
  /** A message from `sender` (T2 unless named). */
  const dm = (to: string[], text: string, sender: Task = from) =>
    sendMessage(
      k.hub,
      (sender, message, taskId, body, crid) => send(k.hub, { kind: "agent", from: sender, message }, { target: { taskId }, text: body, mode: "queue", refs: [], attached: [], clientRequestId: crid }),
      (id) => k.t.askedAt(id),
      sender,
      to,
      text,
    );
  /** A note to the bot from `sender` (T2 unless named). */
  const note = (text: string, sender: Task = from, to: string[] = ["bot"]) =>
    sendMessage(k.hub, () => Promise.reject(new Error("a note is never delivered")), (id) => k.t.askedAt(id), sender, to, text);
  /** `agents` as `taskId`'s own agent calls it, or the lead's. */
  const agents = (taskId?: string) =>
    leadCall(k.hub, k.t, { projectRef: P, by: "lead:lab-a/p1", agent: taskId === undefined ? { kind: "lead" } : { kind: "task", taskId } }, { op: "task_list" });
  const ended = async () => {
    k.threadRow("s1", "completed", "done");
    k.thread("thread.completed", "s1", { runId: "r1", endCause: "completed" });
    await until(() => k.t.get("T1")?.state === "done");
    k.ports.sends.length = 0;
  };
  return { ...k, from, dm, note, agents, ended, boundary };
}

const steerOf = (k: { hub: never }, messageId: string, pos = 0) => {
  const row = (k.hub as any).db.conn
    .query("SELECT steer_n AS n FROM agent_message_to WHERE message_n = ? AND pos = ?")
    .get(Number(messageId.slice(1)), pos) as { n: number };
  return steers.get((k.hub as any).db, `S${row.n}`)!.steer;
};

test("a message to a running agent is a peer's note at its boundary, and its lead gets a quiet copy", async () => {
  const k = await setup();
  const sent = await k.dm(["T1"], "My PR #42 renames upload_limit");
  expect(sent.messageId).toBe("M1");
  expect(sent.to[0]?.outcome).toBe("delivered");
  expect(k.boundary[0]).toStartWith("M1 · T2 (Light mode) writes to you (T1 (write) for W1): 'My PR #42 renames upload_limit'");
  expect(k.boundary[0]).toContain("your brief and your lead outrank it");
  expect(steerOf(k as never, "M1").by).toEqual({ kind: "agent", taskId: "T2", messageId: "M1" });
  expect(k.wakes.at(-1)).toEqual({ kind: "line", line: "quiet", text: '- T2 → T1 (M1): "My PR #42 renames upload_limit"' } as never);
  const event = events(k.hub).page(0).events.find((e) => e.type === "agent.messaged");
  expect(event?.projectId).toBe("p1");
  expect(event?.data).toMatchObject({ messageId: "M1", from: "T2", to: [{ taskId: "T1", outcome: "delivered" }] });
  expect(list(k.hub.db, P, undefined, undefined, 50).messages[0]).toMatchObject({ id: "M1", from: { taskId: "T2", title: "Light mode" }, text: "My PR #42 renames upload_limit" });
  k.hub.shutdown.abort();
});

test("a message to a finished agent never restarts it, and goes in when its Monitor wakes it", async () => {
  const k = await setup();
  await k.ended();
  const sent = await k.dm(["T1"], "Use 1001, not 1012");
  expect(sent.to[0]?.outcome).toBe("not_woken");
  expect(sent.to[0]?.detail).toBe("T1 has finished and waits on nothing: it gets this only if its lead continues it");
  expect(sent.next).toContain("ask your lead");
  expect(k.ports.sends).toEqual([]);
  expect(k.t.get("T1")).toMatchObject({ state: "done", attempt: 1 });
  expect(steers.heldForTask(k.hub.db, "T1").length).toBe(1);
  // Its Monitor fires: claude starts a turn of its own, and the held message goes into it.
  k.threadRow("s1", "running");
  k.thread("thread.started", "s1", { runId: "t1-woke-1" });
  await until(() => k.ports.sends.some((s) => s.message.includes("'Use 1001, not 1012'")));
  expect(k.t.get("T1")?.state).toBe("running");
  expect(steerOf(k as never, sent.messageId).held).toBeUndefined();
  expect(steers.heldForTask(k.hub.db, "T1")).toEqual([]);
  k.hub.shutdown.abort();
});

const CI = "https://github.com/acme/shop/actions/runs/42";
const waitOn = (k: { hub: { db: { conn: any } }; clock: { ms: number } }) =>
  k.hub.db.conn.query("INSERT INTO ci_waits (task_id, url, created_ms) VALUES ('T1', ?, ?)").run(CI, k.clock.ms);
const waits = (k: { hub: { db: { conn: any } } }) => k.hub.db.conn.query("SELECT url FROM ci_waits WHERE task_id = 'T1'").all() as { url: string }[];

test("a message to a finished agent that waits on wait_ci wakes it once, and its wait still fires later", async () => {
  const k = await setup();
  await k.ended();
  waitOn(k);
  const sent = await k.dm(["T1"], "Pin sha is 9f38ac6");
  expect(sent.to[0]?.outcome).toBe("woke");
  expect(sent.to[0]?.detail).toBe(
    `T1 has finished but waits on wait_ci on ${CI}: this wakes it within 1 s, together with what else is sent to it by then, and its wait stays armed`,
  );
  expect(sent.next).toContain("this wakes it within 1 s");
  // The batch's window: nothing yet.
  expect(k.ports.sends).toEqual([]);
  await until(() => k.ports.sends.length > 0);
  expect(k.ports.sends.length).toBe(1);
  expect(k.ports.sends[0]!.message).toContain("'Pin sha is 9f38ac6'");
  expect(k.ports.sends[0]!.thread.threadId).toBe("s1");
  expect(k.t.get("T1")?.attempt).toBe(2);
  expect(steers.heldForTask(k.hub.db, "T1")).toEqual([]);
  expect(list(k.hub.db, P, undefined, undefined, 50).messages[0]?.to[0]?.outcome).toBe("woke");
  // Its wait is still armed, and wakes it when the run finishes.
  expect(waits(k)).toEqual([{ url: CI }]);
  await Bun.sleep(80);
  expect(k.ports.sends.length).toBe(1);
  const reads = { read: async () => ({ kind: "finished" as const, conclusion: "success", label: "ci", failing: [], total: 3 }), merge: async () => ({ kind: "pending" as const }) };
  expect(await pollCiWaits(k.t, k.hub.db.conn, k.clock.ms, reads)).toBe(1);
  expect(k.ports.sends.at(-1)?.message).toStartWith(`CI you waited on (wait_ci) finished: ${CI}`);
  expect(waits(k)).toEqual([]);
  k.hub.shutdown.abort();
});

test("a burst of messages to a waiting finished agent wakes it once, with all of them in order", async () => {
  const k = await setup();
  await k.ended();
  waitOn(k);
  const texts = ["First: #1908", "Second: rebase onto it", "Third: hold your PR"];
  for (const text of texts) expect((await k.dm(["T1"], text)).to[0]?.outcome).toBe("woke");
  await until(() => k.ports.sends.length > 0);
  await Bun.sleep(120);
  expect(k.ports.sends.length).toBe(1);
  const text = k.ports.sends[0]!.message;
  const at = texts.map((t) => text.indexOf(`'${t}'`));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(k.t.get("T1")?.attempt).toBe(2);
  k.hub.shutdown.abort();
});

test("a waiting agent woken by a message waits its gap before the next message wakes it", async () => {
  const k = await setup();
  await k.ended();
  waitOn(k);
  k.t.wakeGapMs = 60_000;
  await k.dm(["T1"], "One");
  await until(() => k.ports.sends.length > 0);
  // It ends again, its wait still open: the next message is held until the gap is over.
  k.threadRow("s1", "completed", "done");
  k.thread("thread.completed", "s1", { runId: sendRunId(k.ports.sends[0]!.thread, k.ports.sends[0]!.id), endCause: "completed" });
  await until(() => k.t.get("T1")?.state === "done");
  const again = await k.dm(["T1"], "Two");
  expect(again.to[0]?.outcome).toBe("woke");
  expect(again.to[0]?.detail).toContain("this wakes it within 60 s");
  await Bun.sleep(120);
  expect(k.ports.sends.length).toBe(1);
  k.hub.shutdown.abort();
});

test("a message to a finished agent whose Monitor is armed wakes it in its own thread", async () => {
  const k = await setup();
  await k.ended();
  k.threadRow("s1", "completed", "done", { watchingUntil: new Date(k.clock.ms + 600_000).toISOString(), watching: ["the full check"] });
  const sent = await k.dm(["T1"], "#1908 merged");
  expect(sent.to[0]?.outcome).toBe("woke");
  expect(sent.to[0]?.detail).toStartWith("T1 has finished but waits on a Monitor (the full check): this wakes it");
  await until(() => k.ports.sends.length > 0);
  expect(k.ports.sends[0]!.thread.threadId).toBe("s1");
  expect(k.ports.sends[0]!.message).toContain("'#1908 merged'");
  // Its Monitor lives in that thread's claude, which the wake left as it was.
  expect(k.ports.stops).toEqual([]);
  k.hub.shutdown.abort();
});

test("a message to a finished agent that waits on nothing never wakes it, even after the batch", async () => {
  const k = await setup();
  await k.ended();
  // A Monitor whose time ran out wakes nothing.
  k.threadRow("s1", "completed", "done", { watchingUntil: new Date(k.clock.ms - 1_000).toISOString() });
  const sent = await k.dm(["T1"], "Use 1001");
  expect(sent.to[0]?.outcome).toBe("not_woken");
  await Bun.sleep(120);
  expect(k.ports.sends).toEqual([]);
  expect(k.t.get("T1")).toMatchObject({ state: "done", attempt: 1 });
  expect(steers.heldForTask(k.hub.db, "T1").length).toBe(1);
  k.hub.shutdown.abort();
});

test("a message to a finished agent of a closed order is refused, saying why, never held", async () => {
  const k = await setup();
  await k.ended();
  k.hub.db.conn.query("UPDATE workstreams SET state = 'done', data = json_set(data, '$.state', 'done') WHERE n = 1").run();
  const sent = await k.dm(["T1"], "Use 1001, not 1012");
  expect(sent.to[0]?.outcome).toBe("refused");
  expect(sent.to[0]?.detail).toContain("T1 can't go on: its order W1 is done, and its variables (its GitHub token among them) went with it.");
  expect(steers.heldForTask(k.hub.db, "T1")).toEqual([]);
  expect(k.ports.sends).toEqual([]);
  expect(k.t.get("T1")).toMatchObject({ state: "done", attempt: 1 });
  k.hub.shutdown.abort();
});

test("a wait_ci wake carries the messages held for it first", async () => {
  const k = await setup();
  await k.ended();
  await k.dm(["T1"], "#7 needs my seam in #8");
  await k.t.message({ projectRef: P, by: "ci" }, "T1", "PR #7 merged.");
  await until(() => k.ports.sends.length > 0);
  const text = k.ports.sends[0]!.message;
  expect(text.indexOf("'#7 needs my seam in #8'")).toBeLessThan(text.indexOf("PR #7 merged."));
  expect(text.indexOf("'#7 needs my seam in #8'")).toBeGreaterThanOrEqual(0);
  k.hub.shutdown.abort();
});

test("a message continues a finished agent only when it waits for an answer", async () => {
  const k = await setup();
  k.t.askLead("T1", "Which close code does iOS take?");
  await k.ended();
  const sent = await k.dm(["T1"], "1001: SocketRocket rejects 1012");
  expect(sent.to[0]?.outcome).toBe("woke");
  expect(sent.to[0]?.detail).toStartWith("it answers what T1 asked at ");
  await until(() => k.ports.sends.some((s) => s.message.includes("'1001: SocketRocket rejects 1012'")));
  expect(k.t.get("T1")?.attempt).toBe(2);
  k.hub.shutdown.abort();
});

// The common case: the agent asks and carries on, its lead answers mid-run, and it finishes. The question is answered,
// so another agent's message is held for it, never a restart.
test("a question its lead answered mid-run no longer lets a message restart it", async () => {
  const k = await setup();
  k.t.askLead("T1", "Which close code does iOS take?");
  await send(k.hub, { kind: "lead", project: P }, { target: { taskId: "T1" }, text: "1001", mode: "queue", refs: [], attached: [], clientRequestId: "lead-answer" });
  await k.ended();
  const sent = await k.dm(["T1"], "SocketRocket rejects 1012 too");
  expect(sent.to[0]?.outcome).toBe("not_woken");
  expect(k.t.get("T1")?.attempt).toBe(1);
  k.hub.shutdown.abort();
});

// T4995 asked T4860 by agent_message and ended its turn; T4860's answer was "not woken", and T4995 sat until its lead
// relayed it by hand.
test("a peer's reply continues an agent that ended waiting on nothing for it, once per reply", async () => {
  const k = await setup();
  const asked = await k.dm(["T2"], "How do you get the emailed code?", k.t.get("T1")!);
  expect(asked.to[0]?.outcome).toBe("delivered");
  await k.ended();
  const reply = await k.dm(["T1"], "Read it from the test inbox's API");
  expect(reply.to[0]?.outcome).toBe("woke");
  expect(reply.to[0]?.detail).toBe(`it answers what T1 asked you in ${asked.messageId}`);
  expect(reply.next).toContain("T1 was waiting for an answer, and this continues it.");
  await until(() => k.ports.sends.some((s) => s.message.includes("'Read it from the test inbox's API'")));
  expect(k.ports.sends.length).toBe(1);
  expect(k.ports.sends[0]!.thread.threadId).toBe("s1");
  expect(k.t.get("T1")).toMatchObject({ state: "running", attempt: 2 });
  expect(steers.heldForTask(k.hub.db, "T1")).toEqual([]);
  // It ends again without asking anything more: the next word from T2 answers nothing, and is held as before.
  k.threadRow("s1", "completed", "done");
  k.thread("thread.completed", "s1", { runId: sendRunId(k.ports.sends[0]!.thread, k.ports.sends[0]!.id), endCause: "completed" });
  await until(() => k.t.get("T1")?.state === "done");
  const more = await k.dm(["T1"], "Also: the code lasts 10 min");
  expect(more.to[0]?.outcome).toBe("not_woken");
  await Bun.sleep(80);
  expect(k.ports.sends.length).toBe(1);
  expect(k.t.get("T1")).toMatchObject({ state: "done", attempt: 2 });
  k.hub.shutdown.abort();
});

test("a message from an agent it never asked doesn't continue it, and the lead's digest shows it unread", async () => {
  const k = await setup();
  // T1 asked someone else; T2's message answers nothing of T1's.
  await k.spawn("Sepia mode");
  await k.dm(["T3"], "Which palette?", k.t.get("T1")!);
  await k.ended();
  const sent = await k.dm(["T1"], "I renamed upload_limit");
  expect(sent.to[0]?.outcome).toBe("not_woken");
  expect(k.t.get("T1")).toMatchObject({ state: "done", attempt: 1 });
  expect(k.t.digestLines(P, undefined, 50)).toContain(
    `- T1 ended waiting on nothing, with a message unread (${sent.messageId} from T2): it reads them only if you continue it (message_agent)`,
  );
  // Its lead continues it: the message goes in, and the line is gone.
  await k.t.message({ projectRef: P, by: "lead:lab-a/p1" }, "T1", "Go on.");
  await until(() => k.ports.sends.some((s) => s.message.includes("'I renamed upload_limit'")));
  expect(k.t.digestLines(P, undefined, 50).some((l) => l.includes("unread"))).toBe(false);
  k.hub.shutdown.abort();
});

test("a reply to an agent whose wait is armed wakes it once, with that wait's wake", async () => {
  const k = await setup();
  await k.dm(["T2"], "Is #42 your seam?", k.t.get("T1")!);
  await k.ended();
  waitOn(k);
  const reply = await k.dm(["T1"], "Yes, #42");
  expect(reply.to[0]?.outcome).toBe("woke");
  expect(reply.to[0]?.detail).toStartWith(`T1 has finished but waits on wait_ci on ${CI}`);
  await until(() => k.ports.sends.length > 0);
  await Bun.sleep(120);
  expect(k.ports.sends.length).toBe(1);
  expect(k.ports.sends[0]!.message).toContain("'Yes, #42'");
  expect(k.t.get("T1")?.attempt).toBe(2);
  expect(waits(k)).toEqual([{ url: CI }]);
  k.hub.shutdown.abort();
});

test("a reply to an agent whose order closed is refused, and never continues it", async () => {
  const k = await setup();
  await k.dm(["T2"], "Is #42 your seam?", k.t.get("T1")!);
  await k.ended();
  k.hub.db.conn.query("UPDATE workstreams SET state = 'done', data = json_set(data, '$.state', 'done') WHERE n = 1").run();
  const reply = await k.dm(["T1"], "Yes, #42");
  expect(reply.to[0]?.outcome).toBe("refused");
  expect(reply.to[0]?.detail).toContain("its order W1 is done");
  await Bun.sleep(80);
  expect(k.ports.sends).toEqual([]);
  expect(k.t.get("T1")).toMatchObject({ state: "done", attempt: 1 });
  k.hub.shutdown.abort();
});

test("a reply settles the ask and asks nothing, so two agents' thanks can't wake each other in turns", async () => {
  const k = await setup();
  const t1 = k.t.get("T1")!;
  const ask = await k.dm(["T2"], "Which port?", t1);
  const reply = await k.dm(["T1"], "4790");
  const thanks = await k.dm(["T2"], "Thanks!", t1);
  const db = k.hub.db;
  // T2's reply answers T1's ask; T1's thanks answers nothing of T2's, which asked nothing.
  expect(askAnswered(db, "T1", "T2", reply.messageId)).toBe(Number(ask.messageId.slice(1)));
  expect(askAnswered(db, "T2", "T1", thanks.messageId)).toBeUndefined();
  // The thanks is a new ask of T1's, which T2's next message answers; one refused counts for nothing.
  expect(askAnswered(db, "T1", "T2", "M99")).toBe(Number(thanks.messageId.slice(1)));
  db.conn.query("UPDATE agent_message_to SET outcome = 'refused' WHERE message_n = ?").run(Number(thanks.messageId.slice(1)));
  expect(askAnswered(db, "T1", "T2", "M99")).toBeUndefined();
  k.hub.shutdown.abort();
});

test("one message reaches each recipient, refuses those outside the bot, and caps 20 a minute", async () => {
  const k = await setup();
  const sent = await k.dm(["T1", "T1", "T9", "T2"], "rebase on #42");
  expect(sent.to.map((t) => [t.taskId, t.outcome])).toEqual([
    ["T1", "delivered"],
    ["T9", "refused"],
    ["T2", "refused"],
  ]);
  expect(sent.to[1]?.detail).toContain("No task T9");
  for (let i = 1; i < PER_MINUTE - 2; i++) await k.dm(["T1"], `note ${i}`);
  await expect(k.dm(["T1"], "one more")).rejects.toMatchObject({ code: "forbidden" });
  // The person reads them page by page, newest first; another project's key sees none.
  const reader = caller("read");
  const first = (await tools.call(k.hub, reader, "agent_messages", { projectRef: P, limit: 5 })) as { output: any };
  expect(first.output).toMatchObject({ more: true, total: PER_MINUTE - 2 });
  expect(first.output.messages[0].id).toBe(`M${PER_MINUTE - 2}`);
  const rest = (await tools.call(k.hub, reader, "agent_messages", { projectRef: P, before: first.output.messages.at(-1).id, limit: 50 })) as { output: any };
  expect(rest.output.messages.length).toBe(PER_MINUTE - 2 - 5);
  const mine = (await tools.call(k.hub, reader, "agent_messages", { projectRef: P, taskId: "T9" })) as { output: any };
  expect(mine.output.total).toBe(1);
  k.hub.shutdown.abort();
});

test("a note to the bot wakes nobody, opens its agents' `agents`, and its lead and the person read it", async () => {
  const k = await setup();
  await k.spawn("Review #3", "review", { pr: "https://github.com/acme/shop/pull/3" });
  const sent = await k.note("moving the fleetd-cloud pin in #404");
  expect(sent).toMatchObject({ messageId: "M1", to: [], toBot: true });
  expect(sent.next).toContain("It wakes nobody");
  // No steer, no delivery, no wake: nobody's turn is touched.
  expect(k.boundary).toEqual([]);
  expect(k.ports.sends).toEqual([]);
  expect((k.hub.db.conn.query("SELECT COUNT(*) AS n FROM agent_message_to").get() as { n: number }).n).toBe(0);
  expect(k.wakes.at(-1)).toEqual({ kind: "line", line: "quiet", text: '- T2 → the bot (M1): "moving the fleetd-cloud pin in #404"' } as never);
  // T1's `agents` opens with it; a review's and the lead's carry none.
  const at = new Date(k.clock.ms).toISOString().slice(11, 16);
  const seen = await k.agents("T1");
  expect(Object.keys(seen)[0]).toBe("notes");
  expect(seen.notes).toEqual([`M1 T2 ${at}: moving the fleetd-cloud pin in #404`]);
  expect((await k.agents("T3")).notes).toBeUndefined();
  expect((await k.agents()).notes).toBeUndefined();
  // The person's log has it, marked as to the bot.
  expect(list(k.hub.db, P, undefined, undefined, 50).messages[0]).toMatchObject({ id: "M1", to: [], toBot: true, text: "moving the fleetd-cloud pin in #404" });
  expect(list(k.hub.db, P, "T2", undefined, 50).total).toBe(1);
  const event = events(k.hub).page(0).events.find((e) => e.type === "agent.messaged");
  expect(event?.data).toMatchObject({ messageId: "M1", from: "T2", to: [], toBot: true });
  expect(event?.summary).toBe("M1 from T2 to the bot: 'moving the fleetd-cloud pin in #404'");
  k.hub.shutdown.abort();
});

test("a note leaves `agents` once its sender's task ends, and after a day; ten show, newest first", async () => {
  const k = await setup();
  const t1 = k.t.get("T1") as Task;
  await k.note("T1 owns migration 202611192300", t1);
  expect((await k.agents("T2")).notes).toHaveLength(1);
  await k.ended();
  expect((await k.agents("T2")).notes).toBeUndefined();
  // The log keeps it.
  expect(list(k.hub.db, P, "T1", undefined, 50).total).toBe(1);
  for (let i = 1; i <= 12; i++) await k.note(`claim ${i}`);
  const shown = (await k.agents("T2")).notes as string[];
  expect(shown).toHaveLength(10);
  expect(shown[0]).toEndWith(": claim 12");
  k.clock.ms += NOTE_MS;
  expect((await k.agents("T2")).notes).toBeUndefined();
  k.hub.shutdown.abort();
});

test("a review posts no notes, and a note is one line of at most 300 characters, to the bot alone", async () => {
  const k = await setup();
  const review = (await k.spawn("Review #3", "review", { pr: "https://github.com/acme/shop/pull/3" })) as Task;
  await expect(k.note("found a bug", review)).rejects.toMatchObject({ code: "forbidden" });
  await expect(k.note("two\nlines")).rejects.toMatchObject({ code: "invalid" });
  await expect(k.note("x".repeat(301))).rejects.toMatchObject({ code: "invalid" });
  await expect(k.note("and T1", k.from, ["bot", "T1"])).rejects.toMatchObject({ code: "invalid" });
  expect((await k.note("y".repeat(300))).toBot).toBe(true);
  expect(list(k.hub.db, P, undefined, undefined, 50).total).toBe(1);
  // A note counts as one recipient in the minute's limit.
  for (let i = 1; i < PER_MINUTE; i++) await k.note(`note ${i}`);
  await expect(k.note("one more")).rejects.toMatchObject({ code: "forbidden" });
  k.hub.shutdown.abort();
});
