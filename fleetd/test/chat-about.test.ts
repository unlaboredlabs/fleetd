// Which order a chat message is about and whom it is for (chat/about.ts): from the lead's calls and wakes of the turn,
// the order's starter and the person the turn answered.
import { expect, test } from "bun:test";
import { Hub } from "../src/hub/api/hub.ts";
import { aboutFor, callOrder, orderFor, requestOrder, touched, turnOrder } from "../src/hub/chat/about.ts";
import { HubDb } from "../src/hub/store/db.ts";
import type { HumanRequest } from "../src/shared/contracts.ts";

const r = { machineId: "devbox", projectId: "p1" };
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const ALICE = { personId: "p_aaaaaaaa", name: "Alice Chen" };
const DANA = { personId: "p_dddddddd", name: "Dana Park" };

function rig(now = T0 + 60_000) {
  let at = now;
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => at });
  const c = hub.db.conn;
  c.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'p1', 'lead-1', 'x', 1)");
  const order = (n: number, startedBy?: object) =>
    c.run("INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (?1, 'devbox', 'p1', 'open', ?2)", [
      n,
      JSON.stringify({ workstreamId: `W${n}`, ...(startedBy ? { startedBy } : {}) }),
    ]);
  const event = (ms: number, type: string, data: object) =>
    c.run("INSERT INTO events (created_ms, type, machine_id, data) VALUES (?1, ?2, 'devbox', ?3)", [
      ms,
      type,
      JSON.stringify({ type, machineId: "devbox", projectId: "p1", threadId: "lead-1", data }),
    ]);
  let seq = 0;
  const human = (ms: number, person: object) =>
    c.run("INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, held, data) VALUES ('devbox', 'p1', ?1, ?2, 0, ?3)", [
      ++seq,
      ms,
      JSON.stringify({ author: "human", delivery: "queued", person, text: "hi" }),
    ]);
  return { hub, order, event, human, setNow: (ms: number) => (at = ms) };
}

test("a turn that touched one order is about it, for the order's starter", () => {
  const { hub, order, event, human } = rig();
  order(3, DANA);
  // The run before ended at T0; Alice wrote after it, then the lead messaged W3's agent.
  event(T0, "thread.completed", { threadId: "lead-1" });
  human(T0 + 1000, ALICE);
  touched(hub, r, "W3", T0 + 2000);
  expect(turnOrder(hub, r, T0 + 3000)).toBe("W3");
  expect(aboutFor(hub, r, T0 + 3000)).toEqual({ workstreamId: "W3", for: DANA });
  // A touch from the run before doesn't count.
  expect(turnOrder(hub, r, T0 - 1)).toBeUndefined();
});

test("a turn that touched no order or several is about none, for the person it answered", () => {
  const { hub, order, event, human } = rig();
  order(3, DANA);
  order(4, ALICE);
  event(T0, "thread.completed", { threadId: "lead-1" });
  human(T0 + 1000, ALICE);
  expect(aboutFor(hub, r, T0 + 3000)).toEqual({ for: ALICE });
  touched(hub, r, "W3", T0 + 2000);
  touched(hub, r, "W4", T0 + 2500);
  expect(aboutFor(hub, r, T0 + 3000)).toEqual({ for: ALICE });
});

test("a wake all about one order touches it; one about several doesn't", () => {
  const { hub, order, event } = rig();
  order(5);
  event(T0, "thread.completed", { threadId: "lead-1" });
  event(T0 + 1000, "lead.woken", { triggers: ["task_result", "quiet"], workstreamIds: ["W5", "W6"] });
  expect(turnOrder(hub, r, T0 + 2000)).toBeUndefined();
  // The next run: woken about W5 alone. An automation's order has no starter, and no person wrote.
  event(T0 + 5000, "thread.completed", { threadId: "lead-1" });
  event(T0 + 6000, "lead.woken", { triggers: ["task_result"], workstreamIds: ["W5"] });
  expect(aboutFor(hub, r, T0 + 7000)).toEqual({ workstreamId: "W5" });
});

test("a message stamped after its run ended still reads that run", () => {
  const { hub, order, event, setNow } = rig();
  order(3, DANA);
  event(T0, "thread.completed", { threadId: "lead-1" });
  touched(hub, r, "W3", T0 + 2000);
  event(T0 + 4000, "thread.completed", { threadId: "lead-1" });
  // The next run touched another order.
  touched(hub, r, "W9", T0 + 5000);
  setNow(T0 + 6000);
  expect(turnOrder(hub, r, T0 + 3000)).toBe("W3");
  expect(turnOrder(hub, r, T0 + 5500)).toBe("W9");
});

test("a call's order, a request's order and an order's starter", () => {
  const { hub, order } = rig();
  order(7, ALICE);
  hub.db.conn.run("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (12, 'devbox', 'p1', 'W7', 'running', 'th-12', '{}')");
  expect(callOrder(hub, { op: "brief_create" }, { workstreamId: "W7" })).toBe("W7");
  expect(callOrder(hub, { op: "gated_run", workstreamId: "W7" }, {})).toBe("W7");
  expect(callOrder(hub, { op: "request_secret", sink: "order:W7" }, {})).toBe("W7");
  expect(callOrder(hub, { op: "task_message", taskId: "T12" }, {})).toBe("W7");
  expect(callOrder(hub, { op: "task_message", taskId: "T99" }, {})).toBeUndefined();
  const base = { requestId: "Q1", projectRef: r, kind: "approval", state: "open", text: "x", createdAt: "x" } as unknown as HumanRequest;
  expect(requestOrder(hub, { ...base, workstreamId: "W7" })).toBe("W7");
  expect(requestOrder(hub, { ...base, permission: { threadId: "th-12" } } as unknown as HumanRequest)).toBe("W7");
  expect(requestOrder(hub, base)).toBeUndefined();
  expect(orderFor(hub, "W7")).toEqual(ALICE);
  expect(orderFor(hub, "W8")).toBeUndefined();
});
