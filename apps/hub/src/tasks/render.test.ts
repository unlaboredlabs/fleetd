import type { Brief, Task, TaskId, WorkstreamId } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { branchFor, findPrUrl, renderTaskPrompt, slugOf, tailOf, taskDigestLines, taskResultLines } from "./render.ts";
import { resolveModelEffort } from "./resolve.ts";
import { REF } from "./testKit.ts";

const brief: Brief = {
  goal: "a docs page",
  why: "people ask",
  pointers: [],
  constraints: [],
  doneWhen: [{ type: "pr_merged", repo: "wynn-dev/lab" }, { type: "human", question: "does it read well?" }],
  tier: "S",
} as Brief;

const task = (n: number, over: Partial<Task> = {}): Task =>
  ({
    taskId: `T${n}` as TaskId,
    projectRef: REF,
    workstreamId: "W1" as WorkstreamId,
    title: `task ${n}`,
    kind: "write",
    prompt: "do it",
    areas: ["docs"],
    model: "claude-opus-5-5",
    effort: "high",
    state: "running",
    attempt: 1,
    createdAt: "2026-10-17T10:00:00.000Z",
    ...over,
  }) as Task;

describe("renderTaskPrompt", () => {
  it("wraps a writer's text with the brief, its areas, its branch and the result rule", () => {
    const text = renderTaskPrompt({
      task: task(1, { title: "add file", prompt: "  create docs/x.md with one line 'hi'  ", areas: ["docs", "site"] as never, serves: "done-when 1" }),
      projectTitle: "Demo",
      brief,
      areaGlobs: { docs: ["docs/**"], site: ["site/**", "public/*.html"] },
      branch: "fleetd/T1-add-file",
      baseBranch: "main",
    });
    expect(text).toBe(
      [
        "You are fleetd task T1 (write) for workstream W1 in project Demo: add file",
        "",
        "## Task",
        "create docs/x.md with one line 'hi'",
        "",
        "## Workstream",
        "Goal: a docs page",
        "Done when: done:0 PR merged in wynn-dev/lab; done:1 human confirms: does it read well?",
        "This task serves: done-when 1",
        "",
        "## Rules",
        "- Only change files in these areas: docs (docs/**); site (site/**, public/*.html). Changes anywhere else are flagged as out of area.",
        "- You work in your own worktree on branch fleetd/T1-add-file. Commit to your branch; do not merge; do not push to the default branch (main).",
        "- If the repo's origin is on GitHub: when your commits are done, `git push -u origin fleetd/T1-add-file` and open a pull request with `gh pr create --base main --head fleetd/T1-add-file` whose body has the line `Source: done-when 1`, and put its URL in your result. Never merge it and never post a `fleetd/train` commit status: fleetd's merge train merges it. Without a GitHub origin, just commit.",
        "- Do the task yourself; do not hand it to subagents.",
        "- End with a one-paragraph result: what you did, what is left, and anything the lead must decide.",
      ].join("\n"),
    );
  });

  it("tells readers not to change files and leaves out a missing brief", () => {
    const text = renderTaskPrompt({ task: task(2, { kind: "review", areas: [] }), projectTitle: "Demo", areaGlobs: {} });
    expect(text).not.toContain("## Workstream");
    expect(text).not.toContain("branch");
    expect(text).toContain("- This is a read-only task: do not change, commit or push any files.");
    expect(text).toContain("- End with a one-paragraph result");
  });
});

describe("branch names", () => {
  it("slugs the title into fleetd/<taskId>-<slug>", () => {
    expect(branchFor("T1" as TaskId, "add file")).toBe("fleetd/T1-add-file");
    expect(slugOf("Fix: the /healthz route (again!)")).toBe("fix-the-healthz-route-again");
    expect(slugOf("Crème brûlée")).toBe("creme-brulee");
    expect(slugOf("!!!")).toBe("task");
    expect(slugOf("one two three four five six seven eight nine ten")).toBe("one-two-three-four-five-six-seven-eight");
    expect(slugOf("x".repeat(60))).toBe("x".repeat(40));
  });
});

