// The tasks area's pure parts (crates/fleetd/src/hub/tasks/{recovery,breaker,base,pr,render,duplicates,resolve,
// ci_wait}.rs tests).
import { describe, expect, test } from "bun:test";
import { line as baseLine, fetchFailedText } from "../src/hub/tasks/base.ts";
import { Breakers, QUIET_MS } from "../src/hub/tasks/breaker.ts";
import { headRead, SETTLE_MS, summary, targetOf } from "../src/hub/tasks/ci_wait.ts";
import { forWriter, judge } from "../src/hub/tasks/duplicates.ts";
import { githubRepo, hostError, onRemote, shortRemote, taskPrUrl } from "../src/hub/tasks/pr.ts";
import { death, decide, queuedReason, refused, settled, waiting, type Action } from "../src/hub/tasks/recovery.ts";
import { branchFor, slugOf, taskDigestLines, taskResultLines } from "../src/hub/tasks/render.ts";
import { resolveProfile } from "../src/hub/tasks/resolve.ts";
import { parseMs } from "../src/hub/store/time.ts";
import type { Task, TaskRecovery, WorkMatch } from "../src/shared/contracts.ts";
import { ToolError } from "../src/shared/errors.ts";

const NOW = 1_792_000_000_000;
const interrupted = (data: Record<string, unknown>) => death("thread.interrupted", data, "devbox", undefined);
const failed = (data: Record<string, unknown>, tool?: string) => death("thread.failed", data, "devbox", tool);
const resume = (a: Action): TaskRecovery => {
  if (a.kind !== "resume") throw new Error(`not resumed: ${JSON.stringify(a)}`);
  return a.recovery;
};
const dueIn = (r: TaskRecovery) => (parseMs(r.nextAt as string) as number) - NOW;

