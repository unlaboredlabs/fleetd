// The write queue's sends reach the node through the executor's sendWith (queue/ports.rs `impl ThreadWriter for
// Executors`, executor/mod.rs `send_with`): a lead wake or steer, with its mode and steer tag.
import { expect, test } from "bun:test";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { writeQueue } from "../src/hub/queue/index.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { SessionOutput } from "../src/shared/sessions.ts";
import { AT, kit } from "./work-kit.ts";

const settle = () => Bun.sleep(5);

async function readyNode() {
  const k = kit();
  store(k.hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT });
  const ex = executors(k.hub);
  const calls: HubToNodeSession[] = [];
  ex.attach("devbox", { linkId: 1, send: (f) => void calls.push(f) });
  const reply = (frame: HubToNodeSession, ok: SessionOutput) => ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result: { ok } });
  await settle();
  reply(calls.shift()!, { kind: "done" });
  await ex.awaitLive("devbox");
  // The link announced it online: queued writes go out.
  ex.setRunnerReady("devbox", true);
  const next = async () => {
    for (let i = 0; i < 100; i++) {
      const at = calls.findIndex((c) => c.call.op === "send");
      if (at >= 0) return calls.splice(at, 1)[0]!;
      await settle();
    }
    throw new Error("no send came");
  };
  return { ...k, ex, reply, next };
}

test("a queued steer goes to the node as one send, with its mode and steer tag", async () => {
  const { hub, reply, next } = await readyNode();
  const r = { machineId: "devbox", threadId: "s1" };
  const sent = writeQueue(hub).send(r, "use the new API", "req-1", undefined, { mode: "boundary", steer: "S4", riders: ["S3"] });
  const frame = await next();
  expect(frame.call).toEqual({
    op: "send",
    sessionId: "s1",
    runId: (frame.call as { runId: string }).runId,
    text: "use the new API",
    mode: "boundary",
    steer: { id: "S4", riders: ["S3"] },
  });
  reply(frame, { kind: "sent", runId: "run-9", queued: true });
  const result = await sent;
  expect(result).toMatchObject({ runId: "run-9", queued: false });
});

test("the executor's sendWith answers as the queue's writer reads it", async () => {
  const { ex, reply, next } = await readyNode();
  const out = ex.sendWith({ machineId: "devbox", threadId: "s2" }, "a wake", "req-2", {});
  const frame = await next();
  expect((frame.call as { mode?: string }).mode).toBeUndefined();
  reply(frame, { kind: "sent", runId: "run-1", queued: true });
  expect(await out).toEqual({ runId: "run-1", behindRun: true });
});
