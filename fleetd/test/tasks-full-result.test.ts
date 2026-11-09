// A task's whole final result (crates/fleetd/src/hub/tasks/mod.rs tests `a_lead_reads_a_long_result_whole_by_its_task_id`
// and `a_short_or_huge_result_keeps_what_it_should`): the stored tail keeps a long result's ends, and `agents` with its
// taskId returns it whole.
import { expect, test } from "bun:test";
import { MESSAGE_KEPT } from "../src/hub/executor/shell_mapper.ts";
import { leadCall } from "../src/hub/tasks/calls.ts";
import { fullResultText, resultText, taskResultLines } from "../src/hub/tasks/render.ts";
import type { Task, TaskResult } from "../src/shared/contracts.ts";
import { tasksKit, until } from "./tasks-kit.ts";

test("a lead reads a long result whole by its task id, read from the node past the summary's 4 KB", async () => {
  const k = tasksKit();
  void k.t.run();
  const reader = await k.spawn("audit the stalls", "read");
  let whole = Array.from(
    { length: 100 },
    (_, i) => `Cause ${String(i + 1).padStart(3, "0")}: the node dropped its link and nothing woke the agent again.\n`,
  )
    .join("")
    .trim();
  expect(whole.length > 7_000 && whole.length < 10_500).toBe(true);
  whole = `${whole}\n${"Fix: one bad frame drops only itself. ".repeat(80).trim()}`;
  expect(whole.length).toBeGreaterThanOrEqual(10_000);
  const thread = reader.threadRef?.threadId as string;
  k.threadRow(thread, "completed", resultText(whole, MESSAGE_KEPT), { headline: "Cause 001" });
  k.ports.latest = whole;
  k.thread("thread.completed", thread, { runId: "r1", endCause: "completed" });
  await until(() => k.t.get(reader.taskId)?.state === "done");

  // The stored tail keeps its ends around a "…" line, and the wake says how to read it whole.
  const ended = k.t.get(reader.taskId) as Task;
  const result = ended.result as TaskResult;
  expect(result.tail.includes("\n…\n") && [...result.tail].length <= 2000).toBe(true);
  const lines = taskResultLines(reader.taskId, "audit the stalls", result, false);
  expect(lines).toContain(`\`agents\` with taskId ${reader.taskId} has it whole`);

  // Only the per-task read carries it.
  const lead = { ...k.lead, agent: { kind: "lead" as const } };
  const one = (await leadCall(k.hub, k.t, lead, { op: "task_list", taskId: reader.taskId })) as { fullResult?: string };
  expect(one.fullResult).toBe(whole);
  const all = (await leadCall(k.hub, k.t, lead, { op: "task_list" })) as { fullResult?: string };
  expect(all.fullResult).toBeUndefined();
  expect(JSON.stringify(all)).not.toContain("Cause 050");
  k.hub.shutdown.abort();
});

test("a short result is whole in its tail, and a huge one is cut at 32 KB with a note", () => {
  expect(fullResultText("Done: PR #12.")).toBeUndefined();
  const huge = "y".repeat(40 * 1024);
  const cut = fullResultText(huge) as string;
  expect(cut.startsWith("y".repeat(32 * 1024))).toBe(true);
  expect(cut.endsWith("\n\n[cut at 32 KB of 40 KB]")).toBe(true);
  expect(taskResultLines("T1", "t", { status: "done", tail: "Done.", at: "2026-11-08T10:00:00.000Z" }, false)).not.toContain("fullResult");
});
