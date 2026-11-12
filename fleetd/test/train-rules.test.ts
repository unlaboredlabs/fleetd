import { expect, test } from "bun:test";
import type { Change } from "../src/shared/contracts.ts";
import { readVerdict } from "../src/hub/reviews/verdict_input.ts";
import { loopsBackVia, mergeAfter, upstreams } from "../src/hub/train/next_rules.ts";
import { changeNext } from "../src/hub/train/notes.ts";
import { fixYourPr, SHIPPED_PROMPTS } from "../src/hub/train/prompts.ts";
import { fastSet, parse } from "../src/hub/train/settings.ts";

const pr = (n: number) => `https://github.com/acme/shop/pull/${n}`;

test("a Change's after PRs are keyed once, added at the end, and a wait back on the PR itself is found", () => {
  expect(upstreams(["https://github.com/Acme/Shop/pull/2", pr(2), "not a url"])).toEqual([pr(2)]);
  expect(mergeAfter([pr(1)], [pr(1), pr(2)])).toEqual([pr(1), pr(2)]);
  expect(mergeAfter(undefined, [pr(3)])).toEqual([pr(3)]);
  const afterOf = (_repo: string, n: number) => ({ 2: [pr(3)], 3: [pr(1)] })[n as 2 | 3];
  expect(loopsBackVia(pr(1), [pr(2)], afterOf)).toBe(pr(2));
  expect(loopsBackVia(pr(9), [pr(2)], afterOf)).toBeUndefined();
});

test("a repo's train settings read only their two lists, and the fast set adds its own checks to what's required", () => {
  expect(parse('{"fastChecks":["lint"],"afterMerge":["e2e"]}')).toEqual({ fastChecks: ["lint"], afterMerge: ["e2e"] });
  expect(() => parse('{"fastCheck":["lint"]}')).toThrow("unknown field `fastCheck`");
  expect(() => parse('{"fastChecks":["a","a"]}')).toThrow("a is there twice");
  expect(fastSet({ fastChecks: ["lint", "e2e", "ci"], afterMerge: ["e2e"] }, ["ci"])).toEqual(["ci", "lint"]);
});

test("what the lead does next about a Change, and the message that sends a PR back to its author", () => {
  const change = { changeId: "X1", prUrl: pr(1), branch: "b", state: "merged" } as Change;
  expect(changeNext(change)).toBe("nothing; it is merged.");
  expect(changeNext({ ...change, state: "ci_failed", lastError: "CI timed out after 45 min" })).toContain("its CI timed out");
  expect(changeNext({ ...change, state: "refused" })).toBe("fix what it says and enqueue the PR again, or drop it.");
  const text = fixYourPr(SHIPPED_PROMPTS.current(), change, "its CI failed", " lint: 2 errors ");
  expect(text).toContain(`${pr(1)} (X1)`);
  expect(text).toContain("its CI failed");
  expect(text).toContain("lint: 2 errors");
});

test("a review's verdict is checked as the contract says", () => {
  expect(readVerdict({ blocking: 0, nonBlocking: 2, summary: "ok", taskId: "T4" })).toEqual({ blocking: 0, nonBlocking: 2, summary: "ok", taskId: "T4" });
  expect(() => readVerdict({ blocking: -1, nonBlocking: 0, summary: "x" })).toThrow("blocking: expected a count");
  expect(() => readVerdict({ blocking: 0, nonBlocking: 0, summary: "" })).toThrow("summary");
  expect(() => readVerdict({ blocking: 0, nonBlocking: 0, summary: "x", prHeadSha: "ABC" })).toThrow("prHeadSha");
});
