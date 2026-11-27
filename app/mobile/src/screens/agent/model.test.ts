import { describe, expect, it } from "vitest";
import type { AgentRow, Task, WorkStep } from "../../desktop";
import { endedLine, fileRow, hasEnded, nowWords, recentlyEnded, stepRow } from "./model";

const AT = "2026-11-26T18:00:00.000Z";
const row = (laneId: string, patch: Partial<AgentRow>): AgentRow =>
  ({ laneId, role: "implementer", status: "working", title: laneId, taskId: laneId, projectRef: { machineId: "m", projectId: "p" }, projectTitle: "shop", ...patch }) as AgentRow;

describe("an agent's page on the phone", () => {
  it("heads a finished agent with how it ended and how long it ran", () => {
    const task = { state: "done", createdAt: AT, startedAt: AT, endedAt: "2026-11-26T18:12:40.000Z" } as Task;
    expect(endedLine(task)).toBe("Finished · ran 12m 40s");
    expect(endedLine({ ...task, state: "cancelled", endedAt: undefined } as unknown as Task)).toBe("Stopped");
    expect(endedLine({ ...task, state: "running" })).toBeUndefined();
  });

  it("says what it does now in a sentence, file names without code marks", () => {
    expect(nowWords(row("T1", { live: { laneId: "T1", status: "working", activity: { activity: { kind: "edit", path: "src/app/theme.ts" }, since: AT } } } as Partial<AgentRow>))).toBe("Editing theme.ts");
    expect(nowWords(row("T1", {}))).toBeUndefined();
  });

  it("shows a step as what it said or what it did, with the command or path under it", () => {
    const action = (kind: string, summary: string, extra = {}): WorkStep => ({ kind: "action", id: summary, at: AT, action: { at: AT, kind, status: "completed", failed: false, summary, ...extra } }) as WorkStep;
    expect(stepRow(action("file_change", "src/app/theme.ts"))).toMatchObject({ title: "Edited theme.ts", detail: "src/app/theme.ts", said: false });
    expect(stepRow(action("command", "npm test", { failed: true, exitCode: 1 }))).toMatchObject({ title: "Ran · failed, exit 1", detail: "npm test", failed: true });
    expect(stepRow({ kind: "message", id: "m", at: AT, role: "assistant", text: "Done." } as WorkStep)).toMatchObject({ title: "Done.", said: true });
    expect(stepRow({ kind: "message", id: "m", at: AT, role: "assistant", text: "  " } as WorkStep)).toBeUndefined();
  });

  it("lists a changed file by name, its folder and its lines", () => {
    expect(fileRow({ path: "inventory/reports/restock.py", additions: 7, deletions: 2 })).toEqual({ title: "restock.py", detail: "inventory/reports", value: "+7 −2" });
    expect(fileRow({ path: "logo.png", additions: 0, deletions: 0 })).toEqual({ title: "logo.png", detail: undefined, value: "binary" });
  });

  it("lists under the working agents those that ended in the last day, newest first, never the lead", () => {
    const now = Date.parse("2026-11-27T10:00:00.000Z");
    const agents = [
      row("T1", { status: "done", endedAt: "2026-11-27T09:00:00.000Z" }),
      row("T2", { status: "failed", endedAt: "2026-11-27T09:30:00.000Z" }),
      row("T3", { status: "done", endedAt: "2026-11-25T09:00:00.000Z" }),
      row("T4", {}),
      row("lead", { role: "lead", status: "done", endedAt: "2026-11-27T09:59:00.000Z" }),
    ];
    expect(recentlyEnded(agents, now).map((a) => a.laneId)).toEqual(["T2", "T1"]);
    expect([hasEnded(agents[0]!), hasEnded(agents[3]!)]).toEqual([true, false]);
  });
});
