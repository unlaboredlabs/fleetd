// Steering (crates/fleetd/src/hub/steer/tests.rs): a person's words to a running agent, with receipts.
import { expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { leads } from "../src/hub/leads/index.ts";
import { type SendOpts, WriteQueue } from "../src/hub/queue/index.ts";
import { digestLine, onReceipt, RECEIPT_GRACE_MS, steerTasks, sweep } from "../src/hub/steer/index.ts";
import { start } from "../src/hub/steer/loops.ts";
import { taskHooks } from "../src/hub/tasks/ports.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import type { Task } from "../src/shared/contracts.ts";
import { events } from "../src/hub/store/events.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const tools = new Registry();
registerAll(tools);
const person = caller("operate", true);

function setup() {
  const t = testHub();
  const { workstream } = leads(t.hub).records.workstreamCreate({ projectRef: PROJECT, title: "Dark mode", text: "add dark mode", channel: "app", by: "human", at: "2026-11-08T10:00:00.000Z" });
  leads(t.hub).records.leadPut({ projectRef: PROJECT, threadId: "lead-1", startedAt: "2026-11-08T10:00:00.000Z", sessionGeneration: 1 });
  const sends: [string, string, string | undefined][] = [];
  // The real write queue over a node writer that records what reaches the node.
  const node = { online: true };
  t.hub.area(
    "write_queue",
    (h) =>
      new WriteQueue(h, {
        isConnected: () => node.online,
        awaitLive: () => new Promise<void>(() => {}),
        sendWith: async (_thread, message: string, _crid: string, opts: SendOpts) => {
          sends.push([message, opts.mode ?? "", opts.steer]);
          return {};
        },
      }),
  );
  return { ...t, w: workstream.workstreamId, sends, node };
}

test("a steer to an order's lead goes out once with its receipts, then can't be withdrawn", async () => {
  const { hub, w, sends, done } = setup();
  const input = { target: { workstreamId: w }, text: "use the blue one", mode: "now", clientRequestId: "c1", refs: [{ kind: "file", path: "src/app.css" }] };
  const out = (await tools.call(hub, person, "steer_send", input)) as { output: any };
  expect(out.output).toMatchObject({ id: "S1", stage: "queued", mode: "now", thread: { machineId: "lab-a", threadId: "lead-1" } });
  expect(out.output.next).toContain("steer.delivered");
  expect(sends.length).toBe(1);
  expect(sends[0]?.[0]).toContain("use the blue one");
  expect(sends[0]?.[0]).toContain("References:\n  - `src/app.css`");
  expect(sends[0]?.slice(1)).toEqual(["now", "S1"]);
  // A retried request returns the stored steer and sends nothing.
  expect(((await tools.call(hub, person, "steer_send", input)) as { output: any }).output.id).toBe("S1");
  expect(sends.length).toBe(1);
  const receipt = (stage: string, extra: Record<string, unknown> = {}) =>
    onReceipt(hub, "lab-a", { sessionId: "lead-1", runId: out.output.runId, steerId: "S1", stage, at: "2026-11-08T10:01:00.000Z", ...extra } as never);
  receipt("delivered", { how: "stopped", stoppedTool: "Bash" });
  receipt("queued");
  receipt("acknowledged", { excerpt: "switching to blue" });
  const kinds = events(hub)
    .page(0)
    .events.filter((e) => e.type.startsWith("steer."))
    .map((e) => [e.type, e.summary]);
  expect(kinds).toEqual([
    ["steer.queued", "S1 to the lead of W1: 'use the blue one'"],
    ["steer.delivered", "S1 reached the lead of W1: it stopped `Bash`"],
    ["steer.acknowledged", "the lead of W1 acknowledged S1"],
  ]);
  expect(await tools.call(hub, person, "steer_withdraw", { steerId: "S1" })).toMatchObject({ error: { error: { code: "invalid", message: "S1 was already delivered at 10:01:00." } } });
  expect(await tools.call(hub, caller("operate"), "steer_send", { ...input, clientRequestId: "c2" })).toMatchObject({ error: { error: { code: "forbidden" } } });
  done();
});

test("a steer nobody acknowledged closes on the sweep; another device can't withdraw it", async () => {
  const { hub, clock, w, done } = setup();
  const out = (await tools.call(hub, person, "steer_send", { target: { workstreamId: w }, text: "stop", clientRequestId: "c1" })) as { output: any };
  expect(await tools.call(hub, { ...person, keyId: "key_other" }, "steer_withdraw", { steerId: out.output.id })).toMatchObject({ error: { error: { code: "forbidden" } } });
  expect(sweep(hub)).toBe(0);
  clock.ms += RECEIPT_GRACE_MS;
  expect(sweep(hub)).toBe(1);
  const last = events(hub).page(0).events.at(-1);
  expect(last).toMatchObject({ type: "steer.failed", data: { reason: "lab-a's node lost it before the agent took it in: it restarted, or is older than this hub" } });
  done();
});

test("a closed order takes no steer; the digest names a person's steers to tasks", async () => {
  const { hub, w, done } = setup();
  const records = leads(hub).records;
  const ws = records.workstreamGet(w);
  records.workstreamPut({ ...(ws as NonNullable<typeof ws>), state: "done" });
  expect(await tools.call(hub, person, "steer_send", { target: { workstreamId: w }, text: "x", clientRequestId: "c1" })).toMatchObject({
    error: { error: { code: "invalid", message: "W1 has ended; its lead no longer works on it." } },
  });
  expect(digestLine(hub, w)).toBeUndefined();
  expect(await tools.call(hub, person, "steer_send", { target: { taskId: "T9" }, text: "x", clientRequestId: "c2" })).toMatchObject({ error: { error: { code: "not_found" } } });
  done();
});

test("a steer to an offline machine waits in the write queue, and withdrawing it drops it there", async () => {
  const { hub, w, sends, node, done } = setup();
  node.online = false;
  const input = { target: { workstreamId: w }, text: "hold on", mode: "queue", clientRequestId: "c9" };
  const out = (await tools.call(hub, person, "steer_send", input)) as { output: any };
  expect(out.output.detail).toStartWith("waiting for lab-a (until ");
  expect(sends.length).toBe(0);
  expect(sweep(hub)).toBe(0);
  const back = (await tools.call(hub, person, "steer_withdraw", { steerId: out.output.id })) as { output: any };
  expect(back.output.stage).toBe("withdrawn");
  done();
});

test("steer's start gives tasks its held steers: a task's next run takes one, and one that never went out is held again", async () => {
  const { hub, w, done } = setup();
  TaskRecords.create(hub.db.conn, {
    taskId: "T1",
    projectRef: PROJECT,
    workstreamId: w,
    title: "the toggle",
    kind: "write",
    prompt: "do it",
    state: "idle",
    threadRef: { machineId: "lab-a", threadId: "t1" },
    attempt: 1,
    createdAt: "2026-11-08T10:00:00.000Z",
  } as Task);
  Object.assign(steerTasks(hub), { message: async () => {} });
  const out = (await tools.call(hub, person, "steer_send", { target: { taskId: "T1" }, text: "use blue", mode: "queue", clientRequestId: "c1" })) as { output: any; error?: any };
  if (out.error) throw new Error(JSON.stringify(out.error));
  expect(out.output.detail).toBe("queued until T1 starts; it gets this with its next run");
  start(hub);
  const hook = taskHooks(hub).steer;
  const thread = { machineId: "lab-a", threadId: "t1" };
  expect(hook?.takeHeld("T1", thread, "run-1")).toEqual({ id: out.output.id, riders: [] });
  expect(hook?.takeHeld("T1", thread, "run-1")).toBeUndefined();
  hook?.rehold(out.output.id);
  expect(hook?.takeHeld("T1", thread, "run-2")?.id).toBe(out.output.id);
  done();
});
