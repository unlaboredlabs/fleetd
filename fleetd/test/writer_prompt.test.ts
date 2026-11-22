// The writer's contract for a PR: one reviewable concern, larger work as a stack, and a description that proves it,
// scaled to the change, ending with an `Unsure:` line the train's reviewer gets and judges.
import { expect, test } from "bun:test";
import { PromptSet } from "../src/hub/prompts/set.ts";
import { reviewPrompt, UNSURE_MAX, unsureLine } from "../src/hub/reviews/rules.ts";
import type { Change } from "../src/shared/contracts.ts";

const set = PromptSet.defaults();
const brief = set.render("task.brief.write", { branch: "fleetd/T7-search", baseBranch: "main" });

test("a writer keeps each PR to one concern and sends larger work as a stack, each PR based on the branch below", () => {
  expect(brief).toContain("Keep each PR to one concern a person can review in one sitting.");
  expect(brief).toContain("on branches named fleetd/T7-search-<n>");
  expect(brief).toContain("each branch on the one before and its PR based on that branch (`gh pr create --base <the branch below>`)");
  expect(brief).toContain("lands a stack bottom up, and points each PR at main once the one below it lands");
  // A stacked PR rebases onto the branch below it while that one is open, never onto a batch branch.
  expect(brief).toContain("only onto origin/main, or a stacked PR onto the branch below it while that one is open (never a train batch branch");
});

test("a writer's PR proves itself, scaled to the change, with no proof for a docs or one-line fix", () => {
  const proof = brief.split("\n").find((l) => l.startsWith("- Each PR's description proves it"));
  expect(proof).toBeDefined();
  for (const scaled of [
    "for UI, screenshots or a short clip of the real app",
    "for performance, the numbers before and after and how they were measured",
    "for a bug fix, the test that failed before the fix and passes with it",
    "for any code change, the tests you ran and how they ended",
    "A docs fix or a one-line change needs none of that.",
    "End the description with one line `Unsure: <what you weren't sure about>`",
    "the train's reviewer gets that line and judges it",
  ])
    expect(proof).toContain(scaled);
});

test("the `Unsure:` line is read from the description: its last one, labelled in any markdown, on one capped line", () => {
  expect(unsureLine("Adds search.\n\nUnsure: whether the index rebuild holds a write lock")).toBe("whether the index rebuild holds a write lock");
  expect(unsureLine("- **Unsure:** the retry   count\nmore")).toBe("the retry count");
  expect(unsureLine("**Unsure**: the cache key")).toBe("the cache key");
  expect(unsureLine("unsure: first\nUnsure: second")).toBe("second");
  expect(unsureLine('Unsure: the "quoted" part')).toBe("the 'quoted' part");
  expect([...unsureLine(`Unsure: ${"x ".repeat(UNSURE_MAX)}`)!].length).toBe(UNSURE_MAX);
  // None, or one that names no doubt: nothing to judge.
  for (const body of ["Adds search.", "Unsure: nothing", "Unsure: None.", "Unsure:", "", null, undefined]) expect(unsureLine(body)).toBeUndefined();
  // Not a label: a word in a sentence.
  expect(unsureLine("I was unsure: about it, mid-sentence")).toBeUndefined();
});

const vars = { prUrl: "https://github.com/acme/storefront/pull/7", repo: "acme/storefront", prNumber: 7, headSha: "b".repeat(40) };
const change = vars as Change;

test("the train's reviewer gets the author's `Unsure:` line to judge, after its own prompt and before what changed", () => {
  const body = "Adds search.\n\nUnsure: whether the index rebuild holds a write lock";
  const fresh = reviewPrompt(set, change, undefined, body);
  expect(fresh.startsWith(set.render("review.reviewer", vars))).toBe(true);
  expect(fresh).toContain('the one part of the PR description you get: "whether the index rebuild holds a write lock"');
  expect(fresh).toContain("say in your summary whether the doubt is founded");
  const again = reviewPrompt(set, change, "a".repeat(40), body);
  expect(again.indexOf("whether the index rebuild")).toBeLessThan(again.indexOf(set.render("review.delta", { reviewedSha: "a".repeat(40), headSha: change.headSha })));
  // No line, or no doubt: the reviewer's prompt as it was.
  expect(reviewPrompt(set, change, undefined, "Unsure: nothing")).toBe(set.render("review.reviewer", vars));
  expect(reviewPrompt(set, change, undefined, undefined)).not.toContain("weren't sure");
});