describe("recovery", () => {
  test("a node stop or crash is the node going away", () => {
    for (const [data, cause, text] of [
      [{ endCause: "node_stopping" }, "node_stopping", "the node on devbox stopped"],
      [{ endCause: "node_restarted" }, "node_restarted", "the node on devbox restarted mid-run (a crash, a kill or a power loss)"],
      [{ late: true }, "node_stopping", "the node on devbox went away"],
      [{ error: { class: "process_exited", message: "the node stopped" } }, "node_stopping", "the node on devbox stopped"],
    ] as const) {
      const d = interrupted(data);
      expect([d.kind, d.cause, d.text]).toEqual(["NodeLost", cause, text]);
    }
  });

  test("an OOM-killed and restarted node is the node going away, using none of the budget", () => {
    for (const end of [null, "exited", "failed", "requested"]) {
      const d = failed({ endCause: end, error: { class: "process_exited", message: "the node stopped" } }, "Ran cargo build");
      expect(d.kind).toBe("NodeLost");
      const first = resume(decide(d, undefined, false, NOW, 0, 3));
      expect(dueIn(first)).toBe(30_000);
      const second = resume(decide(d, first, false, NOW, 0, 3));
      expect([second.count, second.nodeLost]).toEqual([0, 2]);
    }
  });

  test("a requested end is not a death", () => {
    for (const data of [{ endCause: "requested", error: { class: "process_exited", message: "stopped" } }, { endCause: "requested", late: true }, {}]) {
      const d = interrupted(data);
      expect(d.kind).toBe("NotDead");
      expect(decide(d, undefined, false, NOW, 0, 3)).toEqual({ kind: "finish" });
    }
  });

  test("a superseded end resumes at once, with no budget", () => {
    const d = interrupted({ endCause: "superseded" });
    expect([d.kind, d.reported, d.cause]).toEqual(["Cut", "superseded", "superseded"]);
    const r = resume(decide(d, undefined, false, NOW, 0.5, 3));
    expect([dueIn(r), r.count]).toEqual([0, 0]);
  });

  test("an exit resumes after a minute, the same exit twice escalates, and a stall's signature is where it is stuck", () => {
    const d = failed({ endCause: "exited", error: { class: "process_exited", message: "killed by signal 9" } }, "Ran cargo test");
    expect(d.signature).toBe("Exited: killed by signal 9 while: Ran cargo test");
    const r = resume(decide(d, undefined, false, NOW, 0.5, 3));
    expect([dueIn(r), r.count, r.streak, r.mode]).toEqual([60_000, 1, 1, "resume"]);
    expect(queuedReason(r)).toBe("recovering: killed by signal 9; resumes at 17:47:40 UTC (1 of 3 recoveries used)");
    expect(decide(d, r, false, NOW, 0.5, 3)).toEqual({ kind: "escalate", why: "it died the same way twice: killed by signal 9" });
    const stall = failed({ reason: "stalled", inTool: true, error: { message: "no output for 31 min" } });
    expect([stall.kind, stall.reported, stall.signature]).toEqual(["Stalled", "stalled", "Stalled: inside a tool"]);
  });

  test("a resumed run that dies within five minutes counts twice, past the max it escalates", () => {
    const d = failed({ error: { class: "network", message: "API unreachable" } });
    const prior: TaskRecovery = { count: 2, max: 3, nodeLost: 0, lastCause: "failed", lastCauseText: "x", streak: 1, resumedAt: new Date(NOW - 60_000).toISOString(), mode: "resume" };
    expect(decide(d, prior, false, NOW, 0, 3)).toEqual({
      kind: "escalate",
      why: "it died again (API unreachable) after 2 automatic recoveries of at most 3",
    });
  });

  test("a full context compacts, then restarts fresh; a refused resume restarts fresh once", () => {
    const full = failed({ endCause: "context_full" });
    const first = resume(decide(full, undefined, false, NOW, 0, 3));
    expect(first.mode).toBe("compact");
    expect(resume(decide(full, first, false, NOW, 0, 3)).mode).toBe("fresh");
    const r = refused("the session can't resume: its conversation is gone");
    const fresh = resume(decide(r, undefined, false, NOW, 0, 3));
    expect([fresh.mode, dueIn(fresh)]).toEqual(["fresh", 0]);
    expect(decide(r, fresh, false, NOW, 0, 3).kind).toBe("escalate");
  });

  test("a node cut-off settles from the node's return, and goes at once once it caught up", () => {
    const r = resume(decide(interrupted({ endCause: "node_stopping" }), undefined, false, NOW, 0, 3));
    const at = parseMs(settled(r, NOW + 60_000, undefined, "T7") as string) as number;
    expect(at).toBeGreaterThanOrEqual(NOW + 90_000);
    expect(at).toBeLessThan(NOW + 100_000);
    expect(settled(r, NOW + 60_000, NOW + 61_000, "T7")).toBe(new Date(NOW + 61_000).toISOString());
    expect(waiting(r, NOW)).toBe(true);
    expect(waiting(r, NOW + 31_000)).toBe(false);
  });
});

describe("breaker", () => {
  test("three different agents dying within ten minutes open it; a quiet spell or a completion closes it", () => {
    const b = new Breakers();
    expect(b.death("m", "T1", 0)).toBeUndefined();
    expect(b.death("m", "T1", 1000)).toBeUndefined();
    expect(b.death("m", "T2", 2000)).toBeUndefined();
    expect(b.death("m", "T3", 3000)).toEqual({ taskIds: ["T1", "T2", "T3"], untilMs: 3000 + QUIET_MS });
    expect(b.hold("m", "T9")).toBe(true);
    expect(b.holds("m", "T9")).toBe(true);
    expect(b.quiet(3000 + QUIET_MS - 1)).toEqual([]);
    expect(b.quiet(3000 + QUIET_MS)).toEqual(["m"]);
    expect(b.close("m")).toEqual(["T9"]);
    expect(b.close("m")).toBeUndefined();
    expect(b.hold("m", "T9")).toBe(false);
  });
});