describe("result text", () => {
  it("keeps the last 2000 characters of the tail", () => {
    const long = `${"a".repeat(3000)}END`;
    const t = tailOf(long);
    expect(t).toHaveLength(2000);
    expect(t.startsWith("…")).toBe(true);
    expect(t.endsWith("aEND")).toBe(true);
    expect(tailOf("  short  ")).toBe("short");
  });

  it("finds the last PR URL", () => {
    expect(findPrUrl(["opened https://github.com/o/r/pull/3.", undefined, "then (https://github.com/o/r/pull/12)"])).toBe("https://github.com/o/r/pull/12");
    expect(findPrUrl(["https://gitlab.com/g/p/-/merge_requests/4"])).toBe("https://gitlab.com/g/p/-/merge_requests/4");
    expect(findPrUrl(["see https://github.com/o/r/issues/3", "no url"])).toBeUndefined();
  });

  it("renders a finished task for the wake with its tail quoted and the next step", () => {
    expect(
      taskResultLines({
        taskId: "T4" as TaskId,
        title: "fix it",
        result: { status: "failed", tail: "tried\n\n[provider] exit 1", at: "2026-10-17T10:00:00.000Z" },
      }),
    ).toBe(
      [
        "- T4 failed: fix it",
        "  result:",
        "  > tried",
        "  >",
        "  > [provider] exit 1",
        '  next: judge the result; `fleetd task message T4 "<text>"` continues the same thread.',
      ].join("\n"),
    );
    expect(taskResultLines({ taskId: "T5" as TaskId, title: "x", result: { status: "cancelled", tail: "", at: "2026-10-17T10:00:00.000Z" } })).toContain(
      "- T5 was cancelled: x\n  result:\n  > (no final message)\n  next: nothing",
    );
  });
});

describe("taskDigestLines", () => {
  it("lists running and idle tasks, then queued ones with reasons, then those ended since the last wake", () => {
    const lines = taskDigestLines(
      [
        task(6, { state: "done", endedAt: "2026-10-17T09:00:00.000Z", result: { status: "done", tail: "old", at: "2026-10-17T09:00:00.000Z" } }),
        task(5, { state: "failed", endedAt: "2026-10-17T11:00:00.000Z", result: { status: "failed", tail: "…boom\nmore", at: "2026-10-17T11:00:00.000Z" } }),
        task(4, { state: "queued", queuedReason: "lease: docs held by T1" }),
        task(3, { state: "idle" }),
        task(2, { kind: "read", model: "claude-haiku-5-5", effort: "low" }),
        task(1, { branch: "fleetd/T1-task-1" }),
      ],
      "2026-10-17T10:00:00.000Z",
    );
    expect(lines).toEqual([
      "- T3 idle, waiting for input (write, claude-opus-5-5/high): task 3",
      "- T2 running (read, claude-haiku-5-5/low): task 2",
      "- T1 running (write, claude-opus-5-5/high): task 1 [fleetd/T1-task-1]",
      "- T4 queued (write): task 4; lease: docs held by T1",
      "- T5 failed since your last wake: task 5 → boom more",
    ]);
  });
});

describe("resolveModelEffort", () => {
  it("takes each of model and effort from the flag, then the policy, then the project", () => {
    expect(resolveModelEffort({ flag: {} })).toEqual({ model: "claude-opus-5-5", effort: "high" });
    expect(resolveModelEffort({ flag: { effort: "max" }, policy: { model: "claude-sonnet-5-5" }, project: { model: "m", effort: "low" } })).toEqual({
      model: "claude-sonnet-5-5",
      effort: "max",
    });
    expect(resolveModelEffort({ flag: {}, policy: {}, project: { effort: "low" } })).toEqual({ model: "claude-opus-5-5", effort: "low" });
  });

  it("gives medium only when something says medium", () => {
    expect(resolveModelEffort({ flag: { model: "claude-haiku-5-5" }, policy: {}, project: {} }).effort).toBe("high");
    expect(resolveModelEffort({ flag: {}, project: { effort: "medium" } }).effort).toBe("medium");
  });
});
