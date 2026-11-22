import { describe, expect, it } from "vitest";
import type { Automation } from "../../../shared/contracts";
import { dollars, offered, sentenceProblem, usageWord, watcherInput, watchLine } from "./watchModel";

const watcher = (extra: Partial<Automation>): Automation => ({
  automationId: "au_aaaaaaaa",
  projectRef: { machineId: "m", projectId: "p" },
  name: "Main's CI",
  prompt: "Main's CI",
  webhook: false,
  paused: false,
  createdBy: "human",
  createdAt: "2026-11-22T10:00:00Z",
  updatedAt: "2026-11-22T10:00:00Z",
  watch: { kind: "main_ci", every: "15m" },
  ...extra,
});

describe("watching", () => {
  it("says how often, which profile and what the last day cost", () => {
    expect(watchLine(watcher({ lastDay: { runs: 96, spoke: 2, costUsd: 1.234 } }), "opus")).toBe("Every 15 min · opus · $1.23 in 24 h");
    expect(watchLine(watcher({ watch: { kind: "other", every: "day", profile: "sonnet" } }), "opus")).toBe("Daily at 09:00 · sonnet · Not looked yet");
    expect(usageWord(watcher({ lastDay: { runs: 0, spoke: 0, costUsd: 0 }, lastRun: { runId: "ar_aaaaaaaa", automationId: "au_aaaaaaaa", trigger: "schedule", at: "2026-11-20T10:00:00Z", state: "done" } }))).toBe("$0 in 24 h");
    expect([dollars(0.0042), dollars(0.5)]).toEqual(["$0.0042", "$0.50"]);
  });

  it("offers each preset the bot can have once, and Something else always", () => {
    expect(offered(["main_ci", "deploys", "other"], [])).toEqual(["main_ci", "deploys", "other"]);
    expect(offered(["main_ci", "other"], [watcher({})])).toEqual(["other"]);
    expect(offered(undefined, [])).toEqual(["other"]);
  });

  it("saves a preset by its name and Something else by its sentence", () => {
    const r = { machineId: "m", projectId: "p" };
    expect(watcherInput({ kind: "deploys", every: "hour" }, "ignored", r, "UTC", "req")).toEqual({
      projectRef: r,
      name: "Deploys",
      prompt: "Deploys",
      schedule: { tz: "UTC" },
      watch: { kind: "deploys", every: "hour" },
      clientRequestId: "req",
    });
    expect(watcherInput({ kind: "other", every: "day" }, "  Is   shop.example up? ", r, "UTC", "req")).toMatchObject({ name: "Is shop.example up?", prompt: "Is shop.example up?" });
    expect(sentenceProblem("other", " ")).toBe("Say in one sentence what to watch.");
    expect(sentenceProblem("main_ci", "")).toBeUndefined();
  });
});
