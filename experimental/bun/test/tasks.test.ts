// Task rows and the tasks tools (crates/fleetd/src/hub/tasks/records.rs's tests, tasks/tools.rs).
import { expect, test } from "bun:test";
import { listSql, TaskRecords } from "../src/hub/tasks/records.ts";
import { resultText } from "../src/hub/tasks/render.ts";
import type { ProjectRef, Task, TaskState } from "../src/shared/contracts.ts";
import { key, kit } from "./work-kit.ts";

const P1: ProjectRef = { machineId: "lab-a", projectId: "p1" };

function create(k: ReturnType<typeof kit>, projectId: string, workstreamId: string, state: TaskState, extra: Partial<Task> = {}): Task {
  return TaskRecords.create(k.hub.db.conn, {
    taskId: "T1",
    projectRef: { machineId: "lab-a", projectId },
    workstreamId,
    title: "do it",
    prompt: "do it",
    kind: "read",
    state,
    attempt: 1,
    createdAt: "2026-11-03T10:00:00.000Z",
    ...extra,
  } as Task);
}

test("a list names only its filters and reads by index", () => {
  const k = kit();
  const states: TaskState[] = ["queued", "running", "idle", "done", "failed", "running"];
  const all: Task[] = [];
  for (let i = 0; i < 30; i++) all.push(create(k, ["p1", "p2"][i % 2]!, ["W1", "W2", "W3"][i % 3]!, states[i % 6]!));
  all.reverse();
  for (const projectRef of [undefined, P1]) {
    for (const state of [undefined, "running", "done"] as const) {
      for (const workstreamId of [undefined, "W2"]) {
        for (const limit of [3, 500]) {
          const want = all
            .filter((t) => !projectRef || t.projectRef.projectId === projectRef.projectId)
            .filter((t) => !state || t.state === state)
            .filter((t) => !workstreamId || t.workstreamId === workstreamId)
            .slice(0, limit)
            .map((t) => t.taskId);
          const filter = { ...(projectRef ? { projectRef } : {}), ...(state ? { state } : {}), ...(workstreamId ? { workstreamId } : {}), limit };
          expect(TaskRecords.list(k.hub.db.conn, filter).map((t) => t.taskId)).toEqual(want);
        }
      }
    }
  }
  const [sql, args] = listSql({ state: "running", limit: 500 });
  const plan = k.hub.db.conn
    .query<{ detail: string }, typeof args>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((r) => r.detail);
  expect(plan).toEqual(["SEARCH tasks USING INDEX tasks_by_state (state=?)"]);
  expect(TaskRecords.counts(k.hub.db.conn, P1)).toEqual({ queued: 5, running: 0, idle: 5, done: 0, failed: 5, cancelled: 0 });
});

test("tasks_list and task_get keep to what the key may read", async () => {
  const k = kit();
  create(k, "p1", "W1", "running", { threadRef: { machineId: "lab-a", threadId: "s1" } } as Partial<Task>);
  create(k, "p2", "W2", "queued", { queuedReason: "waiting for a slot" } as Partial<Task>);
  const listed = await k.ok(key("read"), "tasks_list", {});
  expect(listed.tasks.map((t: Task) => t.taskId)).toEqual(["T2", "T1"]);
  expect(listed.next).toBe("Call task_get for one task's result, or thread_tail on its threadRef for its transcript.");
  const one = await k.ok(key("read"), "tasks_list", { projectRef: P1, limit: 1 });
  expect(one.tasks.length).toBe(1);
  expect((await k.ok(key("read"), "tasks_list", { projectRef: { machineId: "lab-a", projectId: "p2" }, limit: 1 })).truncated).toBeUndefined();
  expect((await k.ok(key("read", { machines: ["laptop"] }), "tasks_list", {})).tasks).toEqual([]);
  expect(await k.refused(key("read", { machines: ["laptop"] }), "tasks_list", { projectRef: P1 })).toBe("forbidden");
  expect((await k.ok(key("read"), "task_get", { taskId: "T1" })).next).toBe("Read its transcript with thread_tail (machineId lab-a, threadId s1).");
  expect((await k.ok(key("read"), "task_get", { taskId: "T2" })).next).toBe("T2 has not started: waiting for a slot.");
  expect(await k.refused(key("read"), "task_get", { taskId: "T9" })).toBe("not_found");
  expect(await k.refused(key("read", { machines: ["laptop"] }), "task_get", { taskId: "T1" })).toBe("not_found");
});

test("a long result keeps its head, its tail and every ref", () => {
  const body = `Opened https://github.com/acme/app/pull/12 with F7.\n${"x ".repeat(3000)}\nlast commit abc1234f`;
  const cut = resultText(body, 400);
  expect(cut.length).toBeLessThanOrEqual(400);
  expect(cut.startsWith("Opened https://github.com/acme/app/pull/12")).toBe(true);
  expect(cut.endsWith("Refs: https://github.com/acme/app/pull/12 F7 abc1234f")).toBe(true);
  expect(cut).toContain("\n…\n");
  // A text cut once already gets one Refs line, not two.
  expect(resultText(`${cut}${"y".repeat(200)}`, 400).match(/Refs: /g)?.length).toBe(1);
  expect(resultText("  short  ", 400)).toBe("short");
});
