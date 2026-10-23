// M2 lab scenario 5, "offline queue": with lab-a's node stopped, reads are stale, and a chat message to the lead waits
// in the hub's write queue. One queued past the hub's TTL (shortened by the harness) emits write.expired; one queued
// just before the node comes back is delivered and emits write.delivered.
// Costs up to two mechanics turns on lab-a (the lead's first turn if it has none, and the delivered message).
import { randomUUID } from "node:crypto";
import { type Body, type Lab, QUEUE_TTL_SEC } from "./harness.ts";

const MACHINE = "lab-a";

export async function offlineQueue(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  const { threadId, projectId } = await lab.idleThread(MACHINE);
  let cursor = await lab.cursor();

  await lab.stopNode(MACHINE);
  const offline = await lab.waitEvent(`machine.offline for ${MACHINE}`, 120_000, { cursor, machineId: MACHINE, types: ["machine.offline"] });
  cursor = offline.cursor;
  ok(`events_wait: machine.offline seq=${offline.event.seq} "${offline.event.summary}"`);

  const staleRead = (await callTool("project_get", { machineId: MACHINE, projectId })).body;
  check(staleRead.stale === true, `${MACHINE} project_get is stale: ${JSON.stringify(staleRead)}`);
  ok(`project_get ${MACHINE}: stale=${staleRead.stale} asOf=${staleRead.asOf}`);
  const send = async (text: string) => {
    const sent = await lab.humanCall("chat_send", { projectRef: { machineId: MACHINE, projectId }, text, clientRequestId: randomUUID() });
    check(!sent.isError && sent.body.message.delivery === "queued", `chat_send queued: ${JSON.stringify(sent.body)}`);
    // The queue's id for a chat message (hub/chat/flow.rs deliver).
    return `chat:${sent.body.message.messageId as string}`;
  };

  // Outlives the TTL while the node stays away.
  const lateText = `Reply with the single word LATE and nothing else. (${randomUUID().slice(0, 8)})`;
  const stale = await send(lateText);
  ok(`chat_send queued (TTL ${QUEUE_TTL_SEC} s)`);
  const expired = await lab.waitEvent("write.expired for the first send", (QUEUE_TTL_SEC + 60) * 1000, {
    cursor,
    types: ["write.expired"],
    match: (e) => e.data?.clientRequestId === stale,
  });
  const waited = Date.parse(expired.event.at) - Date.parse(expired.event.data.queuedAt);
  check(waited >= QUEUE_TTL_SEC * 1000 - 1000, `expired at its TTL, not before: queued ${expired.event.data.queuedAt}, expired ${expired.event.at}`);
  check(expired.event.data.reason === "ttl", `expired for its TTL: ${JSON.stringify(expired.event.data)}`);
  ok(`write.expired seq=${expired.event.seq} "${expired.event.summary}"`);
  cursor = expired.cursor;

  // Delivered once the node is back.
  const text = `Reply with the single word QUEUED and nothing else. (${randomUUID().slice(0, 8)})`;
  const fresh = await send(text);
  ok(`chat_send queued; starting ${MACHINE}'s node`);
  lab.startNode(MACHINE);
  const online = await lab.waitEvent(`machine.online for ${MACHINE}`, 60_000, { cursor, machineId: MACHINE, types: ["machine.online"] });
  const delivered = await lab.waitEvent("write.delivered for the second send", 60_000, {
    cursor,
    types: ["write.delivered"],
    match: (e) => e.data?.clientRequestId === fresh,
  });
  check(delivered.event.seq > online.event.seq, "delivered after the machine came back");
  ok(`write.delivered seq=${delivered.event.seq} "${delivered.event.summary}"`);

  const { event: done } = await lab.waitEvent("the delivered message's run to end", 240_000, {
    cursor: delivered.event.seq,
    machineId: MACHINE,
    match: (e) => e.threadId === threadId && e.type !== "thread.started",
  });
  check(done.type === "thread.completed", `run ended with ${done.type}: ${done.summary}`);
  const tail = (await callTool("thread_tail", { machineId: MACHINE, threadId, n: 6, kinds: ["message"] })).body.items as Array<Body>;
  check(tail.some((i) => i.role === "user" && i.text.includes(text)), `the queued message reached the thread: ${JSON.stringify(tail)}`);
  check(!tail.some((i) => i.role === "user" && i.text.includes(lateText)), "the expired message never reached the thread");
  ok(`thread received the queued message and ${done.type}; the expired one never arrived`);
}
