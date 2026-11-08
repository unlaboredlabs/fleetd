// `artifact_read` (crates/fleetd/src/hub/artifacts/tests.rs `an_agent_reads_its_projects_artifacts_and_only_those`):
// a task reads back a report another task published in its project, newest or one version; a task of another project
// can't, and a report past the cap comes cut, with a note saying so.
import { expect, test } from "bun:test";
import { registerLeadCalls } from "../src/hub/artifacts/calls.ts";
import { ARTIFACT_READ_CAP } from "../src/hub/artifacts/index.ts";
import { leadBy, leadCalls } from "../src/hub/lead_calls/index.ts";
import { checkCall } from "../src/hub/lead_calls/policy.ts";
import type { CallerAgent, LeadCall } from "../src/hub/leads/seams.ts";
import type { ProjectRef } from "../src/shared/contracts.ts";
import { ToolError } from "../src/shared/errors.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

const REPORT = "# Sweep\n\nThree crates are behind:\n\n- tokio 1.40\n- axum 0.7\n- serde 1.0.200\n";

test("an agent reads its project's artifacts, whoever published them, and only those", async () => {
  const { hub, done } = testHub();
  const shop: ProjectRef = { machineId: PROJECT.machineId, projectId: "p2" };
  hub.db.conn
    .query("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (1, ?, ?, 'W1', 'done', ?)")
    .run(PROJECT.machineId, PROJECT.projectId, JSON.stringify({ title: "Sweep the dependencies" }));
  registerLeadCalls(hub);
  const call = async (r: ProjectRef, agent: CallerAgent, raw: Record<string, unknown>) => {
    const c = raw as LeadCall;
    checkCall(agent, c);
    return (await leadCalls(hub).handler(c.op)?.({ projectRef: r, by: leadBy(r), agent }, c)) as Record<string, any>;
  };
  const reads = (r: ProjectRef, agent: CallerAgent, input: Record<string, unknown>) =>
    call(r, agent, { op: "artifact_read", ...input });
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      if (error instanceof ToolError) return error;
      throw error;
    }
    throw new Error("not refused");
  };

  const writer: CallerAgent = { kind: "task", taskId: "T1" };
  for (const content of [REPORT, "# Sweep\n\nAll current."]) {
    await call(PROJECT, writer, { op: "artifact_publish", name: "sweep-report", title: "Dependency sweep", content });
  }
  const reader: CallerAgent = { kind: "task", taskId: "T2" };
  const newest = await reads(PROJECT, reader, { name: "sweep-report" });
  expect(newest.content).toBe("# Sweep\n\nAll current.");
  expect([newest.artifact.version, newest.artifact.by]).toEqual([2, "Sweep the dependencies"]);
  expect(newest.versions).toEqual([2, 1]);
  expect(newest.truncated).toBeUndefined();
  const first = await reads(PROJECT, reader, { name: "sweep-report", version: 1 });
  expect(first.content).toBe(REPORT);
  // The lead reads it too.
  expect((await reads(PROJECT, { kind: "lead" }, { name: "sweep-report" })).artifact.version).toBe(2);

  // Another project's agent finds none, and is told what its own project has.
  await call(shop, { kind: "lead" }, { op: "artifact_publish", name: "shop-notes", title: "Notes", content: "shop's" });
  const other = await refusal(reads(shop, reader, { name: "sweep-report" }));
  expect(other.code).toBe("not_found");
  expect(other.message).toContain("No artifact sweep-report in this project");
  expect(other.fix).toBe("This project's newest artifacts: shop-notes.");
  expect((await refusal(reads(PROJECT, reader, { name: "sweep-report", version: 3 }))).code).toBe("not_found");

  // Past the cap: its head, and a last line saying where it was cut.
  await call(PROJECT, writer, { op: "artifact_publish", name: "big", title: "Big", content: "x".repeat(ARTIFACT_READ_CAP + 5000) });
  const big = await reads(PROJECT, reader, { name: "big" });
  expect(big.truncated).toBe(true);
  expect((big.content as string).startsWith("x".repeat(ARTIFACT_READ_CAP))).toBe(true);
  expect((big.content as string).endsWith("[cut at 64 KB of 69 KB]")).toBe(true);
  done();
});
