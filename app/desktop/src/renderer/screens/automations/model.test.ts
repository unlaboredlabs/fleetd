import { describe, expect, it } from "vitest";
import type { Automation, MemoryRefreshJob } from "../../../shared/contracts";
import {
  createInput,
  draftOf,
  emptyDraft,
  hasProblems,
  orderHref,
  problems,
  refreshChanges,
  refreshRuns,
  refreshSchedule,
  runChip,
  runNote,
  triggersLine,
  updateInput,
  when,
} from "./model";

const project = { machineId: "devbox", projectId: "storefront" };
const nightly: Automation = {
  automationId: "au_k3Jd8sQp2xYz",
  projectRef: project,
  name: "Dependency check",
  prompt: "Check the dependencies for updates.",
  schedule: { cron: "0 9 * * 1-5", tz: "Europe/Berlin" },
  webhook: false,
  paused: false,
  nextRunAt: "2026-10-19T07:00:00.000Z",
  createdBy: "human",
  createdAt: "2026-10-17T10:00:00.000Z",
  updatedAt: "2026-10-17T10:00:00.000Z",
};

describe("the automation editor", () => {
  it("says what the hub would refuse before the save", () => {
    const d = { ...emptyDraft("Europe/Berlin"), cron: "0 25 * * *" };
    expect(problems(d)).toEqual({
      name: "Give it a name.",
      prompt: "Say what the lead should do on each run.",
      cron: "hour 25 is outside 0-23.",
    });
    expect(hasProblems(problems({ ...d, name: "Report", prompt: "Write it.", cron: "0 9 * * 1" }))).toBe(false);
    // Without a schedule the cron isn't read.
    expect(problems({ ...d, name: "Report", prompt: "Write it.", scheduled: false })).toEqual({});
  });

  it("creates with the schedule only when it has one", () => {
    const d = { ...emptyDraft("UTC"), name: " Report ", prompt: "Write it.", scheduled: false, webhook: true };
    expect(createInput(d, project, "c1")).toEqual({ projectRef: project, name: "Report", prompt: "Write it.", webhook: true, clientRequestId: "c1" });
  });

  it("sends an edit's changes only, and taking the schedule off as removeSchedule", () => {
    const d = draftOf(nightly, "UTC");
    expect(updateInput(nightly, d)).toBeNull();
    expect(updateInput(nightly, { ...d, cron: "0 10 * * 1-5" })).toEqual({
      automationId: nightly.automationId,
      schedule: { cron: "0 10 * * 1-5", tz: "Europe/Berlin" },
    });
    expect(updateInput(nightly, { ...d, scheduled: false, webhook: true })).toEqual({
      automationId: nightly.automationId,
      removeSchedule: true,
      webhook: true,
    });
  });
});

describe("the automation list", () => {
  it("reads its triggers in a line", () => {
    expect(triggersLine(nightly)).toBe("At 09:00, Monday to Friday (Europe/Berlin)");
    expect(triggersLine({ ...nightly, webhook: true })).toBe("At 09:00, Monday to Friday (Europe/Berlin) · Webhook");
    const { schedule: _, ...bare } = nightly;
    expect(triggersLine(bare)).toBe("Run now only");
  });

  it("shows a run's state, why it didn't run, and links its order's page", () => {
    expect(runChip({ state: "running" })).toEqual({ tone: "working", label: "Running" });
    expect(runChip({ state: "something_new" })).toEqual({ tone: "quiet", label: "something_new" });
    const run = { runId: "ar_a1b2c3d4", automationId: nightly.automationId, trigger: "webhook", at: "2026-10-17T10:00:00.000Z", state: "skipped" } as const;
    expect(runNote({ ...run, why: "run ar_x is still going (W12 is open)" })).toBe("run ar_x is still going (W12 is open)");
    expect(runNote({ ...run, payloadBytes: 2048 })).toBe("Body of 2,048 bytes.");
    expect(orderHref("W12")).toBe("#/time/order/W12");
  });
});

describe("the nightly memory refresh's row", () => {
  const job: MemoryRefreshJob = { on: true, at: "04:00", tz: "Europe/Berlin", nextRunAt: "2026-10-28T03:00:00.000Z" };
  const run = { at: "2026-10-27T03:00:00.000Z", trigger: "schedule", state: "done", added: 1, replaced: 2, removed: 1 } as const;

  it("reads its hour in the hub's zone", () => {
    expect(refreshSchedule(job)).toBe("Every night at 04:00 (Europe/Berlin)");
  });

  it("counts what it changed as its chat line does", () => {
    expect(refreshChanges(run)).toBe("1 added, 2 updated, 1 removed");
    expect(refreshChanges({ added: 0, replaced: 0, removed: 3 })).toBe("3 removed");
    expect(refreshChanges({ added: 0, replaced: 0, removed: 0 })).toBe("no changes");
  });

  it("says its next run, and its last with what it changed or why it was skipped", () => {
    expect(refreshRuns(job)).toBe(`Next run ${when("2026-10-28T03:00:00.000Z")} · Not run yet`);
    expect(refreshRuns({ ...job, lastRun: run })).toBe(`Next run ${when(job.nextRunAt ?? "")} · Last run ${when(run.at)}: done, 1 added, 2 updated, 1 removed`);
    const skipped = { ...run, state: "skipped", added: 0, replaced: 0, removed: 0, why: "Nothing new in the chat or its orders since the last refresh." } as const;
    expect(refreshRuns({ ...job, lastRun: skipped })).toContain("skipped: Nothing new in the chat or its orders since the last refresh.");
    const manual = { ...run, trigger: "manual", state: "running", added: 0, replaced: 0, removed: 0 } as const;
    expect(refreshRuns({ ...job, lastRun: manual })).toContain(`Started ${when(run.at)} (Run now): running, no changes`);
    // Off: no next run.
    const { nextRunAt: _, ...off } = { ...job, on: false };
    expect(refreshRuns({ ...off, lastRun: run })).toBe(`Last run ${when(run.at)}: done, 1 added, 2 updated, 1 removed`);
  });
});
