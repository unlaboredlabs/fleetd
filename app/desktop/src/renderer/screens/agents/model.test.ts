import { describe, expect, it } from "vitest";
import type { AgentRow } from "../../src/data/agents-contract";
import type { LiveAgent } from "../../src/data/selectors";
import { actionLine, headline, listItems } from "./model";

const agent = (project: string, laneId: string, status: AgentRow["status"] = "working"): LiveAgent => ({
  id: `devbox/${project}/${laneId}`,
  project: `devbox/${project}`,
  row: { laneId, role: "implementer", status, title: laneId, projectRef: { machineId: "devbox", projectId: project }, projectTitle: project },
});

describe("the agents list", () => {
  it("puts one line per project above its agents, with how many it runs", () => {
    const items = listItems([agent("api", "T1"), agent("api", "T2"), agent("web", "T3")]);
    expect(items.map((i) => (i.kind === "project" ? `${i.title} ${String(i.count)}` : i.agent.row.laneId))).toEqual(["api 2", "T1", "T2", "web 1", "T3"]);
    expect(listItems([])).toEqual([]);
  });

  it("heads the view with what works, what waits on you and what is queued", () => {
    expect(headline([agent("api", "T1"), agent("api", "T2", "starting"), agent("api", "T3", "waiting"), agent("web", "T4", "queued")])).toBe(
      "2 working · 1 waiting on you · 1 queued",
    );
    expect(headline([agent("api", "T1", "waiting")])).toBe("1 waiting on you");
    expect(headline([])).toBe("");
  });
});

describe("an agent's steps", () => {
  const step = (action: Partial<Extract<Parameters<typeof actionLine>[0], { kind: "action" }>["action"]>) =>
    actionLine({ kind: "action", id: "a1", at: "2026-10-19T10:00:00.000Z", action: { at: "2026-10-19T10:00:00.000Z", kind: "command", status: "completed", failed: false, summary: "npm test", ...action } });

  it("says each action in the past tense, the one running in the present, and a failure with its exit code", () => {
    expect(step({})).toEqual({ words: "ran", machine: "npm test", tone: "quiet" });
    expect(step({ status: "running" }).words).toBe("running");
    expect(step({ kind: "file_change", summary: "src/a.ts" }).words).toBe("edited");
    expect(step({ failed: true, status: "failed", exitCode: 1 })).toMatchObject({ tone: "danger", outcome: "failed, exit 1" });
    expect(step({ failed: true, status: "failed" }).outcome).toBe("failed");
    expect(step({ kind: "other", summary: "compacted" }).words).toBe("");
  });
});
