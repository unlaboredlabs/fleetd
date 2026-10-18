// M2 lab scenario 1, "wake on time": wake_set "at now+60 s" on an idle lab-b thread. The thread receives the
// message within 5 s of the time and wake.fired is emitted. One tiny haiku turn (the woken thread's reply).
import { randomUUID } from "node:crypto";
import type { Body, Lab } from "./harness.ts";

const MACHINE = "lab-b";
const SLACK_MS = 5_000;

export async function wakeOnTime(lab: Lab) {
  const { callTool, check, ok } = lab;
  const { threadId } = await lab.idleThread(MACHINE);
  const cursor = await lab.cursor();
  const dueMs = Math.ceil((Date.now() + 60_000) / 1000) * 1000;
  const due = new Date(dueMs).toISOString();
  const text = `Reply with the single word WAKE and nothing else. (${randomUUID().slice(0, 8)})`;

  const set = await callTool("wake_set", {
    target: { machineId: MACHINE, threadId },
    schedule: { kind: "at", at: due, tz: "UTC" },
    message: text,
    clientRequestId: randomUUID(),
  });
  check(!set.isError && set.body.nextRunAt === due, `wake_set returned the due time: ${JSON.stringify(set.body)}`);
  const wakeId = set.body.wakeId as string;
  ok(`wake_set ${wakeId} at ${due} on ${MACHINE}/${threadId}`);
  const listed = (await callTool("wake_list", { threadId })).body.wakes as Array<Body>;
  check(listed.some((w) => w.wakeId === wakeId && w.state === "active"), `wake_list shows it active: ${JSON.stringify(listed)}`);

  const { event: fired } = await lab.waitEvent("wake.fired", 120_000, {
    cursor,
    types: ["wake.fired"],
    match: (e) => e.data?.wakeId === wakeId,
  });
  const firedLag = Date.parse(fired.at) - dueMs;
  check(firedLag >= 0 && firedLag <= SLACK_MS, `wake.fired within ${SLACK_MS} ms of ${due}: lag ${firedLag} ms`);
  check(fired.data.queued === false, `fired straight to T3, not queued: ${JSON.stringify(fired.data)}`);
  ok(`wake.fired seq=${fired.seq} ${firedLag} ms after the due time: "${fired.summary}"`);

  const { event: done } = await lab.waitEvent("the woken thread's run to end", 240_000, {
    cursor: fired.seq,
    machineId: MACHINE,
    match: (e) => e.threadId === threadId && e.type !== "thread.started",
  });
  check(done.type === "thread.completed", `woken run ended with ${done.type}: ${done.summary}`);
  const tail = (await callTool("thread_tail", { machineId: MACHINE, threadId, n: 6, kinds: ["message"] })).body;
  const received = (tail.items as Array<Body>).find((i) => i.role === "user" && i.text.includes(text));
  check(received, `thread_tail shows the wake's message: ${JSON.stringify(tail.items)}`);
  const receivedLag = Date.parse(received!.at) - dueMs;
  check(receivedLag <= SLACK_MS, `T3 recorded the message within ${SLACK_MS} ms of ${due}: lag ${receivedLag} ms`);
  ok(`thread received the message ${receivedLag} ms after the due time; run ${done.type}: "${done.summary}"`);

  const after = (await callTool("wake_list", { threadId, state: "done" })).body.wakes as Array<Body>;
  check(after.some((w) => w.wakeId === wakeId && w.lastFiredAt !== undefined), "the one-shot wake is done");
  ok("wake_list: the wake is done");
}
