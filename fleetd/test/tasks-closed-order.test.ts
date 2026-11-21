// An order that closes while one of its ended agents still waits (W763, 2026-11-21): closing it drops its variables,
// its GitHub token among them, at once. A writer woken after that by its own wait_ci ran on the token its claude
// started with, which GitHub had ended an hour later, and got 401 until it gave up. A closed order's ended tasks go on
// no more: their waits go, their claude is closed (a Monitor of theirs with it), and nothing continues them.
import { expect, test } from "bun:test";
import { type CiReads, pollCiWaits, type Read } from "../src/hub/tasks/ci_wait.ts";
import { leadCall } from "../src/hub/tasks/calls.ts";
import { leadWiring } from "../src/hub/leads/ports.ts";
import { PortError } from "../src/hub/tasks/launch.ts";
import { workstreams } from "../src/hub/leads/workstreams.ts";
import { P, tasksKit, until } from "./tasks-kit.ts";

const PR = "https://github.com/acme/shop/pull/7";

/** T1, a writer that ended its turn waiting on its PR's CI, in a project whose repo is acme/shop. */
async function waiting() {
  const k = tasksKit();
  void k.t.run();
  await k.spawn("fix the flake");
  k.threadRow("s1", "completed", "PR #7 is open; waiting on its CI.");
  k.thread("thread.completed", "s1", { runId: "r1" });
  await until(() => k.t.get("T1")?.state === "done");
  k.hub.db.conn
    .query(
      "INSERT INTO repos (machine_id, project_id, checkout_machine_id, checkout_project_id, name, repo_key) VALUES ('lab-a', 'p1', 'lab-a', 'p1', 'shop', 'github.com/acme/shop')",
    )
    .run();
  const agent = { projectRef: P, by: "lead:lab-a/p1", agent: { kind: "task" as const, taskId: "T1" } };
  await leadCall(k.hub, k.t, agent, { op: "wait_ci", url: PR });
  // The tasks area's hooks, as its start sets them.
  leadWiring(k.hub).hooks.tasks = {
    digestLines: () => [],
    agents: () => ({}) as never,
    cancel: async (r, id, why) => void (await k.t.cancel({ projectRef: r, by: "hub" }, id, why)),
    leftovers: (r, id) => k.t.liveIn(r, id),
    endFor: (r, id) => k.t.endFor(r, id),
  };
  return k;
}

test("a closed order's ended writer isn't woken by its wait_ci, and its claude is closed with the order", async () => {
  const k = await waiting();
  const closed = await workstreams(k.hub).close(P, k.w.workstreamId, "merged", "lead");
  expect(closed.next).toBe(
    "Closed. Dropped the CI and merge waits of T1: they won't wake, so nobody confirms those runs or merges.",
  );
  // Its claude (and any Monitor of it) is closed: nothing runs on the variables the order took with it.
  await until(() => k.ports.stops.some((s) => s.threadId === "s1"));
  // The CI it waited on finishes: nothing wakes it, and the wait is gone.
  const green: Read = { kind: "finished", conclusion: "success", label: "ci", failing: [], total: 3 };
  const reads: CiReads = { read: async () => green, merge: async () => ({ kind: "pending" }) };
  expect(await pollCiWaits(k.t, k.hub.db.conn, k.clock.ms, reads)).toBe(0);
  expect(k.ports.sends).toEqual([]);
  expect(k.t.get("T1")?.state).toBe("done");
  expect(k.hub.db.conn.query("SELECT COUNT(*) AS n FROM ci_waits").get()).toEqual({ n: 0 });
  k.hub.shutdown.abort();
});

test("a wait of an ended task whose order closed without `close` goes silently", async () => {
  const k = await waiting();
  // Closed some other way (a stop, a removal): the poll still never starts it.
  k.hub.db.conn.query("UPDATE workstreams SET state = 'stopped', data = json_set(data, '$.state', 'stopped') WHERE n = 1").run();
  const green: Read = { kind: "finished", conclusion: "success", label: "ci", failing: [], total: 3 };
  const reads: CiReads = { read: async () => green, merge: async () => ({ kind: "pending" }) };
  expect(await pollCiWaits(k.t, k.hub.db.conn, k.clock.ms, reads)).toBe(0);
  expect(k.ports.sends).toEqual([]);
  expect(k.t.get("T1")?.state).toBe("done");
  k.hub.shutdown.abort();
});

test("a lead's message to an ended task of a closed order is refused, saying why and what to do", async () => {
  const k = await waiting();
  await workstreams(k.hub).close(P, k.w.workstreamId, "merged", "lead");
  const refused = await k.t.message(k.lead, "T1", "confirm main is green").catch((e: Error & { fix?: string }) => e);
  expect(refused).toBeInstanceOf(Error);
  expect((refused as Error).message).toBe(
    "T1 can't go on: its order W1 is done, and its variables (its GitHub token among them) went with it.",
  );
  expect(k.ports.sends).toEqual([]);
  expect(k.t.get("T1")?.state).toBe("done");
  k.hub.shutdown.abort();
});

test("an agent its Monitor wakes after its order closed, its node offline at the close, is stopped, and no turn starts", async () => {
  const k = await waiting();
  // Its node is offline at the close: the stop doesn't reach it, and its Monitor lives on.
  const stop = k.ports.stop;
  k.ports.stop = async () => {
    throw PortError.offline("lab-a");
  };
  await workstreams(k.hub).close(P, k.w.workstreamId, "merged", "lead");
  k.ports.stop = stop;
  expect(k.ports.stops).toEqual([]);
  // It links again, and the Monitor fires: claude starts a turn of its own.
  k.threadRow("s1", "running");
  k.thread("thread.started", "s1", { runId: "t1-woke-1" });
  await until(() => k.ports.stops.some((s) => s.threadId === "s1"));
  expect(k.t.get("T1")).toMatchObject({ state: "done", attempt: 1 });
  expect(k.ports.sends).toEqual([]);
  k.hub.shutdown.abort();
});

test("closing an order says nothing of ended agents whose threads their node no longer knows", async () => {
  const k = await waiting();
  k.ports.stop = async (thread) => {
    throw new PortError(false, `thread ${thread.threadId} is not known on machine lab-a`, true);
  };
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  try {
    await workstreams(k.hub).close(P, k.w.workstreamId, "merged", "lead");
    await Bun.sleep(0);
  } finally {
    console.warn = warn;
  }
  expect(warned.filter((w) => w.includes("closed order"))).toEqual([]);
  k.hub.shutdown.abort();
});