describe("base and PRs", () => {
  test("a base in words, with why it may be behind", () => {
    const now = "2026-10-24T09:00:00.000Z";
    expect(baseLine({ ref: "origin/main", sha: "abc1234def", fetchedAt: "2026-10-24T07:41:00.000Z" }, now)).toBe(
      "based on origin/main @abc1234 as of 07:41 UTC",
    );
    expect(baseLine({ ref: "origin/main", sha: "abc1234def", fetchedAt: "2026-10-23T18:02:00.000Z" }, now)).toBe(
      "based on origin/main @abc1234 as of 10-23 18:02 UTC",
    );
    expect(baseLine({ ref: "main", sha: "abc1234def", error: { kind: "no_remote", message: "no remote" } }, now)).toBe(
      "based on local main @abc1234 (no remote)",
    );
    const [message, fix] = fetchFailedText("Shop", { ref: "origin/main", sha: "abc1234def", error: { kind: "auth", message: "Permission denied." } }, now);
    expect(message).toBe(
      "git can't fetch origin for Shop: Permission denied. Fix: `gh auth login` or your SSH key. Agents start from origin/main @abc1234; their pushes will fail the same way.",
    );
    expect(fix).toBe("gh auth login");
  });

  test("a writer's PR is the host's; unread, only one on the project's own remote", () => {
    expect(shortRemote("git@github.com:acme/shop.git")).toBe("github.com/acme/shop");
    expect(shortRemote("https://user@github.com/acme/shop/")).toBe("github.com/acme/shop");
    expect(githubRepo("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(githubRepo("gitlab.com/acme/shop")).toBeUndefined();
    expect(onRemote("https://www.github.com/Acme/Shop/pull/3", "github.com/acme/shop")).toBe(true);
    expect(onRemote("https://github.com/acme/shopping/pull/3", "github.com/acme/shop")).toBe(false);
    const texts = ["see https://github.com/acme/shop/pull/1", "fixture https://github.com/other/x/pull/9"];
    expect(taskPrUrl("https://github.com/acme/shop/pull/5", "github.com/acme/shop", texts)).toBe("https://github.com/acme/shop/pull/5");
    expect(taskPrUrl(undefined, "github.com/acme/shop", texts)).toBeUndefined();
    expect(taskPrUrl(new Error("unread"), "github.com/acme/shop", texts)).toBe("https://github.com/acme/shop/pull/1");
    expect(hostError(404, "Not Found").kind).toBe("refused");
    expect(hostError(403, "API rate limit exceeded").kind).toBe("unread");
    expect(hostError(502, "Bad gateway").kind).toBe("unread");
  });
});

describe("render", () => {
  test("a branch is the prefix, the task and its title's words", () => {
    expect(slugOf("Crème brûlée: the ÜBER fix!")).toBe("creme-brulee-the-uber-fix");
    expect(slugOf("?!")).toBe("task");
    expect(slugOf("a".repeat(50))).toBe("a".repeat(40));
    expect(branchFor(undefined, "T12", "Dark mode toggle")).toBe("fleetd/T12-dark-mode-toggle");
  });

  test("an escalated end says it was not resumed", () => {
    const result = { status: "failed" as const, tail: "Not resumed automatically: it died the same way twice.", branch: "fleetd/T23-b", at: "2026-10-25T10:00:00.000Z" };
    expect(taskResultLines("T23", "B: progress bar", result, true)).toBe(
      "- T23 failed and was not resumed: B: progress bar (branch fleetd/T23-b)\n  > Not resumed automatically: it died the same way twice.",
    );
    expect(taskResultLines("T23", "B", result, false).startsWith("- T23 failed: B")).toBe(true);
  });

  test("an ended task's result shows in a first message but not beside its wake line", () => {
    const task = {
      taskId: "T4",
      projectRef: { machineId: "lab-a", projectId: "p1" },
      workstreamId: "W1",
      title: "B",
      kind: "write",
      prompt: "do it",
      state: "done",
      attempt: 1,
      createdAt: "2026-10-25T09:00:00.000Z",
      endedAt: "2026-10-25T10:00:00.000Z",
      result: { status: "done", tail: "Fixed it.", at: "2026-10-25T10:00:00.000Z" },
    } as Task;
    const lines = (since: string | undefined) => taskDigestLines([task], since, "", () => undefined, () => []);
    expect(lines(undefined)[0]?.endsWith("→ Fixed it.")).toBe(true);
    expect(lines("2026-10-25T09:30:00.000Z")[0]?.endsWith(": B")).toBe(true);
    const running = { ...task, taskId: "T5", state: "running", profile: "high", branch: "fleetd/T5-b" } as Task;
    expect(taskDigestLines([running], undefined, "", (m) => (m === task.projectRef.machineId ? "09:10" : undefined), () => [])).toEqual([
      `- T5 running (write, high): B [fleetd/T5-b]; ${task.projectRef.machineId} offline since 09:10 UTC, it resumes when ${task.projectRef.machineId} is back`,
    ]);
  });

  test("a review always runs on the default profile; an unknown one is refused", () => {
    expect(resolveProfile("medium", "review", ["high", "medium"])).toBe("high");
    expect(resolveProfile(undefined, "write", ["high", "medium"])).toBe("high");
    expect(resolveProfile("medium", "write", ["high", "medium"])).toBe("medium");
    expect(() => resolveProfile("max", "read", ["high"])).toThrow("this project doesn't allow profile max; it allows high");
  });
});

describe("duplicates", () => {
  const match = (id: string, strength: WorkMatch["strength"], extra: Partial<WorkMatch["item"]> = {}): WorkMatch => ({
    item: { id, title: "dark mode", kind: "task", keys: [], paths: [], since: "2026-10-17T10:00:00.000Z", state: "running", projectRef: { machineId: "lab-a", projectId: "shop" }, ...extra },
    strength,
    why: "3 shared words",
  });
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof ToolError ? e.message : String(e);
    }
    return "passed";
  };

  test("exact and strong matches are refused until named; a person's claim never passes; weak ones are listed", () => {
    expect(refusal(() => judge([match("T3", "strong")], undefined, new Set()))).toBe(
      'Possible duplicate: T3 "dark mode" (running, project shop): 3 shared words.',
    );
    expect(judge([match("T3", "strong")], ["T3"], new Set())).toEqual({ elsewhere: ['T3 "dark mode" (running, project shop): 3 shared words'], overridden: ["T3"] });
    expect(refusal(() => judge([match("T3", "exact")], undefined, new Set(["T3"])))).toBe('Taken: T3 "dark mode" (running, project shop): 3 shared words.');
    const human = match("C1", "exact", { kind: "claim", owner: { kind: "human_session", keyId: "k", label: "laptop" } });
    expect(refusal(() => judge([human], ["C1"], new Set()))).toBe(
      'Taken by a person: C1 "dark mode" (running, a person\'s session, laptop): 3 shared words. A person\'s claim can\'t be passed over with notDuplicateOf.',
    );
    expect(judge([match("T3", "weak", { taskId: "T3" })], undefined, new Set(["T3"])).elsewhere).toEqual([
      'T3 "dark mode" (running, project shop, changes unknown): 3 shared words',
    ]);
    expect(forWriter([match("T3", "weak", { taskId: "T3" }), match("T4", "weak", { taskId: "T4" })], "T3")).toEqual([
      'T4 "dark mode" (running, project shop): 3 shared words',
    ]);
  });
});

