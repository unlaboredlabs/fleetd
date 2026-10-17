import { SERVES_FIX, type Workstream, type WorkstreamId } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { REF } from "../tasks/testKit.ts";
import { pullsPath } from "./PrHeads.ts";
import { type PrVerdict, prKey, reviewRefusal, type SpawnRequest, writeRefusal } from "./rules.ts";

const W1 = "W1" as WorkstreamId;
const workstream = (over: Partial<Workstream> = {}): Workstream => ({
  workstreamId: W1,
  projectRef: REF,
  title: "docs",
  source: { text: "write docs", channel: "app", by: "human", at: "2026-10-17T10:00:00.000Z" },
  state: "running",
  brief: {
    goal: "a docs page",
    why: "people ask",
    pointers: [],
    constraints: [],
    doneWhen: [
      { type: "pr_merged", repo: "wynn-dev/lab" },
      { type: "human", question: "does it read well?" },
    ],
    tier: "S",
  },
  createdAt: "2026-10-17T10:00:00.000Z",
  updatedAt: "2026-10-17T10:00:00.000Z",
  ...over,
} as Workstream);

const write = (serves?: string): SpawnRequest => ({ workstreamId: W1, kind: "write", ...(serves === undefined ? {} : { serves }) });

describe("writeRefusal", () => {
  it.each<[string, SpawnRequest, Workstream, string | undefined]>([
    ["done:0 on a running workstream", write("done:0"), workstream(), undefined],
    ["done:1, the last check", write("done:1"), workstream(), undefined],
    ["an issue ref", write("issue:#12"), workstream(), undefined],
    ["an issue URL", write("issue:https://github.com/wynn-dev/lab/issues/3"), workstream(), undefined],
    ["a defect", write("defect:the digest drops answers"), workstream(), undefined],
    ["an ask", write("ask:A4"), workstream(), undefined],
    ["a verifying workstream (fixing a failed check)", write("done:0"), workstream({ state: "verifying" }), undefined],
    ["no serves", write(), workstream(), "A write task must say what it serves."],
    ["an unknown kind of serves", write("vibes:yes"), workstream(), "--serves vibes:yes is not valid."],
    ["done:2 past the last check", write("done:2"), workstream(), "done:2 is not a done-when check of W1; it has 2 (done:0 to done:1)."],
    ["done:0 on a draft", write("done:0"), workstream({ state: "draft", brief: undefined } as never), "W1 has no brief yet, so done:0 names no done-when check."],
    ["a done workstream", write("done:0"), workstream({ state: "done" }), "W1 is done; open a new intent if there's more to do"],
    ["a done workstream, even without serves", write(), workstream({ state: "done" }), "W1 is done; open a new intent if there's more to do"],
  ])("%s", (_, request, ws, message) => {
    const refusal = writeRefusal(request, ws);
    expect(refusal?.message).toBe(message);
    if (message !== undefined && !message.includes("is done")) expect(refusal?.fix).toBe(SERVES_FIX);
  });

  it("leaves read and review tasks alone", () => {
    expect(writeRefusal({ workstreamId: W1, kind: "read" }, workstream({ state: "done" }))).toBeUndefined();
    expect(writeRefusal({ workstreamId: W1, kind: "review", pr: "https://github.com/o/r/pull/1" }, workstream())).toBeUndefined();
  });
});

const PR = "https://github.com/wynn-dev/lab/pull/7";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const review = (over: Partial<SpawnRequest> = {}): SpawnRequest => ({ workstreamId: W1, kind: "review", pr: PR, ...over });
const v = (taskId: string, sha: string, blocking: number): PrVerdict => ({ taskId, sha, blocking });

