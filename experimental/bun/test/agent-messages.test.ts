// Agents write to each other (crates/fleetd/src/hub/tasks/dm_tests.rs): a running agent takes a message at its next
// tool boundary, one that has finished keeps it for the turn something else starts (a Monitor of its own, its wait_ci,
// its lead), and only a question it waits on lets another agent continue it.
import { expect, test } from "bun:test";
import { registerAll } from "../src/gen/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { type SendOpts, WriteQueue } from "../src/hub/queue/index.ts";
import { list, PER_MINUTE, sendMessage } from "../src/hub/steer/dm.ts";
import { rehold, send, steerTasks, takeHeld } from "../src/hub/steer/index.ts";
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
    hasCiWait: () => false,
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
  void k.t.run();
  await k.spawn("Dark mode");
  const from = (await k.spawn("Light mode")) as Task;
  const dm = (to: string[], text: string) =>
    sendMessage(
      k.hub,
      (sender, message, taskId, body, crid) => send(k.hub, { kind: "agent", from: sender, message }, { target: { taskId }, text: body, mode: "queue", refs: [], attached: [], clientRequestId: crid }),
      (id) => k.t.askedAt(id),
      from,
      to,
      text,
    );
  const ended = async () => {
    k.threadRow("s1", "completed", "done");
    k.thread("thread.completed", "s1", { runId: "r1", endCause: "completed" });
    await until(() => k.t.get("T1")?.state === "done");
    k.ports.sends.length = 0;
  };
  return { ...k, from, dm, ended, boundary };
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
  expect(sent.to[0]?.detail).toStartWith("T1 has finished and isn't waiting on T2");
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

test("one message reaches each recipient, refuses those outside the project, and caps 20 a minute", async () => {
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
