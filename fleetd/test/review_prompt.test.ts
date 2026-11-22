// The reviewer's blocking bar, as the shipped prompts and the report tool state it: block only on a defect reachable
// today (its trigger and what breaks) or a miss against the brief; hypotheticals are non-blocking notes.
import { expect, test } from "bun:test";
import { SNAPSHOT } from "../src/cli/agent_mcp/tools.ts";
import { ENTRIES } from "../src/hub/prompts/registry.ts";
import { warnings } from "../src/hub/prompts/render.ts";
import { reviewPrompt } from "../src/hub/reviews/rules.ts";
import { SHIPPED_PROMPTS } from "../src/hub/train/prompts.ts";
import type { Change } from "../src/shared/contracts.ts";

const change = {
  prUrl: "https://github.com/acme/shop/pull/42",
  repo: "acme/shop",
  prNumber: 42,
  headSha: "b".repeat(40),
} as unknown as Change;

test("the train's reviewer judges intent first and blocks only on a reachable defect or a brief miss", () => {
  const text = reviewPrompt(SHIPPED_PROMPTS.current(), change, undefined, undefined);
  for (const line of [
    "Judge intent first",
    "Blocking is only a defect reachable on this head or a miss against the goal and done-when",
    "names the input or state that triggers it today and what then breaks",
    "A security hole, data loss or a secret shown is blocking whenever it is reachable.",
    "hardening against inputs nothing sends today, speculative edge cases",
    "If you can't name what triggers it today, it is non-blocking.",
    "one that names no trigger reachable today is non-blocking",
    "each blocking one with its trigger and what breaks",
  ]) {
    expect(text).toContain(line);
  }
  // The old tie-break that turned every doubt into a block is gone.
  expect(text).not.toContain("when unsure whether people would hit it, it is blocking");
  // A re-review keeps the same bar.
  const again = reviewPrompt(SHIPPED_PROMPTS.current(), change, "a".repeat(40), undefined);
  expect(again).toContain("blocking only for a defect reachable on this head, named with its trigger and what breaks, or a miss against the brief");
});

test("a lead's review task gets the same bar, and an edit that drops it is warned about", () => {
  const brief = SHIPPED_PROMPTS.current().render("task.brief.review", {
    taskId: "T7",
    kind: "review",
    workstreamId: "W3",
    project: "Shop",
    title: "Review #42",
    task: "Review it.",
    workstream: "",
    workspace: "Work in your worktree.",
  });
  expect(brief).toContain("named with the input or state that triggers it and what breaks");
  expect(brief).toContain("A security hole, data loss or a secret shown is blocking whenever it is reachable.");
  expect(brief).not.toContain("rare edge cases");
  for (const id of ["review.reviewer", "task.brief.review"]) {
    const entry = ENTRIES.find((e) => e.id === id)!;
    const rule = entry.rules.find((r) => r.id === "reachable-blocking")!;
    expect(entry.default).toMatch(new RegExp(rule.needle, "iu"));
    const edited = entry.default.replace(/input or state that triggers it/g, "case");
    expect(warnings(entry, edited).map((w) => w.rule)).toContain("reachable-blocking");
  }
});

test("the report tool tells a reviewer what counts as blocking", () => {
  const report = SNAPSHOT.tools.find((t) => t.name === "report")!;
  expect(report.description).toContain("A finding is blocking only when it names what triggers it today and what breaks, or a miss against the brief");
});
