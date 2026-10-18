// M1 "done when": launch on lab-b through MCP, wait for completion with events_wait, read the reply back.
// One tiny haiku turn. Also: the doctor holds both lab machines' claude to the supported version range.
import { type Body, type Lab, launchTiny, MODEL } from "./harness.ts";

export async function m1Fleet(lab: Lab) {
  const { callTool, check, ok } = lab;
  const status = (await callTool("fleetd_status")).body;
  const projectB = status.projects.find((p: Body) => p.machineId === "lab-b");
  check(projectB, "lab-b has a project");
  const cursor = status.cursor as number;

  const doctor = (await callTool("doctor_list", { rerun: true })).body;
  for (const machineId of ["lab-a", "lab-b"]) {
    const entry = doctor.checks.find((c: Body) => c.id === `${machineId}/claude_version`);
    check(entry?.status === "ok", `doctor ${machineId}/claude_version is ok: ${JSON.stringify(entry)}`);
    ok(`doctor ${machineId}/claude_version: ${entry.message}`);
  }

  const threadId = await launchTiny(lab, "lab-b", projectB.projectId, "fleetd test:lab");
  ok(`thread_launch lab-b/${projectB.projectId} ${MODEL} effort=low -> ${threadId}`);

  const { event: done } = await lab.waitEvent("thread.completed for the launched thread", 240_000, {
    cursor,
    machineId: "lab-b",
    match: (e) => e.threadId === threadId && e.type !== "thread.started",
  });
  check(done.type === "thread.completed", `thread ended with ${done.type}: ${done.summary}`);
  ok(`events_wait: ${done.type} seq=${done.seq} "${done.summary}"`);

  const outcome = (await callTool("project_get", { machineId: "lab-b", projectId: projectB.projectId })).body;
  const summary = outcome.threads.find((t: Body) => t.threadId === threadId);
  check(summary?.status === "completed" && /OK/u.test(summary.headline), `project_get shows the reply: ${JSON.stringify(summary)}`);
  ok(`project_get: stale=${outcome.stale} thread status=${summary.status} headline="${summary.headline}"`);
  const tail = (await callTool("thread_tail", { machineId: "lab-b", threadId, n: 5 })).body;
  const reply = tail.items.find((i: Body) => i.kind === "message" && i.role === "assistant");
  check(reply && /OK/u.test(reply.text), `thread_tail has the assistant reply: ${JSON.stringify(tail.items)}`);
  ok(`thread_tail: ${tail.items.length} items, newest assistant text "${reply.text}"`);
}
