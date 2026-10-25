import { describe, expect, it } from "vitest";
import type { Automation } from "../../../shared/contracts";
import { createInput, draftOf, emptyDraft, hasProblems, orderHref, problems, runChip, runNote, triggersLine, updateInput } from "./model";

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
