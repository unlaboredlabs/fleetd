// Steering (crates/fleetd/src/hub/steer/tests.rs): a person's words to a running agent, with receipts.
import { expect, test } from "bun:test";
import { registerAll } from "../src/gen/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { leads } from "../src/hub/leads/index.ts";
import { queuePorts } from "../src/hub/leads/seams.ts";
import { digestLine, onReceipt, RECEIPT_GRACE_MS, sweep } from "../src/hub/steer/index.ts";
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
  Object.assign(queuePorts(t.hub), {
    send: async (_thread: unknown, message: string, _crid: string, _wake: unknown, opts?: { mode?: string; steer?: string }) => {
      sends.push([message, opts?.mode ?? "", opts?.steer]);
      return { queued: false };
    },
  });
  return { ...t, w: workstream.workstreamId, sends };
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
