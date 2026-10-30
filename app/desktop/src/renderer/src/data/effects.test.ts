import { describe, expect, it } from "vitest";
import { effectsOf, matches } from "./effects";
import type { HubEvent } from "../../../shared/contracts";

const e = (type: string, data?: Record<string, unknown>, extra: Partial<HubEvent> = {}): HubEvent => ({
  seq: 1,
  at: "2026-10-19T10:00:00.000Z",
  type,
  summary: type,
  ...(data === undefined ? {} : { data }),
  ...extra,
});

const tools = (event: HubEvent) => effectsOf(event).invalidate.map((i) => i.tool);

describe("event effects", () => {
  it("a request changing refetches its order card and detail, and the status", () => {
    const fx = effectsOf(e("request.updated", { requestId: "Q1", kind: "secret", state: "stored", workstreamId: "W1" }));
    expect(fx.invalidate.map((i) => i.tool)).not.toContain("asks_list");
    expect(fx.invalidate).toContainEqual({ tool: "requests_list" });
    expect(effectsOf(e("request.opened", { requestId: "Q2", kind: "approval", state: "open" })).invalidate).toContainEqual({ tool: "requests_list" });
    expect(fx.invalidate).toEqual(
      expect.arrayContaining([
        { tool: "orders_board" },
        { tool: "order_get", where: { workstreamId: "W1" } },
        { tool: "status_get" },
      ]),
    );
    expect(fx.resync).toBe(false);
  });

  it("a thread event refetches its project", () => {
    const thread = effectsOf(e("thread.completed", undefined, { threadId: "t1", machineId: "devbox", projectId: "storefront" }));
    expect(thread.invalidate).toContainEqual({ tool: "project_get", where: { machineId: "devbox", projectId: "storefront" } });
  });

  it("what moves a PR refetches the PR reads; only a new head its files and diff", () => {
    for (const type of ["change.state", "pr.merged", "review.verdict", "task.completed"]) {
      expect(tools(e(type))).toEqual(expect.arrayContaining(["pr_list", "pr_get"]));
    }
    expect(tools(e("change.state"))).toEqual(expect.arrayContaining(["pr_files", "pr_diff"]));
    expect(tools(e("task.completed"))).not.toContain("pr_diff");
    expect(tools(e("chat.message"))).not.toContain("pr_list");
  });

  it("the agents view: its list on what starts or ends an agent, one agent's work on its thread's events", () => {
    expect(tools(e("task.started", { workstreamId: "W1" }))).toContain("agents_list");
    expect(tools(e("lead.woken"))).toContain("agents_list");
    expect(tools(e("pr.merged", { workstreamId: "W1" }))).toContain("agents_list");
    expect(tools(e("machine.offline", undefined, { machineId: "devbox" }))).not.toContain("agents_list");
    const thread = effectsOf(e("thread.progress", undefined, { threadId: "t1" }));
    expect(thread.invalidate).toContainEqual({ tool: "agent_work", where: { threadId: "t1" } });
    expect(thread.invalidate.map((i) => i.tool)).not.toContain("agents_list");
  });

  it("the Elsewhere group: work_list on claims, landings and any project's writers and PRs", () => {
    for (const type of ["work.claimed", "work.ended", "work.landed", "task.started", "change.state", "pr.merged", "project.added"]) {
      expect(tools(e(type)), type).toContain("work_list");
    }
    expect(tools(e("lead.woken"))).not.toContain("work_list");
    expect(tools(e("thread.progress", undefined, { threadId: "t1" }))).not.toContain("work_list");
  });

  it("the hub's setup steps follow the doctor's checks and the hub's people", () => {
    expect(tools(e("doctor.changed"))).toEqual(["doctor_list", "setup_list"]);
    expect(tools(e("people.changed"))).toContain("setup_list");
  });

  it("your sidebar order moved on another desktop: this one reads it again, and nothing else", () => {
    expect(effectsOf(e("sidebar.order"))).toEqual({ invalidate: [{ tool: "sidebar_order_get" }], resync: false });
  });

  it("a machine or project coming or going resyncs; an unknown type does nothing", () => {
    expect(effectsOf(e("project.added")).resync).toBe(true);
    // A repo removed from a project can bring its checkout back as a project of its own.
    expect(effectsOf(e("project.settings")).resync).toBe(true);
    // A new picture (project_avatar_set): the summary's id comes with the resync, its bytes with a read of its own.
    expect(effectsOf(e("project.settings", { avatar: "a1b2c3d4e5f60718" }, { machineId: "devbox", projectId: "app" })).invalidate).toContainEqual({
      tool: "project_avatar_get",
      where: { machineId: "devbox", projectId: "app" },
    });
    // Add project's list marks the repos that are projects, so it is read again too.
    expect(tools(e("project.removed"))).toContain("project_discover");
    // A known machine's status is patched in place; only one the snapshot lacks resyncs.
    expect(effectsOf(e("machine.offline", undefined, { machineId: "devbox" }), { devbox: {} }).resync).toBe(false);
    expect(effectsOf(e("machine.online", undefined, { machineId: "buildbox" }), { devbox: {} }).resync).toBe(true);
    expect(effectsOf(e("rocket.launched"))).toEqual({ invalidate: [], resync: false });
    expect(tools(e("prompt.changed"))).toContain("prompt_get");
    // A lead's remember, an Undo or an edit elsewhere: Settings → Projects → Instructions & memory reads the files again, and Automations the
    // nightly refresh's row, with what a running refresh changed so far.
    expect(tools(e("memory.changed"))).toEqual(["memory_get", "automation_list"]);
    // A refresh started, ended or was skipped: the row reads its next and last run again.
    expect(tools(e("memory.refresh"))).toEqual(["automation_list"]);
    expect(tools(e("checklist.changed"))).toEqual(["checklist_get"]);
    // A preview moving: Try it reads the project's previews again, and nothing else.
    expect(tools(e("preview.state", { previewId: `P${"a".repeat(32)}`, state: "ready" }))).toEqual(["previews_list"]);
    // Status's health strip: a machine going quiet or sleeping, a usage reading.
    expect(tools(e("machine.slept", undefined, { machineId: "devbox" }))).toContain("status_get");
    expect(tools(e("pr.merged", { workstreamId: "W1" }))).toContain("status_get");
    expect(tools(e("pr.merged_outside", { repo: "acme/web", prNumber: 12 }))).toContain("status_get");
    expect(tools(e("machine.offline", undefined, { machineId: "devbox" }))).toContain("status_get");
    expect(tools(e("usage.updated"))).toContain("status_get");
  });

  it("the Factory's figures: a merge, a moved default branch, a change's stage and the person's acts, not agent chatter", () => {
    for (const type of ["pr.merged", "pr.merged_outside", "repo.advanced", "change.state", "chat.message", "decision.recorded", "app.presence"]) {
      expect(tools(e(type)), type).toContain("metrics_get");
    }
    for (const type of ["thread.completed", "task.started", "machine.online"]) expect(tools(e(type)), type).not.toContain("metrics_get");
  });

  it("the Decisions tab: a decision recorded or revoked, nothing else", () => {
    for (const type of ["decision.recorded", "decision.retired"]) expect(tools(e(type)), type).toContain("decisions_list");
    for (const type of ["chat.message", "task.completed", "workstream.state"]) expect(tools(e(type)), type).not.toContain("decisions_list");
  });

  it("refetches only the open order's time reads, never the paged spans whole", () => {
    const fx = effectsOf(e("task.completed", { workstreamId: "W1", taskId: "T3" }));
    expect(fx.invalidate).toContainEqual({ tool: "time_breakdown", where: { workstreamId: "W1" } });
    expect(tools(e("task.completed", { workstreamId: "W1" }))).not.toContain("time_spans");
    expect(tools(e("thread.completed", undefined, { threadId: "t1" }))).not.toContain("time_breakdown");
    const w1 = { scope: { kind: "order", workstreamId: "W1" }, since: "2026-10-19T00:00:00.000Z" };
    expect(matches(w1, { workstreamId: "W1" })).toBe(true);
    expect(matches(w1, { workstreamId: "W2" })).toBe(false);
    expect(matches({ workstreamId: "W1" }, { workstreamId: "W1" })).toBe(true);
  });

  it("a lead woken for several orders refetches each one's detail and time", () => {
    const fx = effectsOf(e("lead.woken", { workstreamIds: ["W1", "W2"], triggers: ["task"] }));
    for (const id of ["W1", "W2"]) {
      expect(fx.invalidate).toContainEqual({ tool: "order_get", where: { workstreamId: id } });
      expect(fx.invalidate).toContainEqual({ tool: "time_breakdown", where: { workstreamId: id } });
      expect(fx.invalidate).toContainEqual({ tool: "time_insights", where: { workstreamId: id } });
    }
  });

});
