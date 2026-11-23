// A task's whole final result (crates/fleetd/src/hub/tasks/mod.rs tests `a_lead_reads_a_long_result_whole_by_its_task_id`
// and `a_short_or_huge_result_keeps_what_it_should`): the stored tail keeps a long result's ends, and `agents` with its
// taskId returns it whole.
import { expect, test } from "bun:test";
import { MESSAGE_KEPT } from "../src/hub/executor/shell_mapper.ts";
import { ASSISTANT_TAIL, assistantTail } from "../src/node/sessions/state.ts";
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

test("a result the node's summary kept only the end of is read whole: fullResult holds it and the wake keeps its head", async () => {
  const k = tasksKit();
  void k.t.run();
  const writer = await k.spawn("finish the sheet", "write");
  const whole = [
    "Steps for the person: 1. Open Settings › Connections. 2. Press Connect next to Notion. 3. Sign in.",
    ...Array.from({ length: 60 }, (_, i) => `PR #${1900 + i} landed and its pin moved to include it.`),
    "Done: the sheet is finished.",
  ].join("\n");
  expect(whole.length).toBeGreaterThan(3_000);
  const thread = writer.threadRef?.threadId as string;
  // The node's session summary carries only the reply's last 2000 units, cut mid-sentence and unmarked.
  const nodeTail = whole.slice(-2000);
  k.threadRow(thread, "completed", resultText(nodeTail, MESSAGE_KEPT), { headline: nodeTail.split("\n")[0] as string });
  k.ports.latest = whole;
  k.thread("thread.completed", thread, { runId: "r1", endCause: "completed" });
  await until(() => k.t.get(writer.taskId)?.state === "done");

  const result = (k.t.get(writer.taskId) as Task).result as TaskResult;
  expect(result.tail.startsWith("Steps for the person: 1. Open Settings")).toBe(true);
  expect(result.tail).toContain("\n…\n");
  expect(result.tail).toContain("Done: the sheet is finished.");
  expect(taskResultLines(writer.taskId, "finish the sheet", result, false)).toContain("Steps for the person");
  const lead = { ...k.lead, agent: { kind: "lead" as const } };
  const one = (await leadCall(k.hub, k.t, lead, { op: "task_list", taskId: writer.taskId })) as { fullResult?: string };
  expect(one.fullResult).toBe(whole);
  k.hub.shutdown.abort();
});

test("the node's summary marks a cut reply, so it never reads as a whole one", () => {
  expect(assistantTail("Done: PR #12.")).toBe("Done: PR #12.");
  const long = `${"a".repeat(ASSISTANT_TAIL)}the end`;
  const cut = assistantTail(long);
  expect(cut.length).toBe(ASSISTANT_TAIL);
  expect(cut.startsWith("…a")).toBe(true);
  expect(cut.endsWith("the end")).toBe(true);
});

test("a short result is whole in its tail, and a huge one is cut at 32 KB with a note", () => {
  expect(fullResultText("Done: PR #12.")).toBeUndefined();
  const huge = "y".repeat(40 * 1024);
  const cut = fullResultText(huge) as string;
  expect(cut.startsWith("y".repeat(32 * 1024))).toBe(true);
  expect(cut.endsWith("\n\n[cut at 32 KB of 40 KB]")).toBe(true);
  expect(taskResultLines("T1", "t", { status: "done", tail: "Done.", at: "2026-11-08T10:00:00.000Z" }, false)).not.toContain("fullResult");
});