describe("ci waits", () => {
  test("a run or a PR URL, and what each line says", () => {
    expect(targetOf("https://github.com/acme/shop/actions/runs/42/job/7")).toEqual({ kind: "run", repo: "acme/shop", id: 42 });
    expect(targetOf("https://github.com/acme/shop/actions/runs/0")).toBeUndefined();
    expect(targetOf("https://gitlab.com/acme/shop/pull/3")).toBeUndefined();
    const run = { kind: "run" as const, repo: "acme/shop", id: 42 };
    expect(summary(run, { kind: "finished", conclusion: "success", label: "ci", failing: [], total: 4 })).toBe(
      "CI you waited on (wait_ci) finished: https://github.com/acme/shop/actions/runs/42 (ci) succeeded: all 4 jobs passed.",
    );
    expect(summary({ kind: "pr", repo: "acme/shop", number: 3 }, { kind: "over", why: "was merged" })).toBe(
      "CI you waited on (wait_ci) finished: https://github.com/acme/shop/pull/3 was merged.",
    );
  });

  test("a PR head is finished only once every check completed a while ago", () => {
    const checks = [{ name: "a", status: "completed", conclusion: "success", completedMs: 1000 }];
    expect(headRead("abcdef12", [], checks, 1000 + SETTLE_MS - 1)).toEqual({ kind: "running" });
    expect(headRead("abcdef12", ["in_progress"], checks, 1000 + SETTLE_MS)).toEqual({ kind: "running" });
    expect(headRead("abcdef12", ["completed"], [...checks, { name: "b", status: "completed", conclusion: "failure", completedMs: 900 }], 1000 + SETTLE_MS)).toEqual({
      kind: "finished",
      label: "abcdef1",
      failing: ["b"],
      total: 2,
    });
  });
});