describe("reviewRefusal", () => {
  it.each<[string, SpawnRequest, string, string | undefined, ReadonlyArray<PrVerdict>, string | undefined, boolean]>([
    ["a first review", review(), "lead:lab-a/p1", A, [], undefined, false],
    ["a review without a PR", { workstreamId: W1, kind: "review" }, "lead:lab-a/p1", undefined, [], "A review task needs the PR it reviews.", false],
    ["a hub-spawned judge review without a PR", { workstreamId: W1, kind: "review" }, "hub:judge", undefined, [], undefined, false],
    ["re-review after blocking findings on the same head", review(), "lead", A, [v("T1", A, 2)], undefined, false],
    ["review of the head after a clean one", review(), "lead", A, [v("T1", A, 0)], `already reviewed at ${A} with 0 blocking findings`, false],
    ["QA on a head with a clean review", review({ qa: true }), "lead", A, [v("T1", A, 0)], `already reviewed at ${A} with 0 blocking findings`, false],
    ["clean verdict further back on the same head", review(), "lead", A, [v("T2", A, 1), v("T1", A, 0)], `already reviewed at ${A} with 0 blocking findings`, false],
    ["a new head after one clean review", review(), "lead", B, [v("T1", A, 0)], undefined, false],
    ["a new head after clean then blocking", review(), "lead", C, [v("T2", B, 3), v("T1", A, 0)], undefined, false],
    ["a new head after blocking then clean", review(), "lead", C, [v("T2", B, 0), v("T1", A, 2)], undefined, false],
    ["a third review after two clean on different heads", review(), "lead", C, [v("T2", B, 0), v("T1", A, 0)], "polish", true],
    ["a third review when GitHub is unreachable", review(), "lead", undefined, [v("T2", B, 0), v("T1", A, 0)], "polish", true],
    ["two clean verdicts on the same head are not a loop", review(), "lead", undefined, [v("T2", A, 0), v("T1", A, 0)], undefined, false],
  ])("%s", (_, request, by, head, verdicts, message, polish) => {
    const refusal = reviewRefusal(request, by, head, verdicts);
    if (message === "polish") {
      expect(refusal?.message).toBe(
        `${PR} had two clean reviews in a row (${A.slice(0, 12)} by T1, ${B.slice(0, 12)} by T2); a third review is a polish loop.`,
      );
    } else {
      expect(refusal?.message).toBe(message);
    }
    expect(refusal?.polishLoop !== undefined).toBe(polish);
  });

  it("leaves write and read tasks alone", () => {
    expect(reviewRefusal({ workstreamId: W1, kind: "write", serves: "done:0" }, "lead", A, [v("T1", A, 0)])).toBeUndefined();
  });
  it("caps a lead's review rounds at the playbook's maxReviewRounds, counting reviewed heads", () => {
    const twoRounds = [v("T2", B, 1), v("T1", A, 2)];
    const capped = `${PR} has had 2 review rounds, the most its playbook allows.`;
    expect(reviewRefusal(review(), "lead", C, twoRounds, 2)?.message).toBe(capped);
    expect(reviewRefusal(review(), "lead", undefined, twoRounds, 2)?.message).toBe(capped);
    // Another reviewer on a head already in review is the same round.
    expect(reviewRefusal(review(), "lead", B, twoRounds, 2)).toBeUndefined();
    expect(reviewRefusal(review(), "lead", C, twoRounds, 3)).toBeUndefined();
    // The train's review gate is never capped.
    expect(reviewRefusal(review(), "hub:reviews", C, twoRounds, 2)).toBeUndefined();
  });
});

describe("prKey and pullsPath", () => {
  it("gives one key per PR however its URL is written", () => {
    expect(prKey("https://GitHub.com/Wynn-Dev/Lab/pull/7/")).toBe("github.com/wynn-dev/lab/pull/7");
    expect(prKey("https://github.com/wynn-dev/lab/pulls/7?x=1#top")).toBe("github.com/wynn-dev/lab/pull/7");
  });

  it("finds the REST path of a github.com PR only", () => {
    expect(pullsPath("https://github.com/wynn-dev/lab/pull/7")).toBe("repos/wynn-dev/lab/pulls/7");
    expect(pullsPath("https://github.com/wynn-dev/lab/pull/7/files")).toBeUndefined();
    expect(pullsPath("https://gitlab.com/o/r/-/merge_requests/3")).toBeUndefined();
  });
});
