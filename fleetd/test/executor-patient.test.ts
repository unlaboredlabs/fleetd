// A busy node's slow answer (#1301): a launch or a send with no
// answer goes again under the same frame id at doubling gaps for up to two minutes, and the first answer wins; only a
// refusal, a dropped link or that much silence fails it.
import { expect, jest, test } from "bun:test";
import { ExecutorError, executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { send, sendWith } from "../src/hub/executor/sessions.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { SessionOutput } from "../src/shared/sessions.ts";
import { AT, kit } from "./work-kit.ts";

async function node() {
  const k = kit();
  store(k.hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT });
  const ex = executors(k.hub);
  const calls: HubToNodeSession[] = [];
  ex.attach("devbox", { linkId: 1, send: (f) => void calls.push(f) });
  const reply = (frame: HubToNodeSession, result: { ok: SessionOutput } | { err: { code: "invalid"; message: string } }) =>
    ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result } as never);
  await Bun.sleep(5);
  reply(calls.shift()!, { ok: { kind: "done" } });
  await ex.awaitLive("devbox");
  ex.handleFrame("devbox", {
    t: "machine_event",
    seq: 1,
    at: AT,
    event: { type: "snapshot", projects: [{ projectId: "p1", title: "P1", workspaceRoot: "/w", updatedAt: AT }], sessions: [] },
  });
  await Bun.sleep(5);
  calls.length = 0;
  /** The session calls sent so far, follows left out. */
  const sends = () => calls.filter((c) => c.call.op !== "follow");
  return { ...k, ex, calls, reply, sends };
}

/** Moves the fake clock by `ms`, letting what it wakes run. */
async function tick(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const thread = { machineId: "devbox", threadId: "s1" };

test("a send a busy node answers after 20 s goes through once", async () => {
  const { hub, reply, sends } = await node();
  jest.useFakeTimers();
  try {
    const sent = sendWith(hub, thread, "use the other port", "req-1", { steer: "S1" });
    await tick(0);
    const [first] = sends();
    expect(first?.call).toMatchObject({ op: "send", steer: { id: "S1" } });
    // No answer in 15 s: the same call again, under the same frame id.
    await tick(15_000);
    const copy = sends()[1];
    expect(copy?.id).toBe(first?.id);
    expect(copy?.call).toEqual(first?.call);
    // The node answers at 20 s.
    await tick(5_000);
    const runId = (first?.call as { runId: string }).runId;
    reply(first!, { ok: { kind: "sent", runId, queued: true } });
    expect(await sent).toEqual({ runId, queued: true });
    // Nothing more goes out once it is answered.
    await tick(300_000);
    expect(sends().length).toBe(2);
  } finally {
    jest.useRealTimers();
    hub.shutdown.abort();
  }
});

test("a refused send fails at once, a silent node after two minutes, and a dropped link is the machine offline", async () => {
  const { hub, ex, reply, sends } = await node();
  jest.useFakeTimers();
  try {
    const refused = send(hub, thread, "go on", "req-1").catch((e) => e);
    await tick(0);
    reply(sends()[0]!, { err: { code: "invalid", message: "session s1 is stopping" } });
    const r = (await refused) as ExecutorError;
    expect(r.kind).toBe("node_failed");
    expect(r.extra.nodeMessage).toBe("session s1 is stopping");
    expect(sends().length).toBe(1);

    const started = Date.now();
    const silent = send(hub, thread, "go on", "req-2").catch((e) => e);
    const at: number[] = [];
    const seen = () => sends().length - 1;
    await tick(0);
    for (let s = 0; s <= 120; s++) {
      while (at.length < seen()) at.push(Math.round((Date.now() - started) / 1000));
      if (s < 120) await tick(1000);
    }
    expect(at).toEqual([0, 15, 45, 105]);
    const ids = sends().slice(1).map((c) => c.id);
    expect(new Set(ids).size).toBe(1);
    const e = (await silent) as ExecutorError;
    expect(e.extra.nodeMessage).toBe("no answer within 120 s");

    const dropped = send(hub, thread, "go on", "req-3").catch((e) => e);
    await tick(0);
    ex.detach("devbox");
    await tick(0);
    expect(((await dropped) as ExecutorError).kind).toBe("not_connected");
  } finally {
    jest.useRealTimers();
    hub.shutdown.abort();
  }
});

test("a brief send, made under a lock others wait on, waits 15 s at most and goes out once", async () => {
  const { hub, sends } = await node();
  jest.useFakeTimers();
  try {
    const { sendBrief } = await import("../src/hub/executor/sessions.ts");
    const brief = sendBrief(hub, thread, "push your work and wait", "req-1").catch((e) => e);
    await tick(0);
    await tick(15_000);
    const e = (await brief) as ExecutorError;
    expect(e.extra.nodeMessage).toBe("no answer within 15 s");
    expect(sends().length).toBe(1);
  } finally {
    jest.useRealTimers();
    hub.shutdown.abort();
  }
});
